/**
 * postMessage bridge to the embedded WordCraft bridge page
 * (/api/dsh-wordcraft/app.html, hosted in a same-origin iframe).
 *
 * Wire shapes (app/app.js):
 * - child → parent: {type:'wordcraft:ready', version}
 *                   {type:'wordcraft:save', bytes}
 *                   {type:'wordcraft:dirty', dirty}
 *                   {type:'wordcraft:failed', error}
 * - parent → child: {type:'wordcraft:open', name, bytes}
 *                   {type:'wordcraft:save-request'}
 *
 * Both sides guard on origin + source; the page only talks to its same-origin
 * parent, and the panel only accepts events whose source is the iframe's
 * contentWindow.
 */

export interface WordcraftSaveMessage {
  type: 'wordcraft:save'
  bytes: ArrayBuffer
}

export type WordcraftInbound =
  | { type: 'wordcraft:ready', version: string }
  | WordcraftSaveMessage
  | { type: 'wordcraft:dirty', dirty: boolean }
  | { type: 'wordcraft:failed', error: string }

export function isInbound(data: unknown): data is WordcraftInbound {
  return typeof data === 'object' && data !== null
    && typeof (data as { type?: unknown }).type === 'string'
    && String((data as { type: string }).type).startsWith('wordcraft:')
}

/** Send a document to the iframe (bytes are copied, never aliased). */
export function sendOpen(win: Window | null, _name: string, bytes: Uint8Array): void {
  if (win === null) return
  // Copy into a plain ArrayBuffer so detach/transfer semantics can never
  // alias the remote's buffer. The name rides along for future use; SuperDoc
  // v2 takes the bytes directly and the panel renders the file name itself.
  const copy = bytes.slice().buffer
  win.postMessage({ type: 'wordcraft:open', name: _name, bytes: copy }, window.location.origin)
}

/** Ask the page to produce the current .docx bytes (Save button / Ctrl+S). */
export function sendSaveRequest(win: Window | null): void {
  if (win === null) return
  win.postMessage({ type: 'wordcraft:save-request' }, window.location.origin)
}

/**
 * Pending open request: `wordcraft:open` sent before the page posts
 * `wordcraft:ready` would be queued by the page only for its first boot —
 * a request racing an instance teardown could still be dropped, so the panel
 * holds the request and flushes it on ready.
 */
export interface PendingOpen {
  name: string
  bytes: Uint8Array
}
