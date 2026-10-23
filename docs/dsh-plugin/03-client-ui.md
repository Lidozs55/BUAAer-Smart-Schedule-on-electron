# 03 · Client 半：在宿主 Web UI 里做页面

> Client 半是一个**浏览器 JS 文件**：它向页面注册一个惰性 factory，factory 返回一个 Cordis 插件，插件把 React 组件注册进宿主的**槽位**。
> **关键结论先说**：日历页应该落在 **`main`（keyed，root scope）+ `sidebar.panellist`（list，root scope）** 这一对上；`main` 的非 `conversation` key **没有 Session 绑定**，正是我们要的"无会话整页"。宿主里已有一个一模一样的先例：`@deepseek-ai/dsh-client-ui-schedule`（Host 任务管理页 + Session 提醒目录）。

---

## 1. 清单与产物

```json
{
  "name": "@lidozs55/dsh-schedule",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": []
    }
  }
}
```

`dsh.client` 四个字段的**准确定义**（来自 `@deepseek-ai/dsh-util-package-manifest` 的类型声明）：

| 字段 | 定义 |
|---|---|
| `platform` | **必填**。client platform 标识；Web 消费方选字面量 `"web"` |
| `inject` | **只是信息性的包名依赖，不是 Cordis 服务注入**（Cordis 的 `inject` 是插件自己导出的数组） |
| `immediately` | 引导第一阶段的注册屏障；**缺省表示随共享应用批次**加载 |
| `external` | 除隐式 client 基线之外**精确请求的模块表条目**（含 `<pkg>/client` 这类子路径）；缺省 = 只用基线外部模块。类型专用 import 会被擦除，不产生模块请求 |

**两条硬约束**：

1. 浏览器半**只挂在说明符恰好是裸包名的那一行**上。把一个包拆成多行（`@pkg/x/subpath`）时，子路径行永远不带半侧，它注册的页面会随根行关闭而消失。需要独立生命周期就单独发包。
2. `client.js` 里 `window.__ModuleLoader__.load({ id })` 的 `id` **必须等于包名**。

---

## 2. 产物格式与模块表

```js
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule',
  factory(require) {
    const React = require('react');            // React 来自浏览器模块表
    const h = React.createElement;

    function CalendarIcon({ size }) { return h('span', { style: { fontSize: size } }, '▦'); }
    function CalendarPage() { return h('div', null, '日程'); }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const el = document.createElement('style');
          el.dataset.plugin = '@lidozs55/dsh-schedule';
          el.textContent = '.schedule-calendar { color: var(--dsw-alias-label-primary); }';
          document.head.append(el);
          return () => el.remove();
        });
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'schedule-calendar' }, CalendarPage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'schedule-calendar', order: 100, label: '智能日历' }, CalendarIcon));
      },
    };
  },
});
```

机制要点（`@deepseek-ai/dsh-client-modules` 的 `client/manifest.ts`）：

