/**
 * "Open in Documents" button on conversation file cards.
 *
 * Contributed to the `deliverables.file.actions` list slot: for .docx files
 * it renders a compact button beside the card's OS "open with" control and
 * opens the file in the right-sidebar WordCraft tab. The slot owner only
 * passes authenticated coordinates (actionUrl with sessionId/seq/index), so
 * the path comes from the plugin's `/api/dsh-wordcraft/resolve` route (which
 * reads the `deliverables/presented` event); non-document files render
 * nothing.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { extname, DOCUMENT_EXTS } from './api.ts'
import { sessionFileAddress } from './address.ts'
import type { SessionFileTarget } from './address.ts'
import type { LocaleKey } from './DocumentPanel.tsx'
import { PanelIcon } from './PanelIcon.tsx'

/** Injected face + slot owner props the button receives. */
export interface OpenInWordcraftProps {
  t: (key: LocaleKey) => string
  /** Authenticated present.open coordinates carried by the file card. */
  actionUrl: string
  /** Coordinates → declared file (cached); `null` when unresolvable. */
  resolvePresented: (actionUrl: string) => Promise<SessionFileTarget | null>
  /** Open a `dsh-resource://file/...` address in the right-sidebar tab. */
  openAddress: (address: string) => void
  /** The plugin-config default-opener switch (live snapshot read). */
  isDefaultOpener: () => boolean
  /** Config form subscription for the switch above. */
  subscribeDefaultOpener: (listener: () => void) => () => void
}

export function OpenInWordcraft({ t, actionUrl, resolvePresented, openAddress, isDefaultOpener, subscribeDefaultOpener }: OpenInWordcraftProps) {
  const [target, setTarget] = useState<SessionFileTarget | null>(null)
  const enabled = useSyncExternalStore(subscribeDefaultOpener, isDefaultOpener)
  useEffect(() => {
    let live = true
    resolvePresented(actionUrl)
      .then(resolved => { if (live) setTarget(resolved) })
      .catch(() => { /* no button on resolve failures */ })
    return () => { live = false }
  }, [actionUrl, resolvePresented])

  // The default-opener switch also hides the card affordance: with it off
  // the card behaves fully native (built-in preview + OS apps).
  if (!enabled || target === null || !DOCUMENT_EXTS.has(extname(target.path))) return null
  return (
    <button
      type="button"
      className="dsh-wc-card-open"
      title={t('openHereTitle')}
      onClick={() => { openAddress(sessionFileAddress(target.sessionId, target.path)) }}
    >
      <PanelIcon size={13} />
      <span>{t('openHere')}</span>
    </button>
  )
}
