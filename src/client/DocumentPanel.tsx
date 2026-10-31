/**
 * WordCraft document panel — the `sidebar.right.pane.tab` keyed slot body
 * (right-sidebar tab for the `wordcraft` kind).
 *
 * Composition: a slim toolbar (session scope, file picker, dirty state, save,
 * reveal) above a same-origin iframe running the WordCraft bridge page
 * (/api/dsh-wordcraft/app.html), which boots the SuperDoc editor. All
 * document traffic flows through the postMessage bridge: the panel sends
 * `wordcraft:open` with bytes read via remote.workspaceFiles and drives saves
 * with `wordcraft:save-request` (the Save button or Ctrl+S inside the
 * document); the page answers with `wordcraft:save` (full .docx bytes, written
 * into the session workspace through the plugin's host route) and
 * `wordcraft:dirty`. The tab's `keepMounted` keeps the iframe (and its editor
 * state) alive across tab switches and sidebar collapse.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { basename as basenameOf, formatBytes } from './api.ts'
import { parseSessionFileAddress } from './address.ts'
import { isInbound, sendOpen, sendSaveRequest } from './bridge.ts'
import type { SessionFileTarget } from './address.ts'
import type { WorkspaceFileEntry } from './api.ts'
import type { WordcraftInbound, PendingOpen } from './bridge.ts'

/** Localized keys (shape of the zh dictionary). */
export type LocaleKey = keyof import('./locales.ts').zh

/** The slice of the seat's per-tab hook context the body reads. */
export interface TabInfoLike {
  tab: {
    /** Resource address for file tabs; an opaque id (or empty) for the guide-opened page tab. */
    contentId?: string
    /** Bumped when the same tab is navigated again (file re-opened after regeneration). */
    navigation?: { revision?: number }
    /** Tab occurrence lifetime; aborts in-flight reads when the tab closes. */
    signal?: AbortSignal
  }
}

/** Injected face + framework props the panel receives. */
export interface DocumentPanelProps {
  t: (key: LocaleKey) => string
  /** Bound `hooks.sessionList` source → selector hook over SessionListState. */
  useSessionList: (selector: (state: any) => any) => any
  /** Standard kit hook from the `sidebar.right.pane.tab` seat (per-tab context). */
  useTabInfo: () => TabInfoLike
  listDocuments: (sessionId: string, signal?: AbortSignal) => Promise<{ files: WorkspaceFileEntry[], truncated: boolean }>
  readFileBytes: (sessionId: string, path: string, signal?: AbortSignal) => Promise<Uint8Array>
  saveFile: (sessionId: string, path: string, bytes: Uint8Array) => Promise<{ path: string, bytes: number }>
  revealFile: (sessionId: string, path: string) => Promise<void>
  staticUrl: string
}

interface SessionRow {
  id: string
  displayTitle: string
  cwd?: string
  retainedBy?: { mainView?: number }
}

interface CurrentFile {
  sessionId: string
  path: string
  name: string
}

/** Default name for the save-as prompt on the blank page tab. */
const UNTITLED = 'untitled.docx'

/** Keep the caller-supplied save-as name a harmless workspace-relative path. */
function sanitizeRelative(input: string): string {
  const posix = input.replace(/\\/g, '/').trim()
  const parts = posix.split('/').filter(part => part !== '' && part !== '.' && part !== '..')
  return parts.join('/')
}

function isDocumentPath(path: string): boolean {
  return extnameIs(path, '.docx')
}

function extnameIs(path: string, ext: string): boolean {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot >= 0 && name.slice(dot).toLowerCase() === ext
}