- `factory(require)` 在**首次 import/require 时**才执行（lazy CJS），结果**记忆化**。但同步 `require` 只解析模块表 seed 词、已记忆（物化）记录和注册依赖图里的行——**包内分块（`client.*.js`）不在图里**：一个分块的 factory 同步 require 另一个尚未 `require.async` 物化的分块会直接抛 `missed the module table`（M0 实测：入口先物化 core，calendar factory 同步 require 未装载的 weekgrid 即挂）。所以**入口 `apply` 必须按依赖序先 `require.async` 每个会被同步 require 的分块**（叶分块先于引用它们的分块），加载顺序需要外部编排。
- `factory` 必须返回 bundle 的 **exports 对象**；对 Cordis 插件来说就是那个插件值（对象形式 `{ inject, apply }`，或函数形式）。
- `require` 的解析顺序：模块表 seed 词 → 已记忆的记录 → 图里的行（注册依赖的 factory）→ 已注册的 factory → 否则**大声抛错**（`client-modules: require("…") missed the module table …`）。
- **`factory` 里不要做副作用**（不要发请求、不要在 factory 里往 `document.head` 塞东西）。样式、定时器、监听器都在 `apply` 里用 `ctx.effect` / `ctx.on` 注册并返回清理。
- **手写的 bundle 没有 CSS Modules、没有 CSS 打包**：样式用（a）`ctx.effect` 里创建 `<style>`（如上），（b）组件内渲染 `<style>` React 元素，或（c）如果当前形态提供 `styles.insert(css)`（见下文「dynamic half」）就用它。
- **不要** `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何 `@deepseek-ai/dsh-client-*` 包：它们无预警变更，plain-JS 没有类型检查，组件一抛错整个槽位条目白屏（控制台 `slot entry crashed in '<slot>'`）。需要的控件照抄宿主原语的标记与行为，类名换成自己的前缀。
- **不要**替换应用根、**不要**向 `document.body` 追加第二个应用、**不要**读写别的插件的 DOM/样式、**不要**用 iframe（iframe 拿不到主题 token、明暗切换与 `ctx.locale`）。

### 2.1 另一种形态：dynamic Client half

除了 bundle 的 `client.js`，还有一种由 Agent 在运行时定义的"动态半侧"，它看到的是**另一套符号**（`cordis_inspect_query { platform: "client", provider: "Builtin", method: "listBuiltins" }`）：

| 符号 | 签名 | 说明 |
|---|---|---|
| `ctx` | `ctx.get(name)` / `ctx.on(name, listener)` / `ctx.provide(name, value)` / `ctx.effect(cb, label?)` | 受限的 Cordis Context |
| `React` | `React.createElement` / `React.useState` / `React.useEffect` | 未做 JSX 转换 |
| `host` | `host.call(method: string, args?: JsonValue): Promise<JsonValue>` | **本包私有的 Client → Host JSON RPC** |
| `styles` | `styles.insert(css: string): () => void` | 随 Client 运行清理的样式插入 |
| `console` | `console.log` / `console.error` | 带包标签的日志 |

⚠️ **两套面不通用**。`Builtin` 列的是**动态半侧**能用的符号；bundle 的 `client.js` 走的是 `require` 模块表（见 §6 的 `dsh.client.external`）。若你想在手写 bundle 里用 `host.call` 这类动态半侧能力，**先用 `Builtin` 与 `Slots`/`Service` 的现场查询确认它在你的形态里可用**，不要假设。

---

## 3. 槽位：先查，再选

### 3.1 注册 API

```js
ctx.slots.inject(ownerKey, () => ctx.slots.register(options, Component))
```

- `ctx.slots.inject(key, callback)`：**为槽位的每个声明生命周期安装一个 effect**。声明已存在时回调**同步**运行；否则在该声明 `register()` 提交后于其中运行。声明折叠时 effect 被释放，之后再声明会重新运行。回调的 effect 是同步 disposer；返回可迭代对象时会事务化安装、逆序释放。
- `ctx.slots.register(options, Component)`：普通注册 API。**必须**由调用者的 `ctx.effect` 拥有（fiber 卸载即级联清理）。
- `options`：`name`（槽位名）+ 该槽位 kind 要求的额外字段——**`list` 需要 `id`，`keyed` 需要 `key`**；可选 `order`（升序）、`label`（`string | (() => string)`）、`locale`（字典命名空间）。
- **不要传 `priority`**：浏览器半 facade 会自动赋一个**低于所有宿主条目**的优先级；在 single/keyed 单元里这等于"你的条目就是渲染出来的那个"。所以**只有在你确实想要遮蔽宿主 UI 时才复用它的 key**。
- 槽位只在**声明它的条目挂载期间**存在；向未声明的槽位注册会抛。注册失败会出现在浏览器半的加载报告里。

### 3.2 本项目的落点（已确认机制）

| 槽位 | kind / scope | 用途 | 我们的用法 |
|---|---|---|---|
| **`main`** | keyed / **root** | 中央面板，"由 sidebar 条目 id 选中"。**保留 key `conversation` 承载会话；其它 key 没有 Session 绑定** | ★★★ 日历主页面：`{ key: 'schedule-calendar' }` |
| **`sidebar.panellist`** | list / **root** | 全局面板图标。**每个 list id 对应同名的 main 面板**；侧栏拥有按钮并从 list 元数据解析标签 | ★★★ 导航入口：`{ id: 'schedule-calendar', label, order }` |
| `settings.section` | list / root | 每个条目一个设置页（`id` 是 section key、`order` 位置、`label` 显示文本）。**条目可声明子槽位** | ★★★ 「日程设置」整页（核心），内部再开 `schedule.settings.blocks` |
| `schedule.settings.blocks` | list / root | **本项目自定义**：`settings.section` 条目 `children` 声明的子槽位，核心的设置页在自己两张卡之后 `renderSlot` 它 | ★★★ 北航适配器往里塞学号/同步两张卡 |
| `schedule.entry.actions` | list / root | **本项目自定义**：`main` 日历条目在 `children` 声明的子槽位，条目编辑器以 `{ entry }` 为 owner props `renderSlot` 它；只在编辑已有条目时渲染 | ★★ 北航来源注册「远程签到」按钮 |
| `settings.general.item` | list / root | General 里的**单个偏好行**（不投影 label，owner 不传 props，文案与写入都由你自己负责） | ★★ 单个开关 |
| `shell.overlay` | list / root | 全窗口浮层，在每列之上、滚动容器之外；**层本身点击穿透**，条目需自己 opt-in 指针事件 | ★★ 提醒 toast |
| `conversation.composer.dock` | list / session | 输入框卡片下方的环境条目（无 owner props） | ★ 会话内小挂件 |
| `conversation.input.dock` | list / session | 输入框卡片上方整宽条目（owner props = `InputZone`） | ★ |
| `tool.call.toolview` | keyed / session | 按线上工具名分派的工具卡片（见 `06` §9） | ★★ |
| `root` | single / root | **绝对不要注册**：single 槽位里第二个条目会**遮蔽**整帧（且自动优先级让你赢），页面会只剩你的组件，所有 seat 消失 | ✖ |

**id 的三重身份**（这就是 `sidebar.panellist` 与 `main` 的绑定方式）：

- `sidebar.panellist` 的注册 `id` = 该 list 的 cell key = `SidebarPanelMetadata.id` = `PanelInfo.activePanelId` = **`main` 的 `key`**；
- `label` 只做显示与可访问名（省略时用 id）；
- `order` 只决定行序；
- **图标就是那个注册的组件本身**。

**参照实现（强烈建议直接读源码）**：宿主自带的 `@deepseek-ai/dsh-client-ui-schedule` 就是"一个 main 面板 + 一个 sidebar 图标 + 用 Remote 读写 Host"的活样本，注册的正是 `main` 的 `key: 'schedules'` 与 `sidebar.panellist` 的 `id: 'schedules'`，客户端 `inject` 为：

```
'slots', 'locale', 'remote', 'remote.schedule', 'conversation', 'uiConversation', 'uiWorkspace', 'sessions'
```

用 `Config.listConfigs { name: "@deepseek-ai/dsh-client-ui-schedule" }` 拿到 `packageDir`，读它的 `lib/types/**/*.d.ts` 与实现。

### 3.3 组件 props = owner 份额 + key 份额 + inject 份额 + scope 标准套件

```
PropsRuntime<K> = OwnerOf<K> & KeyPropsOf<K> & SlotInjectFace<SlotInjectOf<K>> & ScopeStandardProps<ScopeOf<K>>
```

我们关心的两类：

**root scope 的标准套件**（`main` / `sidebar.panellist` / `settings.section` / `shell.overlay` 都会收到）：

```
useResource, useWorkspaces, usePanelInfo, useSessions, useSessionStatus, useSessionRetainInfo
```

- `sidebar.panellist` 的 owner 份额：`{ size: number; active: boolean }`（请求的方形边长 / 是否在中央列被选中）。
- `settings.section` 的 owner 份额：`{ close: () => void }`（关闭设置面板）。
- `shell.overlay` 与 `conversation.composer.dock`：**没有 owner 份额**（渲染点传 `{}`）。
- 注册里声明 `children` 的条目，props 会多出 `renderSlot('<child>', input)`。本项目用它在「日程设置」里开子槽位：
  核心的 `settings.section` 条目声明 `children: { 'schedule.settings.blocks': { kind: 'list', scope: 'root' } }`，
  页面里 `renderSlot` 它；北航适配器（或未来任何来源）用 `ctx.slots.inject('schedule.settings.blocks', …)`
  往里注册卡片——**一个设置页，多来源追加**，不需要各自占一节。
- `conversation.input.dock` 的 owner 份额：`InputZone = { session: SessionSnapshot; input: InputState }`。
- 声明了 `locale` 的注册会在 props 上多一个 `t`；声明了 `inject` 会多出对应份额。
- 选择器钩子要**传选择器**调用，例如 `useSessions(state => state.current)`。**订阅最小的那一片**。

**不要猜 props**：先 `Slots.listSubTree` 传 `root: "<槽位名>"`，返回的 `selected.catalog` 里有 `registration`（含每个字段的 `description`）、`ownerProps`、`ownerPropsReferences`、`standardProps`、`keyDomain`、`allowedKeys`、`hookContext`、`slotInject`、`replaceRisk`——那就是权威说明。

> 槽位目录是**已发布 Web 包的编译期契约**，不是某一页的快照：`occupants` 列的是**随包发布**的组合。现场占用者（含优先级与是否 active）要读 `selected`。
> Client inspect 查询可能超时（报 `Client inspect query … timed out after 10000ms`）：**先打开/重连 Harness 页面再重试**，不要据此推断"没有这个槽位"。

---

## 4. 样式：shell 主题 token 与配置类别配色

宿主负责主题：`@deepseek-ai/dsh-client-ui-theme` 拥有 `--dsw-*` 静态色阶、语义别名、排版、动效、阴影、滚动条与明暗偏好；`ui-layout` 把解析后的快照应用到文档。**插件必须用语义别名，不得另立全局主题**（`ctx.theme.register(definition)` 是"注册一套主题"，插件不该用）。

### 4.1 `Theme.listTokens` 报出的 14 个内建 token

全部 `valueType: "CSS color"`、`requiresLightAndDark: true`：

`--dsw-alias-bg-base`（应用底色）、`--dsw-alias-bg-layer-1`（一级抬升面）、`--dsw-alias-bg-layer-2`（二级嵌套面）、`--dsw-alias-bg-overlay`（浮层/弹层底）、`--dsw-alias-border-l1`（一级细边框）、`--dsw-alias-border-l2`（二级更强边框）、`--dsw-alias-brand-primary`（品牌主色）、`--dsw-alias-label-primary`（主文字）、`--dsw-alias-label-secondary`（次文字）、`--dsw-alias-state-error-primary` / `--dsw-alias-state-success-primary` / `--dsw-alias-state-warn-primary` / `--dsw-alias-state-idle-primary`（四态）、`--dsw-specific-sidebar-fill`（侧栏列与标题行底色）。

> 这份列表是**给检查用的内建目录**，不是全部 CSS 变量：主题样式表里还有更多别名族（`--dsw-alias-border-l3/l4`、`--dsw-alias-link`、`--dsw-alias-bg-layer-3`…）以及圆角/阴影/设置卡片等 token（见下）。要用某个 token 前，先在已连接页面里查一下它是否存在或照抄同类宿主页面用法。

### 4.2 硬性规则

- **CSS Modules + `clsx`**（编译型插件）；**不得**引入组件库或 Tailwind。手写 bundle 没有 CSS Modules，就用 §2 的样式注入方式，类名带自己的前缀。
- shell 颜色、排版、层级、动效使用宿主 `--dsw-*` token；禁止复制静态 shell 色板，功能组件 CSS 禁止主题选择器。唯一颜色字面量例外是 `global.categories` 的用户配置 `#RRGGBB` accent：通过 `--bsch-block-color` 用于日历块和预览，小日历色点使用同一类别颜色。
- 字号必须与行高成对；源码/终端/diff 文本不换行；滚动条用共享样式，**不要**自定义组件专用滚动条选择器。
- 呈现规则写进 CSS；React 内联样式只能传组件局部自定义属性值，**不得**用它编码主题分支。
- 中性 `--dsw-alias-border-*` 的平面边框/分割线一律 **0.5px**；虚线记号与状态色边框保持 1px。
- 高浮起面：`border: 0` + `box-shadow: var(--dsw-elevation-panel | --dsw-elevation-prominent | --dsw-elevation-soft)`；**不得**把中性 border 与 elevation 阴影配对。
- 菜单用宿主的 `Menu` / `MenuSurface` 语义（`--dsw-menu-surface-fill`、`--dsw-menu-backdrop-filter`），功能 CSS **不得**覆盖它们；模态框保留黑色半透明遮罩（主题把 `--dsw-mask-blur` 设为 `none`）；链接用 `--dsw-alias-link` + `font-weight: 500`，hover/focus 为 3px offset 的点状下划线。
- 每个正圆（`50%`、胶囊半径）必须配对 `corner-shape: round`。

