# 01 · 插件解剖：bundle、清单、patch、安装与生命周期

> 本文档描述 DSH（DeepSeek Harness）的插件形态。DSH 的架构是 **everything is a plugin**：Harness 本体、Web UI、工具、界面槽位都是插件，由 Cordis Loader 按 profile 组合。
> 事实基线：本机 checkout `D:\deepseek-harness`，版本 `@deepseek-ai/dsh-root@0.2.0-rc.2`。**运行时才是权威**——任何签名/事件/槽位都可用 `cordis_inspect_query` 现场核对（见 `02-host-api.md` 与 `09`→已并入 `02`）。

---

## 1. 三个层次：package → bundle → plugin row

| 概念 | 是什么 | 载体 |
|---|---|---|
| **plugin** | 一个导出 Cordis 插件的 JS 模块（函数或 Service 类） | `index.js`（Host 半）/ `client.js`（Client 半） |
| **bundle** | 一个 npm 包，用 `package.json` 声明 `dsh.bundle.patch`，用 YAML patch 把若干 plugin row 插进 Loader 组合 | 包目录 |
| **profile** | 用户当前的插件组合（一组有序的 patch 层叠加在 bundle 的 row 列表上） | `$DSH_PROFILE_DIR` |

一个 bundle 可以只含一个 plugin row，也可以插入多行。**本项目的迁移目标就是产出一个 bundle**。

---

## 2. 最小可用 bundle（Host-only）

目录（建议放在本仓库内，例如 `dsh-plugin/buaaer-schedule/`）：

```
buaaer-schedule/
├── package.json          # bundle 清单
├── cordis.patch.yml      # 把本包的 row 插入 profile
└── index.js              # Host 半：插件本体
```

`package.json`：

```json
{
  "name": "@buaaer/dsh-schedule",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: buaaer-schedule
      name: '@buaaer/dsh-schedule'
      config: {}
```

`index.js`（函数形态）：

```js
export const inject = ['tools'];           // 可选：声明硬依赖
export function apply(ctx, config) {
  // 所有注册都通过 ctx.effect / ctx.on，返回值就是卸载时的清理函数
  ctx.effect(() => ctx.tools.register({ /* ... */ }));
}
```

要点：

- Host-only 的 bundle **不需要** dependencies、install 脚本或构建工具；`index.js` 就是源码。
- 包与 row 的 `id`、`name` 都要唯一。插入的相对路径以 patch 文件所在目录为锚点解析。
- 一个 Host-only bundle 也可以什么都不做（`export function apply() {}`），把渲染交给 Client 半——见 `03-client-ui.md`。

---

## 3. patch 方言（Loader YAML）

patch 是**有序的层**，逐层叠加在 bundle 的 row 列表上。一条 patch 是如下映射：

| 写法 | 语义 |
|---|---|
| `insert: [rows]` | 追加 row；若带 `id` 且该 id 指向一个 `group: true` 的 row，则插入那个 group 的 `config` 列表内部 |
| 带 `id`、不带 `insert` | 覆盖同 id 的既有 row。**提供的字段整体替换该字段**，`config` 是整体替换、绝不深合并——必须把所有需要的字段重新写全 |
| 带 `name`（真值） | 断言既有插件的名字，而不是改名 |
| 不带非空 `id` 且不是 insert | 会被警告并跳过；找不到目标 row 同样警告并跳过 |

row 的字段：

| 字段 | 含义 |
|---|---|
| `id` | row 标识（覆盖/插入的锚点） |
| `name` | 插件包名（npm 说明符） |
| `config` | 传给插件的配置对象（由插件的 `Config` 校验） |
| `disabled` | 布尔值、`null`，或 `!!js` 表达式；禁用行可以省略必需的 `config`（除非 `group: true` 强制激活） |
| `inject` / `intercept` / `isolate` | 依赖与作用域控制 |
| `group: true` + `name: cordis:group` | `config` 是嵌套 row 列表，允许其它 patch 按 id 插入其中 |
| `name: cordis:include` | 从 `config.path` 读入一个字面量 YAML/JSON row 列表 |

`!!js` 标量是 Loader 表达式（注意**不是** `!js`）。在 `config` 内部，它们在该 row 声明的依赖激活**之后**求值，作用于该插件的 context，因此 `!!js dshHomePath('sessions')`、`!!js "!ctx.get('profileContext')"` 都是合法的。row 的其它元数据保持字面量。

