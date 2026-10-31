/** Shared types for the dsh-wordcraft host half. */

/** Plugin configuration (the `Config` schema → plugins settings page). */
export interface WordcraftConfig {
  enabled?: boolean
  /** Open .docx files in WordCraft by default; off = built-in preview. */
  defaultOpener?: boolean
}

/** Standard JSON API envelope, aligned with the other dsh plugins. */
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}