### 4.3 圆角统一规范

| 用途 | 典型尺寸 | 圆角 | token |
|---|---|---|---|
| 小细节（键帽、行内代码） | < H20 | R4 | `--dsw-radius-xs` |
| 紧凑控件 | H20–28 | R8 | `--dsw-radius-sm` |
| 标准控件/单行 cell | H32–40 | R12 | `--dsw-radius-md` |
| 大控件/分组内容 | 大按钮、多行 cell | R16 | `--dsw-radius-lg` |
| 独立内容卡片 | 设置卡片、消息气泡 | R20 | `--dsw-radius-xl` |
| 主容器 | 输入框、对话框、主面板 | R28 | `--dsw-radius-panel` |

- **不要**新增 10px / 14px / 18px / 24px 这类局部数值；普通圆角面用主题的 `superellipse(1.5)` 曲线。
- 同心内缩：内层 R = `max(0, 外层 R − 内缩距离)`，用同一曲线。
- 标准菜单：外层 R16、4px 内边距、R12 菜单项；紧凑菜单：外层 R12、4px 内边距、R8 菜单项。
- 设置卡片材质：

```css
.card {
  border-radius: var(--dsw-radius-xl);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
}
```

（主题在 `body` 上把卡片底色解析为 `--dsw-alias-bg-layer-2`、描边解析为 `--dsw-alias-border-l4`；不要再叠一层中性边框，也不要仅为区分 tab 就加阴影。）

