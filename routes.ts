/**
 * HTTP routes for dsh-wordcraft — four surfaces, all same-origin with the web
 * GUI (the bridge iframe must be same-origin for a frictionless postMessage
 * channel, so the editor assets MUST be served by this host, not a CDN):
 *
 * - GET /api/dsh-wordcraft/app.html + /app.js — the bridge page the panel
 *   hosts in an iframe (committed source under app/). It boots the SuperDoc
 *   editor and speaks the `wordcraft:*` postMessage protocol.
 * - GET /api/dsh-wordcraft/vendor/* — the SuperDoc web build from static/
 *   (fetched by scripts/fetch-wordcraft.mjs). Content-hashed names get an
 *   immutable cache header; everything else revalidates.
 * - POST /api/dsh-wordcraft/save — bytes produced by the editor's save flow
 *   (the `wordcraft:save` postMessage payload) written back into the owning
 *   Session's workspace. The client sends `sessionId` and the
 *   workspace-relative `path`; the Host resolves the real workspace root from
 *   the live Session header and containment-checks the resolved target, so a
 *   forged request cannot escape the workspace. Writes are atomic (tmp +
 *   rename).
 * - GET /api/dsh-wordcraft/resolve — turns deliverables file-card coordinates
 *   (sessionId/seq/index) into the declared file's path, the missing half of
 *   the deliverables.file.actions slot whose owner props carry only the
 *   authenticated actionUrl.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ApiResponse } from './types.js'

/** Bridge page paths (exact routes). */
export const WC_APP_HTML_PATH = '/api/dsh-wordcraft/app.html'
export const WC_APP_JS_PATH = '/api/dsh-wordcraft/app.js'
/** Vendor build base path (prefix route). */
export const WC_VENDOR_BASE = '/api/dsh-wordcraft/vendor'
/** Save endpoint path (exact route). */
export const WC_SAVE_PATH = '/api/dsh-wordcraft/save'
/** Presented-file resolve endpoint path (exact route). */
export const WC_RESOLVE_PATH = '/api/dsh-wordcraft/resolve'
/** Hard cap on one save request body (docx files sit far under this). */
export const MAX_SAVE_BYTES = 64 * 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

export interface WcRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** The sessions face routes.ts needs (mirrors the ambient dsh-host.d.ts). */
export interface SessionsLookup {
  get(sessionId: string): { header?: { cwd?: string } } | undefined
}

function sendJson(res: ServerResponse, status: number, data: ApiResponse): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/**
 * Resolve the workspace root for a Session via the live header (cold Sessions
 * resolve on the Client side before they are offered here, mirroring how
 * workspaceFiles handles reads: live header, no Agent activation).
 */
function resolveWorkspaceRoot(sessions: SessionsLookup, sessionId: string): string | undefined {
  if (!sessionId || typeof sessionId !== 'string') return undefined
  const header = sessions.get(sessionId)?.header
  const cwd = header?.cwd
  return cwd && cwd !== '' ? cwd : undefined
}

/**
 * Workspace-relative path (posix separators) → absolute path inside `root`,
 * or `undefined` when the value escapes containment or is not a plain
 * relative path. Rejects absolute paths, drive letters, NUL and `..`.
 */
export function resolveInsideWorkspace(root: string, relative: string): string | undefined {
  if (typeof relative !== 'string' || relative === '') return undefined
  if (relative.includes('\0')) return undefined
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return undefined
  const normalized = path.posix.normalize(relative.replace(/\\/g, '/'))
  if (normalized === '' || normalized === '.' || normalized.startsWith('../') || normalized === '..') return undefined
  const absolute = path.resolve(root, ...normalized.split('/'))
  const rootResolved = path.resolve(root)
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) return undefined
  return absolute
}

