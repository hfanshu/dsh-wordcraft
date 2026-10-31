# dsh-wordcraft

DeepSeek Harness 的 Word 文档编辑插件：将 [SuperDoc](https://github.com/Harbour-Enterprises/SuperDoc) 网页编辑器（基于 ProseMirror、直写 OOXML、无需服务端）嵌入右侧边栏页签，打开工作区中的 `.docx` 文档并通过宿主写回。架构与 [dsh-gridcraft](https://github.com/15217814598/dsh-gridcraft) 一致。

## 功能

- **右侧边栏页签** — `wordcraft` 页签类型 + 空白页引导卡；`keepMounted` 保证编辑器状态跨页签切换/侧栏折叠/会话切换存活。
- **文件路由** — `*.docx` 文件地址（文件卡片、对话提及、@文件引用、Files 侧栏行）直达 WordCraft；对话文件卡片上另有「在文档中打开」按钮。
- **工作区打开/保存** — 文档经宿主 workspaceFiles remote 读取；保存（面板保存按钮或编辑器内 Ctrl+S）经 `/api/dsh-wordcraft/save` 写回（路径封堵 + 原子写）。
- **脏状态跟踪** — SuperDoc 的 `isDirty()` 以圆点 + 芯片形式呈现在面板工具栏。
- **插件页开关** — 插件详情页提供「默认打开方式」开关（关闭后回落内建预览）。
- **双语外壳** — 面板外壳跟随宿主语言（中/英）。SuperDoc 编辑器本体为英文 UI（上游无 i18n）。

## 安装

```bash
cd dsh-wordcraft
npm run setup   # 安装依赖 + 拉取 SuperDoc 构建 + 构建宿主/客户端两半
```

`npm run fetch-wordcraft` 从固定版本的 `superdoc` npm 包下载未修改的预构建 CDN 产物（`dist-cdn/`）到 gitignore 的 `static/vendor/`。

## 架构

```
app/app.html + app/app.js   提交的桥页（SuperDoc 生命周期 + wordcraft:* postMessage 协议）
static/vendor/              拉取的 SuperDoc 构建（gitignore）
src/client/                 面板：页签注册、文件选择、保存/脏桥接、卡片按钮、配置视图
index.ts + routes.ts        宿主半：路由注册、静态托管、工作区保存、resolve
```

路由：

| 路由 | 用途 |
| --- | --- |
| `GET /api/dsh-wordcraft/app.html` `/app.js` | 面板 iframe 承载的桥页（no-cache） |
| `GET /api/dsh-wordcraft/vendor/*` | SuperDoc 构建（immutable 缓存） |
| `POST /api/dsh-wordcraft/save?sessionId&path` | 编辑器字节 → 会话工作区（原子写、路径封堵） |
| `GET /api/dsh-wordcraft/resolve?sessionId&seq&index` | 文件卡片坐标 → 声明的文件路径 |

桥协议（双方均校验 source + origin）：

- 子 → 父：`wordcraft:ready {version}` · `wordcraft:dirty {dirty}` · `wordcraft:save {bytes}` · `wordcraft:failed {error}`
- 父 → 子：`wordcraft:open {name, bytes}` · `wordcraft:save-request`

## 测试

```bash
npm test   # 宿主路由（封堵/原子/MIME/resolve）+ 客户端 apply（槽注册）
```

## 范围说明

- v1 只认领 `.docx`；旧版 `.doc`、PDF 查看、PDF 导出暂不支持。
- 每个资源页签运行独立的 SuperDoc 实例（同 dsh-gridcraft 的每页签一份 WASM）。
- 许可：插件自身 MIT；SuperDoc 为 AGPL-3.0，由安装脚本从 npm 下载未修改产物（不进仓库）。本地个人使用不受影响；若公开分发包含 SuperDoc 的打包产物需满足 AGPL-3.0。