**间距没有官方尺度**：官方样式文档只有具体数值（如菜单 4px 内边距）。做法是**照抄同类宿主页面**——管理类列表以 Plugin Manager 页面为参照。

---

## 5. 从 Client 调 Host：三条路径

Client 半**不能** import Host 代码。通路有三条：

### 5.1 复用宿主**已有**的 Remote 命名空间（第一版用这个）

```js
export const inject = ['remote', 'remote.schedule']   // 同时声明 remote 与 remote.<ns>

const result = await ctx.remote.schedule.list({ sessionId });
if (!result.ok) {
  if (result.error.code === 'schedule_not_found') return [];
  throw result.error;                                  // 它是真的 Error
}
use(result.value);
```

- `ctx.remote.<namespace>.<exportName>(...)`：Host 侧 `class X extends TypertRemoteService`（`super(ctx, '<serviceKey>', { namespace: '<ns>' })`）+ `@Remote('export')` 标注就生成这个名字空间；`Remote` 只接受 `string`（导出名）或 `{ mode: 'stream' }`。
- 调用点直写 `ctx.remote.<ns>.<method>(...)`；**不要** `Pick<ClientRemote, …>` 窄化、不要手写签名、不要自造 wire 中转对象。
- 结果是 `RemoteResult<T>`：`{ ok: true, value } | { ok: false, error: { code, message, details? } }`。**判 `code` 而不是 `instanceof`**（判 code 会自动窄化 `details`）。
- 异常流的站点写 `throw result.error`；上层用 `isRemoteFailure` 区分 Remote 失败与本地缺陷。**不要写防御性 catch**——Remote 调用不 reject，装配错误就该炸。
- 流式：Host 用 `@Remote({ mode: 'stream' })` 返回 `AsyncIterable<T>`；客户端消费生成的名字空间成员或 `ctx.remote.$stream`。
- Host 固定事实：`ctx.remote.$host` = `{ home: string | undefined; isLoopback: boolean }`。
- 重连后刷新走 `ctx.on('connection/reset')`。