`isolate` 把服务名映射到 `true` 或一个 realm 标签；提供某服务的 preset 插件会把提供者与其消费者一起隔离。**scope** 控制贡献与事件可见性；**isolate** 控制服务实例。

---

## 4. Host 半的导出形态

`index.js` 只能选**一种**形态，不要混用：

1. `export function apply(ctx, config) {}`，可另带 `export const inject = [...]` 与 `export const Config`。
2. `export default` 一个 Service 类。

> 反面教材：如果写成 `export default` 的函数/类，`export const inject` 会被丢弃（DSH 有对应事故复盘 `docs/postmortem/0001-acp-default-export-drops-inject.md`）。需要 `inject` 就用 §4.1 的函数形态。

### 4.1 资源注册与释放

**每一个**资源都必须在 `apply` 内通过 `ctx.effect` 或 `ctx.on` 注册，并让其清理函数成为返回值的一部分。插件卸载、agent 释放、槽位折叠、profile patch 变化都会撤掉注册在对应 context 上的东西——**context 决定生命周期**。

```js
export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register(definition));      // 卸载即反注册
  ctx.on('tools/change', () => { /* ... */ });            // 返回 disposer
}
```

如果注册挂到了**别的** context（例如 `agent.ctx`），那么它有两个所有者：既要把它登记进 `agent.ctx.effect()`，也要把该 disposer 放进本插件自己的 effect 里，这样任一侧卸载都能清理。

### 4.2 可选依赖不要写进硬依赖

放进 `inject` 的服务在本 profile 缺失时插件不会激活；可选能力应写成 `ctx.get('name')`（判空）或 `ctx.inject([...], ...)`，这样在没有该能力的 profile 里插件安静地处于非激活状态，而不是抛错。

---

## 5. Config：可调参数由用户 patch 提供

给插件加 `export const Config`（Standard Schema）后，Loader 在激活时用 row 的 `config` 校验；用户写在 `cordis.patch.yml` 里的值会覆盖默认值，并且**用户的 patch 层在升级后依然存活**。因此所有可调值（轮询间隔、提醒提前量、LLM 模型名……）都应进 `Config`，而不是写死在代码里。

```js
import Schema from '@deepseek-ai/schemastery'   // DSH 侧 schema 库

export const Config = Schema.object({
  syncIntervalMinutes: Schema.number().default(30),
})
```

精确写法、默认值、`volatile` 字段、`!!js` 计算值与"改配置会热替换插件"的语义见 `02` §4。

写 `config` 之前先查已安装插件的实际 schema：

```
cordis_inspect_query { platform: "host", provider: "Config",
  method: "listConfigs", input: { name: "@buaaer/dsh-schedule" } }
```

目录页给出每个 entry 的 id 与 Config 状态；再用 `input: { entry: "<id>" }` 取该 entry 的投影 JSON Schema（注意跟随返回文档里的 `$defs` 引用）。

---

## 6. Client 半（在 Web UI 里渲染）

在清单里加 `dsh.client` 段并导出 `./client`，浏览器半就会由 client module system 加载：

