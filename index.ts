/**
 * dsh-wordcraft — embed the SuperDoc web editor in a DSH right-sidebar tab,
 * with workspace file open/save through the host.
 *
 * SuperDoc (npm `superdoc`, harbour.superdoc.dev) is a ProseMirror-based
 * word processor that edits .docx in place — reads and writes the OOXML
 * package directly, no server. This plugin hosts its prebuilt CDN bundle in
 * an iframe behind a small bridge page and speaks a postMessage protocol
 * modeled on GridCraft's `?host=parent` bridge:
 *
 * - child → parent: {type:'wordcraft:ready', version}
 *                   {type:'wordcraft:save', bytes}
 *                   {type:'wordcraft:dirty', dirty}
 *                   {type:'wordcraft:failed', error}
 * - parent → child: {type:'wordcraft:open', name, bytes}
 *                   {type:'wordcraft:save-request'}
 *
 * Host half: serves the committed bridge page (app/) and the vendor build
 * (static/, fetched by scripts/fetch-wordcraft.mjs) at
 * /api/dsh-wordcraft/*, and exposes /api/dsh-wordcraft/save, which writes
 * bridge bytes into the owning Session's workspace (containment-checked,
 * atomic), plus /api/dsh-wordcraft/resolve, which turns deliverables
 * file-card coordinates into the declared file's path.
 *
 * Client half (src/client): registers the `wordcraft` right-sidebar tab type
 * (guide card + .docx file-address patterns), hosting the iframe; lists
 * document files from the selected Session's workspace via
 * remote.workspaceFiles, and bridges open/save/dirty messages.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWordcraftRoutes, createResolveRoute, WC_APP_HTML_PATH, WC_APP_JS_PATH, WC_VENDOR_BASE } from './routes.js'
import type { WordcraftConfig } from './types.js'

/** Stable cordis plugin id (matches the bundle patch `id: wordcraft`). */
export const name = 'wordcraft'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'sessions']

/**
 * Plugin config schema — the plugins settings page auto-generates the form
 * from this (SettingsForms reads the entry fiber's static `Config`). Only
 * `.volatile()` fields accept live edits (`settings/rejected` otherwise), so
 * the switch writes through without restarting this plugin fiber; the client
 * reads the live value through `ctx.configForms.get('wordcraft')` for its
 * routing decisions.
 */
export const Config = z.object({
  defaultOpener: z.boolean().default(true).volatile()
    .description('点击 docx 文件时默认在 WordCraft 中打开；关闭后使用内建预览 (Open .docx files with WordCraft by default; off = built-in preview)'),
})

/** Single-active guard: blocks a concurrent double-activation, and resets when
 * the fiber disposes — a config edit restarts the plugin, and the restart must
 * re-run apply (the same module instance is reused). */
let active = false

function mountOnce(apply: (ctx: Context, config?: WordcraftConfig) => void) {
  return (ctx: Context, config?: WordcraftConfig) => {
    if (active) return
    active = true
    ctx.effect(() => () => { active = false }, 'dsh-wordcraft: mount guard')
    apply(ctx, config)
  }
}

/** Host-half apply: mount bridge page + vendor + save routes. */
function applyImpl(ctx: Context, config?: WordcraftConfig): void {
  if (config?.enabled === false) {
    console.log('[dsh-wordcraft] Plugin disabled by config')
    return
  }

  // lib/index.js → plugin root (repo layout: app/ and static/ beside package.json).
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const appDir = resolve(pluginRoot, 'app')
  // The vendor prefix consumes the /vendor/ segment, so the route root is the
  // vendor directory itself (static/vendor/superdoc.min.js serves at
  // /api/dsh-wordcraft/vendor/superdoc.min.js).
  const staticDir = resolve(pluginRoot, 'static', 'vendor')
  if (!existsSync(resolve(appDir, 'app.html'))) {
    console.warn('[dsh-wordcraft] app/app.html missing — the plugin install is incomplete; the panel will show a setup hint until then')
  }
  if (!existsSync(resolve(staticDir, 'superdoc.min.js'))) {
    console.warn('[dsh-wordcraft] static/vendor/superdoc.min.js missing — run `npm run fetch-wordcraft` in the plugin directory; the panel will show a setup hint until then')
  }

  const disposers: (() => void)[] = []
  for (const route of createWordcraftRoutes({ appDir, staticDir, sessions: ctx.sessions })) {
    disposers.push(ctx.webServer.register(route))
  }

  // The resolve route needs the host sessionQuery service; guard it so a host
  // without the service still mounts the page + vendor + save surfaces. cordis
  // runs the inject callback as its own plugin — the services are reachable
  // only through the callback's derived context, not the outer closure (the
  // outer ctx trips the "cannot get property … without inject" guard).
  ctx.inject(['sessionQuery'], (serviceCtx) => {
    try {
      disposers.push(ctx.webServer.register(createResolveRoute({
        sessionQuery: (serviceCtx as Context & { sessionQuery: NonNullable<Context['sessionQuery']> }).sessionQuery,
      })))
      console.log('[dsh-wordcraft] resolve route registered at /api/dsh-wordcraft/resolve')
    } catch (error) {
      console.warn('[dsh-wordcraft] Failed to register resolve route:', error)
    }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-wordcraft: routes')

  console.log(`[dsh-wordcraft] Plugin initialized — page at ${WC_APP_HTML_PATH}, vendor at ${WC_VENDOR_BASE}/, save at /api/dsh-wordcraft/save (app.js at ${WC_APP_JS_PATH})`)
}

export const apply = mountOnce(applyImpl)