**已确认可用的命名空间举例**（客户端 `inject` 里出现的字面量）：`remote.commands`、`remote.schedule`、`remote.session`、`remote.workspace`、`remote.goals`、`remote.userQuestions`。完整名单用 `Service.listService`（带 `@Remote` 的方法就是）。

### 5.2 用人类命令承载"UI 动作"

Host 侧 `ctx.commands.register({ name, description, input, handler })`（见 `05` §5），Client 侧 `ctx.remote.commands.execute(agent, line, submittedAttachments, signal)`。

优点：不用自造 Remote 端点，且有真实日志（`command/run` / `command/done`）。
限制：`execute` 需要一个 `Agent`——**只有 session 作用域的槽位才拿得到**；根作用域的 `main` / `sidebar.panellist` / `settings.section` 拿不到。所以这条只适合会话内的 UI 动作。

### 5.3 自造 Remote 端点（重量级）

官方五步：声明方法（`TypertRemoteService` + `@Remote`，`Agent`/`Session` 之类的 lookup 参数只能占顶层参数位，`signal: AbortSignal` 放最后）→ 声明失败（统一 `RemoteError(code, message, details)`，域码用 declaration merging 进 `RemoteErrorDetailsMap`，命名 `<域>/<理由>`）→ 在包上注册（补 `./typert` 与 `./remote` 两个导出 + `@deepseek-ai/dsh-typert-protocol` 的 peer 依赖）→ Client 消费 → 写测试。**改签名/码表/namespace/导出名之后必须重跑 `pnpm run build:lib`**，Client 才拿得到新的声明与 codec（只改实现体不需要重新生成）。

