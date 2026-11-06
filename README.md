# dsh-wordcraft

Word document editing for DeepSeek Harness: embeds the [SuperDoc](https://github.com/Harbour-Enterprises/SuperDoc) web editor (ProseMirror, direct OOXML — no server) in a right-sidebar tab, opens workspace `.docx` files into it, and saves back through the host. The architecture mirrors [dsh-gridcraft](https://github.com/hfanshu/dsh-gridcraft).

中文说明见 [README.zh.md](./README.zh.md)。

## Features

- **Right-sidebar tab** — a `wordcraft` tab type with a guide-page entry card; `keepMounted` keeps the editor alive across tab switches, sidebar collapse, and session changes.
- **File routing** — `*.docx` file addresses (file cards, chat mentions, `@file` references, Files-sidebar rows) open in WordCraft instead of the built-in text preview; an "Open in Documents" button is contributed to conversation file cards.
- **Workspace open/save** — documents load from the owning session's workspace via the host's workspaceFiles remote; saves (panel Save button or Ctrl+S inside the editor) write back through `/api/dsh-wordcraft/save` (containment-checked, atomic).
- **Dirty tracking** — SuperDoc's `isDirty()` state surfaces as a dot + chip in the panel toolbar.
- **Plugin-page switch** — a default-opener toggle on the plugin's own detail page (off = built-in preview resumes).
- **Bilingual chrome** — panel chrome follows the host locale (zh/en). The SuperDoc editor UI itself is English-only (it ships no i18n).

## Setup

```bash
cd dsh-wordcraft
npm run setup   # install + fetch the SuperDoc build + build host/client halves
```

`npm run fetch-wordcraft` downloads the unmodified prebuilt CDN bundle (`dist-cdn/`) from the pinned `superdoc` npm version into gitignored `static/vendor/`.

## Architecture

```
app/app.html + app/app.js   committed bridge page (SuperDoc lifecycle + wordcraft:* postMessage)
static/vendor/              fetched SuperDoc build (gitignored)
src/client/                 panel: tab registration, file picker, save/dirty bridge, card button, config view
index.ts + routes.ts        host half: route registration, static hosting, workspace save, resolve
```

Routes:

| Route | Purpose |
| --- | --- |
| `GET /api/dsh-wordcraft/app.html` `/app.js` | the bridge page the panel hosts in an iframe (no-cache) |
| `GET /api/dsh-wordcraft/vendor/*` | the SuperDoc build (immutable) |
| `POST /api/dsh-wordcraft/save?sessionId&path` | editor bytes → session workspace (atomic, containment-checked) |
| `GET /api/dsh-wordcraft/resolve?sessionId&seq&index` | deliverables file-card coordinates → declared path |

Bridge protocol (both sides guard source + origin):

- child → parent: `wordcraft:ready {version}` · `wordcraft:dirty {dirty}` · `wordcraft:save {bytes}` · `wordcraft:failed {error}`
- parent → child: `wordcraft:open {name, bytes}` · `wordcraft:save-request`

## Tests

```bash
npm test   # host routes (containment/atomicity/MIME/resolve) + client apply (slot registrations)
```

## Scope notes

- Only `.docx` is claimed; legacy `.doc`, PDF viewing, and PDF export are out of scope for v1.
- Each resource tab runs its own SuperDoc instance (like dsh-gridcraft's per-tab WASM).
- License: the plugin is MIT; SuperDoc is AGPL-3.0 and is fetched unmodified from npm at setup time (not committed here). Local personal use is unaffected; public redistribution of a bundle containing SuperDoc must satisfy AGPL-3.0.
