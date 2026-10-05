# dsh-markdown-composer

让 DSH 的输入框支持 Markdown 语法：**草稿实时渲染预览** + **格式化工具栏** + **语法快捷键**。

插件是**纯增量**的——它不替换官方输入框，而是在官方 composer 已经渲染的两个插槽里加东西，所以附件上传、模型选择、权限/计划控件、斜杠命令、引用 chip、队列、上下文计量全部保持原样。

![panel](docs/panel.png)

## 功能

| 能力 | 说明 |
| --- | --- |
| 实时预览 | 输入框上方出现一张 composer dock 卡片，草稿边打边渲染。用的是官方 `MarkdownText` 原语（与对话正文同一个 GFM + TeX 渲染器），支持标题、加粗/斜体/删除线、行内代码、围栏代码块（高亮）、有序/无序/任务/嵌套列表、引用、表格、链接、脚注、KaTeX 数学公式、分隔线。 |
| 格式化工具栏 | 预览卡片头部 12 个按钮：加粗、斜体、删除线、行内代码、链接、H1、H2、无序列表、有序列表、任务列表、引用、代码块。点按钮不会抢走输入框焦点。 |
| 语法快捷键 | 在输入框内直接按快捷键插入/切换语法，见下表。 |
| 列表续写 | 在列表项/引用行按 `Shift+Enter` 换行后自动补上同级标记（`- `、`* `、`1. `、`- [ ] `、`> `）；在空列表项上再按一次则退出列表（自动删掉空标记）。 |
| 引用 chip 安全 | 草稿里带 `@文件` / `/指令` chip 时，任何编辑都不会覆盖 chip 所在的区间——行级操作改为「在行首插入标记」，行内包裹改为「在选区两侧插入标记」，从而不会把结构化引用降级成纯文本。 |
| 记忆偏好 | 预览开关与折叠状态存在 `localStorage`（`dsh-markdown-composer.*`），刷新/重启后保持。 |
| 中英双语 | 注册自己的 `markdown-composer` locale 命名空间（`zh` / `en`），跟随 DSH 的语言设置。 |

## 快捷键

macOS 用 `⌘`，Windows/Linux 用 `Ctrl`。快捷键按**物理键位**判定（`event.code`），所以 `⌘⇧8` 在任何键盘布局下都是无序列表。

| 快捷键 | 动作 |
| --- | --- |
| `⌘B` | 加粗（有选区包裹，无选区插入 `**粗体**` 且光标落在标记内） |
| `⌘I` | 斜体 |
| `⌘⇧X` | 删除线 |
| `⌘E` | 行内代码 |
| `⌘K` | 链接（有选区 → `[选区]()`；无选区 → `[链接文字]()`，光标落在括号内） |
| `⌘⇧1` / `⌘⇧2` / `⌘⇧3` | 一级 / 二级 / 三级标题（再按一次取消） |
| `⌘⇧8` | 无序列表 |
| `⌘⇧7` | 有序列表（自动编号） |
| `⌘⇧9` | 任务列表 |
| `⌘⇧.` | 引用 |
| `⌘⇧C` | 代码块（有选区包裹；无选区插入空围栏并把光标放进正文行） |
| `⇧Enter` | 换行 + 列表/引用续写 |

> `Enter` 保持 DSH 的原始语义（发送消息），续写只挂在换行手势上。

## 安装

