/**
 * WordCraft bridge — SuperDoc lifecycle + the wordcraft:* postMessage
 * protocol, the counterpart of the panel (src/client/DocumentPanel.tsx) and
 * its bridge.ts. This page always runs as a same-origin iframe of the DSH web
 * GUI; both directions guard on event.source === window.parent and matching
 * origin, mirroring the GridCraft host bridge this plugin's shape comes from.
 *
 * Wire shapes:
 * - child → parent: {type:'wordcraft:ready', version}    editor booted, opens accepted
 *                   {type:'wordcraft:save', bytes}       full .docx bytes (host.save())
 *                   {type:'wordcraft:dirty', dirty}      isDirty() flipped
 *                   {type:'wordcraft:failed', error}     boot/save/export failure
 * - parent → child: {type:'wordcraft:open', name, bytes} open a workspace .docx
 *                   {type:'wordcraft:save-request'}      panel Save button / Ctrl+S
 *
 * SuperDoc v2 notes (validated against superdoc@2.28.0 dist-cdn):
 * - `new SuperDoc({selector, ui, documentMode, document})`; a byte source
 *   (ArrayBuffer/Uint8Array) is accepted directly, omitting `document`
 *   opens a blank DOCX.
 * - The active editor facade (`doc.activeEditor`) materializes shortly
 *   AFTER the `ready` event, so opens are queued until `host` exists.
 * - `host.isDirty()` / `host.markSaved()` drive the dirty chip; `host.save()`
 *   resolves with the full .docx as an ArrayBuffer.
 * - There is no built-in save gesture, so this page binds Ctrl+S / Cmd+S and
 *   the panel drives saves through `wordcraft:save-request`.
 */