/** Read the full request body as a Buffer, refusing bodies over the cap. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        rejectPromise(new Error(`body exceeds ${maxBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', rejectPromise)
  })
}

/** Atomic binary write: temp file in the target directory, then rename over. */
async function atomicWrite(target: string, bytes: Buffer): Promise<void> {
  await fsPromises.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.dsh-wordcraft-${randomBytes(6).toString('hex')}.tmp`
  try {
    await fsPromises.writeFile(tmp, bytes)
    renameSync(tmp, target)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
}

/**
 * Serve one committed bridge-page source file from `appDir` (app.html /
 * app.js). Always revalidates: the files are plugin source, not hashed
 * assets, so an upgrade must pick up the new bytes immediately.
 */
function createAppSourceRoute(options: { urlPath: string, fileName: string, appDir: string, mime: string }): WcRoute {
  const { urlPath, fileName, appDir, mime } = options
  return {
    kind: 'exact',
    path: urlPath,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { success: false, error: 'method not allowed' })
        return
      }
      const target = resolveInsideWorkspace(appDir, fileName)
      if (target === undefined || !existsSync(target) || !statSync(target).isFile()) {
        sendJson(res, 404, { success: false, error: 'not found' })
        return
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
        'Content-Length': statSync(target).size,
      })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(target).pipe(res)
    },
  }
}

/**
 * Serve the SuperDoc vendor build from `staticDir` under /vendor/*. Path
 * containment mirrors the workspace save route; immutable caching is safe
 * because the fetch script rewrites the whole directory on version bumps.
 */
function createVendorRoute(options: { staticDir: string }): WcRoute {
  const { staticDir } = options
  return {
    kind: 'prefix',
    path: WC_VENDOR_BASE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { success: false, error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      let relative = url.pathname.slice(WC_VENDOR_BASE.length)
      if (relative === '' || relative === '/') relative = '/index.html'
      const decoded = decodeURIComponent(relative).replace(/\\/g, '/')
      const target = resolveInsideWorkspace(staticDir, decoded.replace(/^\//, ''))
      if (target === undefined) {
        sendJson(res, 400, { success: false, error: 'bad vendor path' })
        return
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        sendJson(res, 404, { success: false, error: 'not found' })
        return
      }
      const ext = path.extname(target).toLowerCase()
      // The vendor files are fetched per fixed version; cache them hard, the
      // fetch script's --force bump is the invalidation path.
      const cache = 'public, max-age=31536000, immutable'
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': cache,
        'Content-Length': statSync(target).size,
      })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(target).pipe(res)
    },
  }
}

/** The sessionQuery face the resolve route needs (mirrors the ambient dsh-host.d.ts). */
export interface SessionQueryFace {
  readEvent(query: {
    sessionId: string
    seq: number
    before: number
    after: number
  }, signal?: AbortSignal): Promise<{
    target: { type: string, data?: unknown }
    session?: { cwd?: string }
  }>
}

/** Numeric query coordinate (`/^\d+$/`, safe integer) or `undefined`. */
function coordinate(value: string | null): number | undefined {
  return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

/**
 * Create the presented-file resolve route: `GET /api/dsh-wordcraft/resolve
 * ?sessionId=&seq=&index=` reads the `deliverables/presented` event at the
 * given Session coordinates and returns the declared file's (path, name).
 */
export function createResolveRoute(options: { sessionQuery: SessionQueryFace }): WcRoute {
  const { sessionQuery } = options
  return {
    kind: 'exact',
    path: WC_RESOLVE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'method not allowed' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const seq = coordinate(url.searchParams.get('seq'))
      const index = coordinate(url.searchParams.get('index'))
      if (sessionId === '' || seq === undefined || index === undefined) {
        sendJson(res, 400, { success: false, error: 'invalid presented file coordinates' })
        return
      }
      try {
        const read = await sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 })
        const data = read.target?.type === 'deliverables/presented'
          ? read.target?.data as { files?: unknown } | undefined
          : undefined
        const file = data !== undefined && Array.isArray(data.files) ? data.files[index] : undefined
        const filePath = typeof (file as { path?: unknown } | undefined)?.path === 'string'
          ? (file as { path: string }).path
          : ''
        if (filePath === '') {
          sendJson(res, 404, { success: false, error: 'presented file not found' })
          return
        }
        const name = filePath.split(/[\\/]/).pop() ?? filePath
        sendJson(res, 200, { success: true, data: { sessionId, path: filePath, name } })
      } catch (error) {
        const message = (error as Error)?.message ?? 'resolve failed'
        sendJson(res, 502, { success: false, error: message })
      }
    },
  }
}

/** Create the plugin's routes: bridge page + vendor build + workspace save. */
export function createWordcraftRoutes(options: {
  appDir: string
  staticDir: string
  sessions: SessionsLookup
}): WcRoute[] {
  const { appDir, staticDir, sessions } = options

  return [
    // ── committed bridge page (the panel's iframe document) ──
    createAppSourceRoute({
      urlPath: WC_APP_HTML_PATH,
      fileName: 'app.html',
      appDir,
      mime: 'text/html; charset=utf-8',
    }),
    createAppSourceRoute({
      urlPath: WC_APP_JS_PATH,
      fileName: 'app.js',
      appDir,
      mime: 'text/javascript; charset=utf-8',
    }),

    // ── SuperDoc vendor build ──
    createVendorRoute({ staticDir }),

    // ── /api/dsh-wordcraft/save — bytes from the wordcraft:save bridge ──
    {
      kind: 'exact',
      path: WC_SAVE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { success: false, error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const relative = url.searchParams.get('path') ?? ''

        const root = resolveWorkspaceRoot(sessions, sessionId)
        if (root === undefined) {
          sendJson(res, 404, { success: false, error: 'unknown session or session without workspace' })
          return
        }
        const target = resolveInsideWorkspace(root, relative)
        if (target === undefined) {
          sendJson(res, 400, { success: false, error: 'path must stay inside the session workspace' })
          return
        }

        try {
          const bytes = await readBody(req, MAX_SAVE_BYTES)
          if (bytes.length === 0) {
            sendJson(res, 400, { success: false, error: 'empty body' })
            return
          }
          await atomicWrite(target, bytes)
          sendJson(res, 200, { success: true, data: { path: relative, bytes: bytes.length } })
        } catch (error) {
          const message = (error as Error)?.message ?? String(error)
          const status = message.includes('body exceeds') ? 413 : 500
          sendJson(res, status, { success: false, error: message })
        }
      },
    },
  ]
}