⚠️ 这条链路依赖 DSH 仓库里的生成链。**本仓库手写的 plain-JS bundle 没有这条链**，第一版不要规划自造 Remote 端点；若确实需要，先决定是否把 bundle 改成带构建的包（并用 `Config.listConfigs` 拿到的 dsh `packageDir` 对齐版本），或改用下面这条。

### 5.4 自己开 HTTP 路由：`webServer` 与 `connection.fetch` 是两条不同的路

- `ctx.webServer.register({ kind: 'prefix', path: '/…' })`（见 `02` §2.9）：**无鉴权**（README 原话 "carries no TLS, authentication, or origin policy"），不要承载业务写。
- **本插件采用的写路径**：`ctx.connection.fetch.register()` 在共享 `/api` 前缀的 Fetch 注册表上挂精确路由（`/api/schedule-core`）。浏览器信任围栏 + 签名 cookie 鉴权**先于**插件 handler（`ConnectionFetchRoute` 文档："Handle one request after the physical carrier has applied its trust and authentication policy"），与 Remote RPC 同级可信。host 侧实现见 `host/api.js`；这就是 root-scope 页面（`main` 非 conversation key）的完整读写通道，手写 bundle 不需要 §5.3 的生成链。

---

## 6. 文案（Client locale）

```js
export const inject = ['slots', 'locale']

ctx.effect(() => ctx.locale.register('scheduleCore', {
  zh: { title: '智能日历', sync: '导入日程' },
  en: { title: 'Smart Calendar', sync: 'Import entries' },
}), 'schedule: dictionaries')

// 注册时声明 locale，组件 props 就会多出 t
ctx.slots.register({ name: 'main', key: 'schedule-calendar', locale: 'scheduleCore' }, Page)
// Page({ t }) { return t('title') }
```

契约要点：

