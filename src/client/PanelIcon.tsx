/** Decorative document glyph for the sidebar panel row (no host primitive deps). */
export function PanelIcon({ size, className }: { size?: number, className?: string } = {}) {
  const edge = size ?? 16
  return (
    <svg width={edge} height={edge} viewBox="0 0 48 48" fill="none" aria-hidden="true" className={className}>
      <path d="M11 6h17l9 9v25a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="currentColor" opacity="0.9" />
      <path d="M28 6l9 9h-9V6z" fill="var(--dsw-alias-surface-default, #fff)" opacity="0.6" />
      <rect x="14" y="21" width="20" height="2.6" rx="1.3" fill="var(--dsw-alias-surface-default, #fff)" opacity="0.9" />
      <rect x="14" y="27" width="20" height="2.6" rx="1.3" fill="var(--dsw-alias-surface-default, #fff)" opacity="0.75" />
      <rect x="14" y="33" width="12" height="2.6" rx="1.3" fill="var(--dsw-alias-surface-default, #fff)" opacity="0.6" />
    </svg>
  )
}