export function DocumentPanel(props: DocumentPanelProps) {
  const { t, useSessionList, useTabInfo, listDocuments, readFileBytes, saveFile, revealFile, staticUrl } = props

  // Per-tab context from the seat. Presence is fixed per mounted instance
  // (the seat always provides it), so the conditional call keeps hook order
  // stable even where the component is rendered outside the seat.
  const tabInfo = useTabInfo !== undefined ? useTabInfo() : undefined
  const tabContentId = tabInfo?.tab?.contentId
  const tabRevision = tabInfo?.tab?.navigation?.revision
  const tabSignal = tabInfo?.tab?.signal

  const sessions = (useSessionList((state: any) => state) ?? { ids: [], byId: {} }) as {
    ids: string[]
    byId: Record<string, SessionRow | undefined>
  }

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [iframeKey, setIframeKey] = useState(0)
  const [ready, setReady] = useState(false)
  const [staticOk, setStaticOk] = useState<boolean | null>(null)

  const [scopeChoice, setScopeChoice] = useState<string | null>(null)
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([])
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done'>('idle')
  const [scanHint, setScanHint] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const [current, setCurrent] = useState<CurrentFile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveAs, setSaveAs] = useState<{ bytes: Uint8Array, initial: string } | null>(null)
  const [saveAsPath, setSaveAsPath] = useState('')

  // Latest-current ref so the message listener never holds a stale closure.
  const currentRef = useRef<CurrentFile | null>(null)
  currentRef.current = current
  const saveFileRef = useRef(saveFile)
  saveFileRef.current = saveFile
  // Open requests that arrived before the page's ready message: flushed on ready.
  const pendingOpenRef = useRef<PendingOpen | null>(null)
  const readyRef = useRef(ready)
  readyRef.current = ready
  const tabSignalRef = useRef<AbortSignal | undefined>(undefined)
  tabSignalRef.current = tabSignal
  // Monotonic load sequence: stale reads (superseded or tab closed) drop out.
  const loadSeqRef = useRef(0)

  const candidateRows: SessionRow[] = useMemo(() => {
    const rows: SessionRow[] = []
    for (const id of sessions.ids ?? []) {
      const row = sessions.byId?.[id]
      if (row?.cwd) rows.push(row)
    }
    return rows
  }, [sessions])

  const mainViewId = useMemo(
    () => candidateRows.find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id,
    [candidateRows],
  )
  const scopeId = scopeChoice ?? mainViewId ?? candidateRows[0]?.id

  // The file this tab was opened for (a clicked card / mention / @file /
  // Files row); undefined on the guide-opened blank page tab.
  const target = useMemo(() => parseSessionFileAddress(tabContentId), [tabContentId])

  // True when a newer load superseded this one or the tab's lifetime ended.
  const signalGone = (seq: number) =>
    seq !== loadSeqRef.current || (tabSignalRef.current?.aborted ?? false)

  // Load the tab's file straight into the editor, through the address's own
  // session (independent of the scope selector, which is pinned to match).
  const loadTarget = useCallback(async (file: SessionFileTarget) => {
    const seq = ++loadSeqRef.current
    try {
      setScopeChoice(file.sessionId)
      const bytes = await readFileBytes(file.sessionId, file.path, tabSignalRef.current)
      if (signalGone(seq)) return
      const win = iframeRef.current?.contentWindow ?? null
      if (readyRef.current && win !== null) {
        sendOpen(win, file.name, bytes)
      } else {
        // The page queues the first-boot open itself; the panel-side pending
        // slot covers the teardown race (a re-open while an instance dies).
        pendingOpenRef.current = { name: file.name, bytes }
      }
      setCurrent({ sessionId: file.sessionId, path: file.path, name: file.name })
      setDirty(false)
      setError(null)
      setNotice(null)
    } catch (openError) {
      if (signalGone(seq)) return
      const code = String((openError as Error & { code?: string })?.code ?? '')
      setError(code.includes('too-large')
        ? t('fileTooLarge')
        : `${t('openFailed')}: ${(openError as Error)?.message ?? String(openError)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readFileBytes])
  const loadTargetRef = useRef(loadTarget)
  loadTargetRef.current = loadTarget

  // Reload on re-navigation (revision bump): the same file re-opened after
  // regeneration refreshes in place instead of showing stale bytes.
  useEffect(() => {
    if (target === undefined || target.path === '') return
    void loadTargetRef.current(target)
  }, [target, tabRevision])

  // One bridge-page availability probe: drives the setup hint vs the iframe.
  useEffect(() => {
    const controller = new AbortController()
    fetch(staticUrl, { signal: controller.signal })
      .then(response => setStaticOk(response.ok))
      .catch(() => { if (!controller.signal.aborted) setStaticOk(false) })
    return () => controller.abort()
  }, [staticUrl])

  const scan = useCallback(async (sessionId: string, signal?: AbortSignal) => {
    setScanState('scanning')
    setScanHint(null)
    try {
      const result = await listDocuments(sessionId, signal)
      if (signal?.aborted) return
      setFiles(result.files)
      setScanState('done')
      if (result.truncated) setScanHint(t('listTruncated'))
    } catch (scanError) {
      if (signal?.aborted) return
      setFiles([])
      setScanState('done')
      setScanHint(`${t('scanFailed')}: ${(scanError as Error)?.message ?? String(scanError)}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listDocuments, t])

  // Open the picker → scan; rescan when the scope changes while open.
  useEffect(() => {
    if (!pickerOpen || !scopeId) return
    const controller = new AbortController()
    void scan(scopeId, controller.signal)
    return () => controller.abort()
  }, [pickerOpen, scopeId, scan])

  // Status notices settle on their own.
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const handleSave = useCallback(async (bytes: ArrayBuffer) => {
    const u8 = new Uint8Array(bytes)
    const active = currentRef.current
    if (active !== null) {
      try {
        await saveFileRef.current(active.sessionId, active.path, u8)
        setDirty(false)
        setError(null)
        setNotice(`${t('saved')} · ${active.path} · ${formatBytes(u8.length)}`)
      } catch (saveError) {
        setError(`${t('saveFailed')}: ${(saveError as Error)?.message ?? String(saveError)}`)
      }
      return
    }
    const initial = sanitizeRelative(UNTITLED)
    setSaveAs({ bytes: u8, initial })
    setSaveAsPath(initial)
  }, [t])

  // The bridge: only messages from our iframe, only wordcraft: types.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (!isInbound(event.data)) return
      const message = event.data as WordcraftInbound
      switch (message.type) {
        case 'wordcraft:ready':
          setReady(true)
          setError(null)
          if (pendingOpenRef.current !== null) {
            const pending = pendingOpenRef.current
            pendingOpenRef.current = null
            sendOpen(iframeRef.current?.contentWindow ?? null, pending.name, pending.bytes)
          }
          break
        case 'wordcraft:dirty':
          setDirty(message.dirty === true)
          break
        case 'wordcraft:save':
          void handleSave(message.bytes)
          break
        case 'wordcraft:failed':
          setReady(false)
          setError(`${t('loadFailed')}: ${message.error ?? ''}`)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [handleSave, t])

  const openFile = useCallback(async (entry: WorkspaceFileEntry) => {
    if (!scopeId) return
    try {
      const bytes = await readFileBytes(scopeId, entry.path)
      const win = iframeRef.current?.contentWindow ?? null
      if (ready && win !== null) {
        sendOpen(win, entry.name, bytes)
      } else {
        pendingOpenRef.current = { name: entry.name, bytes }
      }
      setCurrent({ sessionId: scopeId, path: entry.path, name: entry.name })
      setDirty(false)
      setPickerOpen(false)
      setError(null)
      setNotice(null)
    } catch (openError) {
      const code = String((openError as Error & { code?: string })?.code ?? '')
      const detail = code.includes('too-large')
        ? t('fileTooLarge')
        : `${t('openFailed')}: ${(openError as Error)?.message ?? String(openError)}`
      setError(detail)
    }
  }, [scopeId, readFileBytes, ready, t])

  const confirmSaveAs = useCallback(async () => {
    if (saveAs === null || !scopeId) return
    const target = sanitizeRelative(saveAsPath)
    if (target === '' || !isDocumentPath(target)) {
      setError(`${t('saveFailed')}: ${target === '' ? t('saveAsPrompt') : target}`)
      return
    }
    try {
      await saveFileRef.current(scopeId, target, saveAs.bytes)
      setCurrent({ sessionId: scopeId, path: target, name: basenameOf(target) })
      setDirty(false)
      setSaveAs(null)
      setError(null)
      setNotice(`${t('saved')} · ${target} · ${formatBytes(saveAs.bytes.length)}`)
    } catch (saveError) {
      setError(`${t('saveFailed')}: ${(saveError as Error)?.message ?? String(saveError)}`)
    }
  }, [saveAs, saveAsPath, scopeId, t])

  const saveCurrent = useCallback(() => {
    // The page answers with wordcraft:save; with no file attached yet the
    // bytes land in the save-as prompt instead of a fixed path.
    if (saveAs !== null) return
    sendSaveRequest(iframeRef.current?.contentWindow ?? null)
  }, [saveAs])

  const startNewDocument = useCallback(() => {
    setCurrent(null)
    currentRef.current = null
    setDirty(false)
    setReady(false)
    setIframeKey(key => key + 1)
  }, [])

  const revealCurrent = useCallback(async () => {
    const active = currentRef.current
    if (active === null) return
    try {
      await revealFile(active.sessionId, active.path)
    } catch (revealError) {
      setError(`${t('revealFailed')}: ${(revealError as Error)?.message ?? String(revealError)}`)
    }
  }, [revealFile, t])

  const statusLine = error ?? notice
  const statusKind = error !== null ? 'error' : 'ok'

  if (staticOk === false) {
    return <div className="dsh-wc-root"><div className="dsh-wc-setup">{t('setupMissing')}</div></div>
  }

  return (
    <div className="dsh-wc-root">
      <div className="dsh-wc-toolbar">
        <label className="dsh-wc-field">
          <span className="dsh-wc-field-label">{t('sessionScope')}</span>
          <select
            className="dsh-wc-select"
            value={scopeId ?? ''}
            onChange={event => { setScopeChoice(event.target.value === '' ? null : event.target.value) }}
          >
            {candidateRows.length === 0 && <option value="">{t('noSession')}</option>}
            {candidateRows.map(row => (
              <option key={row.id} value={row.id}>
                {row.displayTitle} · {row.cwd?.split(/[\\/]/).pop() ?? ''}
              </option>
            ))}
          </select>
        </label>

        <div className="dsh-wc-picker-wrap">
          <button
            type="button"
            className="dsh-wc-btn"
            disabled={scopeId === undefined}
            onClick={() => setPickerOpen(open => !open)}
            title={t('openTitle')}
          >
            {t('open')} {pickerOpen ? '▾' : '▸'}
          </button>
          {pickerOpen && (
            <div className="dsh-wc-picker" role="menu">
              <div className="dsh-wc-picker-head">
                <span>{scanState === 'scanning' ? t('scanning') : `${files.length}`}</span>
                <button type="button" className="dsh-wc-btn dsh-wc-btn-small" onClick={() => scopeId && void scan(scopeId, undefined)}>
                  {t('refresh')}
                </button>
              </div>
              {scanHint !== null && <div className="dsh-wc-picker-hint">{scanHint}</div>}
              {scanState === 'done' && files.length === 0 && (
                <div className="dsh-wc-picker-empty">{t('noFiles')}</div>
              )}
              <div className="dsh-wc-picker-list">
                {files.map(entry => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`dsh-wc-picker-item${current?.path === entry.path && current?.sessionId === scopeId ? ' is-active' : ''}`}
                    onClick={() => void openFile(entry)}
                    title={entry.path}
                  >
                    <span className="dsh-wc-picker-name">{entry.name}</span>
                    <span className="dsh-wc-picker-path">{entry.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button type="button" className="dsh-wc-btn" onClick={startNewDocument} title={t('newDocument')}>
          {t('newDocument')}
        </button>

        <span className="dsh-wc-file" title={current !== null ? current.path : undefined}>
          {current !== null
            ? (
              <>
                <span className={`dsh-wc-dot${dirty ? ' is-dirty' : ''}`} />
                {current.name}
                <span className="dsh-wc-dirty-label">{dirty ? t('dirty') : ''}</span>
              </>
            )
            : <span className="dsh-wc-file-none">—</span>}
        </span>

        <span className="dsh-wc-spacer" />

        <span className="dsh-wc-hint">{t('saveHint')}</span>

        <button
          type="button"
          className={`dsh-wc-btn${dirty ? ' dsh-wc-btn-primary' : ''}`}
          disabled={!ready}
          onClick={saveCurrent}
          title={t('saveTitle')}
        >
          {t('save')}
        </button>

        {current !== null && (
          <button type="button" className="dsh-wc-btn" onClick={() => void revealCurrent()} title={t('reveal')}>
            {t('reveal')}
          </button>
        )}
      </div>

      {saveAs !== null && (
        <div className="dsh-wc-saveas">
          <span>{t('saveAsPrompt')}</span>
          <input
            className="dsh-wc-input"
            value={saveAsPath}
            autoFocus
            onFocus={event => event.currentTarget.select()}
            onChange={event => setSaveAsPath(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && saveAs.bytes.length > 0) void confirmSaveAs()
              if (event.key === 'Escape') setSaveAs(null)
            }}
            placeholder={UNTITLED}
          />
          <button
            type="button"
            className="dsh-wc-btn dsh-wc-btn-primary"
            disabled={saveAs.bytes.length === 0}
            onClick={() => void confirmSaveAs()}
          >
            {t('saveAsConfirm')}
          </button>
          <button type="button" className="dsh-wc-btn" onClick={() => setSaveAs(null)}>{t('saveAsCancel')}</button>
        </div>
      )}

      {statusLine !== null && (
        <button
          type="button"
          className={`dsh-wc-status dsh-wc-status-${statusKind}`}
          onClick={() => { setError(null); setNotice(null) }}
        >
          {statusLine}
        </button>
      )}

      <div className="dsh-wc-frame-wrap">
        {staticOk !== false && (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            className="dsh-wc-frame"
            src={staticUrl}
            title={t('panelTitle')}
            allow="clipboard-read; clipboard-write"
          />
        )}
        {!ready && staticOk !== false && (
          <div className="dsh-wc-loading">{t('loading')}</div>
        )}
      </div>
    </div>
  )
}