- `register(ns, dicts)`：**声明式命名空间**的形式，`dicts` 必须给**每个内置 locale**（双语平衡在注册时强制），每个字典会被检查覆盖该命名空间的 key 全集；重复 `(ns, locale)` 抛错。
- `register(ns, locale, dict)`：单语言非类型化形式（语言包、合并表之外的命名空间）。字典是**扁平 `Record<string, string>`**，键是点分字符串（如 `'copy.optionsHint'`），支持 `{placeholder}` 插值。
- `bind(ns)`：绑定到某个命名空间的 translate 函数（同一命名空间重复 bind 返回同一函数，可以放进 inject 面而不破坏记忆化），在**调用时**读当前 locale。
- `getLocale()` / `getSnapshot()`（带 `revision`，引用稳定，uSES 安全）/ `subscribe(fn)` / `setLocale(id)` / `addLanguage({ id, label, fallback })`。
- 查找顺序：按活动语言声明的 fallback 链在该命名空间里查，然后在共享 `common` 命名空间里重来一遍，最后显示 key 本身。
- 要让自己包的命名空间有类型，用 declaration merging 扩 `LocaleNamespaceMap`。
- Client 事件只有四个：`connection/reset()`、`locale/change(snapshot)`、`slots/changed(key)`、`theme/change(snapshot)`（都是 `emit`）。注意 `locale/change` **不会**在字典注册时发出——渲染刷新走 LocaleFace 的 `revision`。

---

## 7. 生命周期与释放

- 注册都是 effect：`ctx.effect(cb, label?)`、`ctx.on(...)` 随插件卸载自动移除。
- 组件卸载时，它渲染的局部样式元素和自建监听必须消失。定时器用 `ctx.timer`（随 fiber 释放），不要裸 `setInterval`。
- 插件 UI 是**宿主 UI 的一部分**：用户看到的是**一个**应用，所以必须用宿主的主题、locale 与布局惯例，并与同类宿主页面保持一致。
- 被释放后再调用生命周期相关的 effect 会抛 `CordisError('INACTIVE_EFFECT')`；结构非法抛 `TypeError`。**不要**自己调用属于生命周期的 disposer。

---

## 8. 与旧 Vue 实现的对应关系

当前类别 UI 读取 `snapshot.global.categories` 有序定义（稳定 id、可改名、`#RRGGBB` 颜色，默认七项见 `00` §3.3）。已有列表不恢复删除预设；`other` 固定名“其它”、不可删但可改色。设置页原生颜色选择器即时预览同款日历块，增改删后显式 `setCategories` 保存；删除确认说明已有条目改归 `other`。未保存草稿与普通 metadata 独立，错误、来源刷新、学期保存不覆盖草稿，导入后重读 metadata。

编辑器、批量编辑器、周网格及小日历使用动态选项/名称/颜色；已打开编辑器和撤销恢复遇已删除类别时归 `other`，恢复失败展示可重试错误。单个与批量编辑器共用紧凑 `role="switch"`，单一标签“锁定（不可拖动）”，支持键盘，锁仅影响快捷移动/缩放。当前实现的离线 VM 测试不构成浏览器、主题或鼠标命中验证。


迁移已完成；旧组件的**交互意图**（拖选新建、时间轴范围、撤销重做、任务筛选……）逐条清单与现状偏差见 `10-ui-parity-rework.md`，旧文件地图见 `00-architecture.md` §7。仍在生效的两条规则：不要改宿主 DOM（标题等由自己的组件渲染）；拖拽/撤销等交互状态放组件本地，写操作走 Host 服务方法。

---

## 9. 交付前自查

- [ ] `client.js` 的 `id` 等于包名；`exports["./client"]` 指向它；`dsh.client.platform === "web"`。
- [ ] `factory` 无副作用；没有 `require` 任何 `@deepseek-ai/dsh-client-*` 包。
- [ ] 槽位名与注册字段（`id` / `key` / `order` / `locale`）由 `Slots.listSubTree` 现场确认过；**没有**注册进 `root`。
- [ ] 组件 props 来自 `selected.catalog`（`ownerProps` / `standardProps`）或 owner 的类型文件，没有猜。
- [ ] **没有**传 `priority`；复用宿主 key 是**有意**遮蔽。
- [ ] `sidebar.panellist` 的 `id` 与 `main` 的 `key` **完全一致**。
- [ ] shell 样式使用 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-elevation-*`；类别配置的 `#RRGGBB` accent 是唯一颜色字面量例外；无主题选择器；边框 0.5px；圆角用 token。
- [ ] 明暗两套主题都读过；控制台无 `slot entry crashed`。
- [ ] 文案走 locale；组件卸载后无残留样式/监听/定时器。
- [ ] 写操作只有一条路径（Host 服务方法），UI 与 CLI 没有各写一套。