插件是标准的 DSH bundle 包（`dsh.bundle.patch` + `dsh.client` 双半）。先把仓库放到任意目录，再把依赖写进 profile：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-markdown-composer": "link:/path/to/dsh-markdown-composer"
  }
}
```

```bash
dsh plugin --profile web install
```

`dsh plugin` 只跑 pnpm；安装后由 DSH 的 bundle 协调把声明了 `dsh.bundle` 的包追加进
`dsh.profile.bundles`（本包的 `cordis.patch.yml` 提供 insert 行），**重启 DSH 应用**后生效。

- **Web 端**：装进 `web` profile，`dsh web` 打开的页面刷新即生效。
- **桌面端（Electron）**：`dsh plugin --profile desktop ...` 会被 CLI 拒绝
  （`profile "desktop" is managed exclusively by the Electron application`）。
  改用**应用内插件管理器**（设置 → 插件，或 Agent 侧的 `plugin_manager` 工具）
  安装同一个 `link:` 依赖；它同样会跑 pnpm 并提示 `restart-required`。

### 卸载

```bash
dsh plugin --profile web remove dsh-markdown-composer
```

（桌面端同理走应用内插件管理器；profile 的 `dsh.profile.bundles` 行由 reconcile 自动清理。）

## 关闭或调参

- **关掉预览**：点输入框工具行里的 `M↓` 圆形按钮（官方 composer 左侧，权限控件右边）。预览关掉后快捷键仍然可用。
- **折叠预览**：点预览卡片右侧的 chevron，只留标题行和工具栏。
- **整体停用**：设置 → 插件 → 找到 `markdown-composer` 行停用，或卸载。

## 工作原理

DSH 的输入框是 shell 自己持有的 Lexical 富文本编辑器：插件拿不到编辑器实例，而 `conversation.composer` 这条 chain 插槽的语义是**整体接管** composer——那样会连带丢掉附件、模型、权限、计划、斜杠命令、队列和上下文计量的官方 UI。所以本插件走增量路线：

- **`conversation.input.dock`**（list，session 作用域）：预览卡片。官方 composer 在同一位置渲染 TodoPanel / QueueDock，卡片材质（`--dsw-specific-menu`、`--dsw-elevation-panel`、composer dock 的宽度公式）与之对齐。
- **`conversation.input.left`**（list，session 作用域）：工具行里的 `M↓` 开关（几何与官方圆形按钮一致），同时负责安装 composer 的键盘行为。
- **所有编辑都走公开的 `inputActions`**：`captureInsertion()` 拿当前选区与 `draftRev`，`insertText(text, span)` 做带版本守卫的替换。插件的编辑核心在 **clipboard 坐标**里计算，再映射到编辑器的 **detect 坐标**（chip 在 detect 里是 1 个 U+FFFC，在 clipboard 里是它的完整文本）；映射落在 chip 内部就拒绝执行。
- **chip 安全编辑计划**：一次动作可能产出一组编辑（`buildEdits`），从后往前应用，因此前面的偏移在应用时仍然有效。计划里绝不替换包含 chip 的区间：行级标记改成行首的零宽插入 / 只删标记文本，行内包裹改成选区两侧的零宽插入，围栏改成块首块尾的插入。

## 开发

```bash
node --test test/          # 22 个用例：纯编辑核心 + bundle 契约 + 注册
```

`test/harness.mjs` 会把 **发布产物** `lib/client.js` 直接在测试进程里求值（`new Function`，浏览器全局作为参数传入），拿到 bundle 注册的 factory 与它的 `__internals` 测试缝，因此测试跑的就是 Web 客户端加载的那份字节。

`lib/client.js` 是**手写的单文件 bundle**（无构建步骤）：它必须自注册为 `window.__ModuleLoader__.load({ id, factory })`，并且只能 `require` 模块表里的词（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`）。测试会断言这一点，防止误引离线模块。

改完 `lib/client.js` 后，客户端模块系统按文件 mtime/size 计算 rev，运行中的 Web 端会自动重新加载该插件（`dsh-client-hmr`），刷新页面即可看到新版本。

## 已知边界

- **不改变编辑器本身**：输入框里显示的仍然是原始 Markdown 文本（所见即所得的富文本内联渲染需要接管 composer，代价见上）。格式化结果通过上方预览卡片体现。
- **附件/图片不参与预览**：预览只渲染草稿文本；附件仍走官方附件轨。
- **本地文件链接**：预览里的 `http(s)` 链接会在新标签页打开；工作区相对路径不会变成可点击的文件链接（没有绑定官方 `openFile` 代理）。
- **`Enter` 不续写列表**：DSH 的 `Enter` 是发送，续写挂在 `Shift+Enter` 上。