```json
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

- `dsh.client.platform`：`web`。
- `immediately`：引导第一阶段的注册屏障；**缺省表示随共享应用批次**加载。
- `inject`：**信息性的包名依赖**（决定 factory 到达与插件组合的顺序），**不是** Cordis 服务注入——Cordis 的 `inject` 是插件自己导出的数组。
- `external`：除隐式 client 基线之外**精确请求的模块表条目**（含 `<pkg>/client` 这类子路径）。
- `exports["./client"]` 指向浏览器产物。手写的 plain-JS 产物**不需要构建**：它就是一个调用 `window.__ModuleLoader__.load({ id, factory })` 的文件，`id` 必须等于包名。

**关键限制**：client 半只挂在说明符恰好是**裸包名**的那一行上。若把一个包拆成多行（子路径导出），只有根行带半侧，页面会随根行关闭而消失。需要独立生命周期的页面要单独发包。

细节、槽位与样式规则见 `03-client-ui.md`。

---

## 7. 安装、启用、观察

安装**不要**手写 profile 的文件，也不要手动跑 pnpm：

| 动作 | 工具 | 说明 |
|---|---|---|
| 安装 bundle | `plugin_manager` `action: "install_bundle"`，`target` = 该包目录的绝对路径 | 由它完成包安装与 bundle 选择 |
| 列出/启用/禁用 | `action: "list_plugins"` / `"set_plugin"` | 得到精确的 row id 后再切换 |
| 列出/启用/禁用 bundle | `action: "list_bundles"` / `"set_bundle"` | |
| 卸载 bundle | `action: "remove_bundle"` | |

`install_bundle` 可能报告 `pendingBuilds`：**只有在用户明确同意**后才把它传给 `approvedBuilds`。返回的失败与 pending 状态要原样保留；只有观察到能力真的可用才算成功。

判断是否生效，看返回值而不是日志：

- `application: applied` —— 变更已生效。
- `warnings` —— 逐条读。
- `failed` —— 必须排查。
- `overridden` —— 有更高优先级的层赢了（你的 patch 被别的层覆盖）。
- `restart-required` —— 变更**没有**上线。

补充语义：新装 bundle 可能经 HMR 直接激活；**替换**已安装的包需要重启才能加载新的 JS 模块代；slot id 没变**不能**推断浏览器代码已更新。

`plugin_manager` 的每个动作（包括 `list_plugins` / `list_bundles`）在没有完全权限时都需要审批，所以只在结果会影响下一步时调用。

---

## 8. 生命周期与 HMR 语义（速记）

- 注册 = 属于某个 context 的 effect；谁注册谁负责，卸载即撤销。
- 插件代码/配置的**热更新**由 `@deepseek-ai/dsh-hmr` 协调；`app-boot/config-reload` 事件表示 profile patch 已对齐到运行中的 Loader 树。
- **已安装包的替换**要重启进程才换新模块代。
- 浏览器半的重建由 Client 构建链负责；只有 `pnpm run dev:web` 正在运行时才会自动重建并热替换，否则改完要重建 Web 产物并刷新页面。
- 不要另起一个服务器来"验收"自己的改动——那验证的不是用户正在看的那个 GUI。

---

## 9. 本仓库里怎么放

建议目录（后续工作者可依此落地）：

```
BUAAer-Smart-Schedule/
├── docs/dsh-plugin/            # 本文档集
├── dsh-plugin/
│   └── buaaer-schedule/        # 迁移产出的 bundle 包
│       ├── package.json
│       ├── cordis.patch.yml
│       ├── index.js            # Host 半：服务、工具、定时、存储
│       ├── client.js           # Client 半：日历/四象限/设置页面
│       └── locale/zh.json      # 显示文案（Plugin Manager 卡片、UI 文案）
└── electron/ backend/ frontend/  # 迁移期间保留的旧实现，逐步废弃
```

bundle 目录名与包名一旦安装就与 profile 绑定，改名等于重新安装。

---

## 10. 硬性禁止（踩了就坏）

- ❌ 手写 profile 的 `package.json` / `cordis.patch.yml`，或在 profile 目录里跑 pnpm；`install_bundle` 会代劳。
- ❌ 在 `$DSH_HOME` 下创建包。
- ❌ 让插件给 Session 日志追加**新的事件类型**（`ignorable: true` 只对已存盘事件有效，`Session.append()` 设不了该标记，Session 会拒绝重开）。
- ❌ 在 Client 半里 `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何 DSH Client 包（见 `03-client-ui.md`）。
- ❌ 用 iframe 承载插件页面（拿不到主题 token、明暗切换与 `ctx.locale`）。
- ❌ 轮询 `agent/status`、直接写 DOM、向 `document.body` 追加第二个应用。
- ❌ 把可调参数写死在代码里而不是 `Config`。

---

## 延伸阅读（官方文档）

本机 checkout 内有官方中英文文档，在线站点为 <https://deepseek-harness.github.io/deepseek-harness/>。与本文件对应：

| 主题 | 本地路径（本机 checkout） |
|---|---|
| 第一个插件 | `docs/user/develop/basic/index.zh.md` |
| 插件配置 / Config | `docs/user/develop/basic/config.zh.md` |
| 打包与安装插件 | `docs/user/develop/basic/publish.zh.md` |
| 插件与生命周期 | `docs/user/develop/framework/index.zh.md` |
| 服务与依赖 | `docs/user/develop/framework/service.zh.md` |
| 事件系统 | `docs/user/develop/framework/events.zh.md` |
| Cordis 教程（7 章） | `docs/cordis-tutorial/*.zh.md` |
| 能力 seam 总表 | `docs/capability-seams.zh.md` |
| 术语表 | `docs/glossary.zh.md` |
