/**
 * Remote/API access for the WordCraft panel. All host contact goes through
 * the injected cordis client context (`ctx.remote.workspaceFiles` for reads,
 * the plugin's own HTTP route for writes — workspaceFiles exposes no
 * mutation operation by design).
 */

export const WC_APP_HTML_PATH = '/api/dsh-wordcraft/app.html'
export const WC_SAVE_PATH = '/api/dsh-wordcraft/save'

/** Document extensions the file scan collects (SuperDoc edits .docx). */
export const DOCUMENT_EXTS = new Set(['.docx'])

/** One openable workspace file. */
export interface WorkspaceFileEntry {
  /** Workspace-relative posix path. */
  path: string
  name: string
  size?: number
}

/** Wire result wrapper (typert RemoteResult). */
export type RemoteResult<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly error: { code?: string, message?: string } }

/** The remote namespace subset this plugin uses (any-typed like the kanban client). */
export interface ClientRemote {
  workspaceFiles: {
    list(sessionId: string, path: string, signal?: AbortSignal): Promise<RemoteResult<{
      path: string
      entries: ReadonlyArray<{ name: string, type: 'file' | 'directory' | 'other', size?: number }>
      truncated: boolean
    }>>
    readBytes(sessionId: string, path: string, options: Record<string, never>, signal?: AbortSignal): Promise<RemoteResult<{
      data: Uint8Array
      absolutePath?: string
      version?: unknown
    }>>
  }
  session: {
    openWorkspacePath(request: { path: string, action?: 'reveal' }, signal?: AbortSignal): Promise<RemoteResult<{ opened: true }>>
  }
}

/** Unwrap a RemoteResult: value on success, typed error message on failure. */
export function unwrapRemote<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  const code = result.error?.code ?? ''
  const message = result.error?.message ?? 'remote failure'
  const error = new Error(code !== '' ? `${code}: ${message}` : message) as Error & { code?: string }
  error.code = code
  throw error
}

/** Walk the workspace for .docx files (bounded BFS; hidden dirs skipped). */
export async function listDocuments(
  remote: ClientRemote,
  sessionId: string,
  signal?: AbortSignal,
  options?: { maxDepth?: number, maxFiles?: number },
): Promise<{ files: WorkspaceFileEntry[], truncated: boolean }> {
  const maxDepth = options?.maxDepth ?? 4
  const maxFiles = options?.maxFiles ?? 500
  const files: WorkspaceFileEntry[] = []
  let truncated = false
  // The wire rejects an empty path; '.' addresses the workspace root itself.
  const queue: Array<{ dir: string, depth: number }> = [{ dir: '.', depth: 0 }]

  while (queue.length > 0 && files.length < maxFiles) {
    const { dir, depth } = queue.shift()!
    let listing
    try {
      listing = unwrapRemote(await remote.workspaceFiles.list(sessionId, dir, signal))
    } catch (error) {
      if (signal?.aborted) throw error
      // A missing/unreadable subdirectory shouldn't kill the whole scan.
      if (dir === '.') throw error
      continue
    }
    // Root ('.') children are workspace-relative top-level names.
    const base = dir === '.' ? '' : dir
    if (listing.truncated) truncated = true
    for (const entry of listing.entries) {
      const entryPath = base === '' ? entry.name : `${base}/${entry.name}`
      if (entry.type === 'directory') {
        if (depth >= maxDepth) { truncated = true; continue }
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        queue.push({ dir: entryPath, depth: depth + 1 })
        continue
      }
      if (entry.type !== 'file') continue
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0) continue
      if (!DOCUMENT_EXTS.has(entry.name.slice(dot).toLowerCase())) continue
      files.push({ path: entryPath, name: entry.name, ...(entry.size !== undefined ? { size: entry.size } : {}) })
      if (files.length >= maxFiles) { truncated = true; break }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, truncated }
}

function authToken(): string {
  try { return localStorage.getItem('dsh-auth-token') || '' } catch { return '' }
}

/** Write bytes into the session workspace through the plugin's save route. */
export async function saveToWorkspace(
  sessionId: string,
  path: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ path: string, bytes: number }> {
  const query = new URLSearchParams({ sessionId, path })
  const response = await fetch(`${WC_SAVE_PATH}?${query}`, {
    method: 'POST',
    body: bytes as unknown as BodyInit,
    signal,
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(authToken() !== '' ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
  })
  let body: { success?: boolean, error?: string, data?: { path: string, bytes: number } }
  try { body = await response.json() } catch { body = {} }
  if (!response.ok || !body.success || !body.data) {
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }
  return body.data
}

/** Build the iframe URL: the bridge page boots SuperDoc itself. */
export function appUrl(): string {
  return WC_APP_HTML_PATH
}

export function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '' : path.slice(0, index)
}

export function extname(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/** Format a byte count for the toolbar notice. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