;(function () {
  'use strict'

  var TOOLBAR_SELECTOR = '#wc-toolbar'
  var EDITOR_SELECTOR = '#wc-editor'
  var DIRTY_POLL_MS = 500

  var parent = window.parent
  if (parent === window) return // not framed: nothing to bridge

  // ── outbound ─────────────────────────────────────────────────────────
  // Same-origin with the parent, so its origin is readable; if someone ever
  // frames this page cross-origin the access throws and the bridge stays
  // silent instead of leaking document bytes to a wildcard target.
  var parentOrigin = null
  try { parentOrigin = parent.location.origin } catch { parentOrigin = null }

  function post(message) {
    if (parentOrigin === null) return
    try { parent.postMessage(message, parentOrigin) } catch { /* parent gone */ }
  }
  function postFailed(error) {
    post({ type: 'wordcraft:failed', error: String(error == null ? 'unknown error' : error).slice(0, 500) })
  }

  // ── SuperDoc instance management ─────────────────────────────────────
  var doc = null            // the live SuperDoc instance (or null)
  var bootedOnce = false    // an instance existed at least once (ready was sent)
  var lastDirty = false
  var pendingOpen = null    // {name, bytes} that arrived before the host existed
  var reportedError = ''    // dedupe window of identical consecutive failures
  var bootSeq = 0           // guards stale async boot completions
  var bootFailures = {}     // per-boot exception slots (seq → Error)

  function activeHost() {
    try {
      var editor = doc && doc.activeEditor
      return editor && editor.host && typeof editor.host.save === 'function' ? editor.host : null
    } catch { return null }
  }

  /** Wait until the live instance's editor facade exists (post-ready delay). */
  function waitForHost(seq, timeoutMs) {
    return new Promise(function (resolvePromise, rejectPromise) {
      var started = Date.now()
      var timer = setInterval(function () {
        if (seq !== bootSeq) { clearInterval(timer); rejectPromise(new Error('superseded')); return }
        var host = activeHost()
        if (host !== null) { clearInterval(timer); resolvePromise(host); return }
        // An exception during this boot fails fast — the instance is dead and
        // waiting out the full timeout would only delay the retry below.
        var bootError = bootFailures[seq]
        if (bootError) { clearInterval(timer); rejectPromise(bootError); return }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer)
          rejectPromise(new Error('editor did not initialize'))
        }
      }, 100)
    })
  }

  function emitDirty(value) {
    if (value !== lastDirty) {
      lastDirty = value
      post({ type: 'wordcraft:dirty', dirty: value })
    }
  }

  function trackInstance(instance, seq) {
    var onError = function (payload) {
      var message = String((payload && payload.error) || 'editor error')
      if (seq !== undefined && seq === bootSeq && !bootedOnce) {
        // During boot this instance is beyond saving — record for the
        // fast-fail and the retry; report only if the retry fails too.
        if (bootFailures[seq] === undefined) bootFailures[seq] = new Error(message)
        return
      }
      if (message === reportedError) return
      reportedError = message
      postFailed(message)
    }
    try {
      instance.on('exception', onError)
      instance.on('content-error', onError)
    } catch { /* eventing is best-effort */ }
  }

  function destroyCurrent() {
    if (doc === null) return
    try { doc.destroy() } catch { /* already gone */ }
    doc = null
  }

  /**
   * Create a SuperDoc instance. Boots are flaky under rapid successive
   * create/destroy cycles (font metrics races, stuck workers), so a failed
   * boot retries once on a fresh instance before surfacing an error.
   */
  function createInstance(bytes, isRetry) {
    var seq = ++bootSeq
    bootFailures = {}
    var config = {
      selector: EDITOR_SELECTOR,
      documentMode: 'editing',
      user: { name: 'DSH User' },
      ui: { toolbar: { container: TOOLBAR_SELECTOR } },
    }
    if (bytes !== null) config.document = bytes
    var instance = null
    try {
      instance = new SuperDoc(config)
    } catch (error) {
      postFailed('SuperDoc failed to construct: ' + error)
      return
    }
    doc = instance
    trackInstance(instance, seq)
    waitForHost(seq, 30000).then(function () {
      if (seq !== bootSeq) return
      if (!bootedOnce) {
        bootedOnce = true
        var version = 'unknown'
        try { version = String(instance.version || version) } catch { /* keep unknown */ }
        post({ type: 'wordcraft:ready', version: version })
      }
      lastDirty = false
      emitDirty(false)
      if (pendingOpen !== null) {
        var queued = pendingOpen
        pendingOpen = null
        openDocument(queued.name, queued.bytes)
      }
    }).catch(function (error) {
      if (error && error.message === 'superseded') return
      if (!isRetry) {
        destroyCurrent()
        setTimeout(function () { createInstance(bytes, true) }, 800)
        return
      }
      postFailed('SuperDoc failed to start: ' + error)
    })
  }

  function openDocument(name, bytes) {
    var host = activeHost()
    if (host === null) {
      // No facade yet: either the first boot is still starting or a previous
      // open is mid-teardown — the bridge upstream drops early opens, so the
      // request is queued and flushed by the boot completion.
      pendingOpen = { name: name, bytes: bytes }
      if (doc === null) createInstance(null)
      return
    }
    // Recreate with the new bytes: destroy clears the DOM mounts, so the
    // selectors are free for the next instance. A queued open from a
    // mid-teardown race lands via the boot completion flush above.
    try { doc.destroy() } catch { /* already gone */ }
    doc = null
    var copy = bytes instanceof ArrayBuffer ? bytes.slice(0) : (bytes ? new Uint8Array(bytes).buffer : null)
    createInstance(copy)
  }

  function requestSave() {
    var host = activeHost()
    if (host === null) {
      postFailed('save requested before the editor was ready')
      return
    }
    Promise.resolve().then(function () { return host.save() }).then(function (result) {
      var bytes = result instanceof ArrayBuffer ? result.slice(0)
        : result instanceof Uint8Array ? result.slice().buffer
        : null
      if (bytes === null || bytes.byteLength === 0) {
        postFailed('save produced no bytes')
        return
      }
      post({ type: 'wordcraft:save', bytes: bytes })
    }).catch(function (error) {
      postFailed('save failed: ' + error)
    })
  }

  // ── inbound ──────────────────────────────────────────────────────────
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return
    if (event.origin !== parentOrigin) return
    var data = event.data
    if (typeof data !== 'object' || data === null) return
    var type = typeof data.type === 'string' ? data.type : ''
    if (type === 'wordcraft:open') {
      var bytes = data.bytes
      if (!(bytes instanceof ArrayBuffer) && !(bytes instanceof Uint8Array)) {
        postFailed('open without bytes')
        return
      }
      openDocument(typeof data.name === 'string' ? data.name : '', bytes)
      return
    }
    if (type === 'wordcraft:save-request') {
      requestSave()
    }
  })

  // Ctrl+S / Cmd+S inside the document → same save flow as the panel button.
  window.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault()
      requestSave()
    }
  })

  // ── dirty polling (SuperDoc has no dirty-change event) ───────────────
  setInterval(function () {
    var host = activeHost()
    if (host === null || typeof host.isDirty !== 'function') return
    try { emitDirty(host.isDirty() === true) } catch { /* next tick */ }
  }, DIRTY_POLL_MS)

  // ── top-level failure reporting ──────────────────────────────────────
  window.addEventListener('error', function (event) {
    var message = event && event.message ? event.message : 'page error'
    if (message === reportedError) return
    reportedError = message
    postFailed(message)
  })

  // ── boot: a blank document, ready for the guide-page tab ─────────────
  if (typeof SuperDoc === 'undefined') {
    postFailed('SuperDoc vendor build missing: run npm run fetch-wordcraft in the plugin directory, then restart')
    return
  }
  createInstance(null)

  // Debug handle for end-to-end verification (reads only; not a public API).
  try { window.__wc = { get doc() { return doc }, activeHost: activeHost } } catch { /* ignore */ }
})()
