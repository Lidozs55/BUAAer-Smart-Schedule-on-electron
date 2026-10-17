# DSH 插件迁移开发文档

本目录是把 **BUAAer 智能日历（Electron + Flask + Vue）** 迁移为 **DSH（DeepSeek Harness）Cordis 插件** 的开发参考。
写作前提：**读者此前没有接触过 DSH 插件开发**。所以这里既有"这个项目该怎么落地"，也有"DSH 侧接口到底长什么样"。

> **实现现状（2026-10-17）**：迁移代码已落地于仓库根的 `dsh-plugin/buaaer-schedule/`（主插件，提醒子系统含于其中），决策结论与离线验证记录见 `00` §7.1/§7.2；运行时验收未开始。

---

## 30 秒速览

现在的形态是三件套：Electron 壳 + Flask HTTP 服务（5000 端口）+ Vue SPA，数据在 SQLite 里，提醒靠前端每 60 秒轮询。
迁移目标是**一个 Cordis bundle**：

| 现在 | 迁移后 |
|---|---|
| Flask 路由 + SQLAlchemy | **Host 半**：同进程的服务方法 + 存储 domain + durable 提醒 |
| Vue SPA + Pinia | **Client 半**：宿主 Web UI 槽位里的 React 页面；写操作全部走 Host |
| 桌面壳（托盘/悬浮窗/窗口控制） | 大部分**没有对应物**（见 `07` §5），不要硬搬 |
| cpolar / 手机端 SPA | 删除 |

一个 bundle 两个半：`index.js`（Host）+ `client.js`（浏览器），`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`。

---

## 文档地图

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| `00-migration-checklist.md` | **执行台账（v2）**：本轮拍板 R1–R11、原子功能取舍总表、数据模型定稿、接口面、组件树、决策点 D-1–D-6、里程碑 M0–M6 | **立项与每次交付前后**；范围以它为准 |
| `01-plugin-anatomy.md` | bundle / 清单 / patch 方言 / 安装启用 / 生命周期与释放 / HMR 语义 / 硬性禁止 | **第一个读**，动手前必读 |
| `02-host-api.md` | 怎么用 `cordis_inspect_query` 查证；`inject` vs `ctx.get`；本项目要用的 Host 服务速查；事件与五种分发模式；`Config` 写法 | 写 Host 代码前；查签名时 |
| `03-client-ui.md` | Client 半的清单与产物格式；可用槽位；组件 props；主题 token 与样式规范；i18n；Remote 调用 | 写任何 UI 前 |
| `04-data-and-state.md` | 数据放哪里（Session 投影 / 存储 domain / 凭据 / 配置 / 文件）；本项目 4 张表的迁移设计 | 设计数据结构时 |
| `05-time-and-background.md` | `ctx.timer` / `ctx.jobs` / `ctx.schedule` / 人类命令；提醒与长任务怎么做 | 做提醒、同步、后台任务时 |
| `06-tool-and-agent.md` | `defineTool` 与 `ToolDefinition`；描述与 schema 规范；"一个操作两个调用者"；扩展点强弱；反模式 | 要暴露能力给 Agent 时 |
| `07-migration-map.md` | 逐个功能/路由/组件的落点映射（**v1 底稿**，范围以 `00` 为准）；不要迁移的东西；既有缺陷清单；M0–M5 阶段 | 查"现有资产在哪"时 |
| `08-workflow-and-verification.md` | 六步开发循环、自检清单、安装与返回值语义、验收清单、排查表、禁忌汇总 | 每次交付前 |
| `09-vivarium-bridge.md` | 桥插件设计备忘：主插件（含提醒子系统）与桥的职责边界、拖拽收纳与提醒气泡两条已定联动、接口约定与候选增强（未立项） | 立项桥 / 动提醒子系统对外接口时 |

推荐路线：

- **完全新手**：`01` → `02` → `03` → `04` → `05` → `06` → `07` → `08`。
- **只做 Host（服务/存储/提醒/工具）**：`01` → `02` → `04` → `05` → `06` → `08`。
- **只做 UI**：`01` → `03` → `02`（只看 §1 与需要的服务）→ `08`。
- **只想排期**：`07` → `01` §7（安装与返回值语义）。

---

## 事实基线与核对方式

- 本机 DSH checkout：`D:\deepseek-harness`，版本 `@deepseek-ai/dsh-root@0.2.0-rc.2`，Node `^22.19.0 || >=24.0.0`，pnpm `11.7.0`。
- DSH 处于 **developer preview**："THERE WILL BE COMPATIBILITY-BREAKING CHANGES"。本文档里的签名是**实测快照**，升级 DSH 后必须重新核对。
- **运行时是权威**。任何服务方法、事件、槽位、主题 token 都能现场问出来：

```
cordis_inspect_query { platform: "host",   provider: "Service", method: "listService", input: { service: "storageDomain" } }
cordis_inspect_query { platform: "host",   provider: "Event",   method: "listEvents",  input: { event: "tools/pre-execute" } }
cordis_inspect_query { platform: "host",   provider: "Config",  method: "listConfigs", input: { name: "@deepseek-ai/dsh-storage-domain" } }
cordis_inspect_query { platform: "client", provider: "Slots",   method: "listSubTree" }
cordis_inspect_query { platform: "client", provider: "Theme",   method: "listTokens" }
```

`Config.listConfigs` 返回的 entry 里带 `packageDir`——**那就是读那个包 README 与 `lib/types/**/*.d.ts` 的入口**。

### 官方文档入口（强烈建议交叉阅读）

在线站点：<https://deepseek-harness.github.io/deepseek-harness/>。本机 checkout 里有中英双语原文：

| 主题 | 本地路径 |
|---|---|
| 第一个插件 / 插件配置 / 开发一个工具 / 打包与安装 | `docs/user/develop/basic/{index,config,tool,publish}.zh.md` |
| 插件与生命周期 / 服务与依赖 / 事件系统 | `docs/user/develop/framework/{index,service,events}.zh.md` |
| Cordis 教程（7 章） | `docs/cordis-tutorial/*.zh.md` |
| 能力 seam 与核心服务总表 | `docs/capability-seams.zh.md` |
| 后台任务运行时 / 用户命令 / 文件系统 / 凭据 / 设置表单 | `docs/subsystems/{jobs,commands,filesystem,credentials,settings}.zh.md` |
| Schedule 提醒（用户视角） | `docs/user/guide/schedule.zh.md` |
| 工具编写 / Remote API / 设置卡片 / 扩展形态 | `docs/cookbook/{adding-a-tool,adding-a-remote-api,adding-a-settings-card,extension-cookbook}.zh.md` |
| Web UI 样式参考 / 统一圆角规范 | `docs/web-styling.zh.md`、`docs/ui-radius.zh.md` |
| 术语表 / 架构 | `docs/glossary.zh.md`、`docs/architecture.zh.md` |

---

## 术语表（够用版）

| 词 | 含义 |
|---|---|
| **bundle** | 一个 npm 包，用 `dsh.bundle.patch` 把若干 plugin row 插进 profile。迁移的产出物就是它 |
| **plugin / row** | 一个插件模块；profile 组合里的一行（有 `id` / `name` / `config` / `disabled`） |
| **profile** | 用户当前的插件组合（有序 patch 层），存在于 `$DSH_PROFILE_DIR` |
| **patch** | 一层 YAML：`insert` 追加 row，按 `id` 覆盖既有 row（`config` 整体替换、不深合并） |
| **fiber** | Cordis 的插件生命周期单元：`PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`（失败进 `FAILED`） |
| **effect** | `ctx.effect(fn)`：`fn` 立即执行、返回的清理函数在卸载时执行。**所有注册都该是 effect** |
| **inject / ctx.get** | 硬依赖（缺失则不加载）/ 可选读取（缺失返回 `undefined`） |
| **seam** | 抽象能力接口（如 `ctx.fs`、`ctx.jobs`、`ctx.credentials`），具体实现由别的包提供 |
| **slot** | 宿主 UI 里可被插件占用的位置；分 `single` / `list` / `keyed` / `chain` |
| **token** | 主题变量，`--dsw-*`；`--dsw-alias-*` 是语义别名（唯一该用的那类） |
| **domain** | `ctx.storageDomain` 上受 zod schema 校验的 KV 持久单元（`defineDomain` / `domainTable`） |
| **Remote** | Host 与 Client 之间的类型化调用通道（`@Remote` 标注 + `ctx.remote.<namespace>.<method>`） |
| **PTC** | 工具以代码形式呈现（`run_code`）；工具返回的 canonical value 会被当 API 用 |
| **会话事件 vs Cordis 事件** | `turn/*`、`tool/result` 等是**持久会话事件**；`tools/result`、`session/event` 是 **Cordis 事件**。别混 |

---

## 本仓库约定

- 文档语言：中文；**所有标识符、签名、token 名保持英文原样**，不要翻译。
- 迁移产出的 bundle 建议放 `dsh-plugin/buaaer-schedule/`（见 `01` §9）。旧实现（`electron/`、`backend/`、`frontend/`）在对应阶段验收通过前保留。
- 包名建议带个人/组织前缀，例如 `@buaaer/dsh-schedule`；row id 与包名一旦安装就与 profile 绑定，改名等于重装。
- 不要把 DSH 侧文档整段抄进代码注释：注释写"为什么"，接口细节留给这份文档与 `cordis_inspect_query`。

---

## 最小验收标准（M0）

在开始任何业务功能之前，先做到这三条，它们能一次性暴露绝大多数配置错误：

1. `plugin_manager { action: "install_bundle", target: "<bundle 绝对路径>" }` 返回 `application: "applied"`（若返回 `failed` / `overridden` / `restart-required`，见 `08` §5）。
2. 刷新宿主页面后能看到你的 UI 出现在选定的槽位里，控制台没有 `slot entry crashed in '<slot>'`。
3. 能在 Host 侧写入一条数据、重启后读回来，并且 Agent 工具与 UI 看到的是同一份数据。

---

## 已知环境问题（本机）

- **pwsh 调用可能因 Windows 文件权限失败**：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\Code\BUAAer-Smart-Schedule)`。此时文件读写工具正常，但任何 shell 命令都起不来。处理方式：把会话切到**完全权限**（或对单条命令申请一次更宽权限），或用 `diagnose-windows-sandbox-acl` 技能自带的那条命令诊断并修复该目录权限。**这不是插件本身的错误**，不要在插件代码里试图绕开它。
- **Client inspect 查询可能超时**：`Client inspect query <Provider>.<method> timed out after 10000ms. Open or reconnect the Harness page, then retry.` 这时**先打开/重连 Harness 页面再重试**，不要据此推断"没有这个槽位/服务"；必要时改从 DSH checkout 的源码与 `lib/types/**/*.d.ts` 取证（本目录的槽位与主题结论就是这样交叉核对出来的）。

---

## 建议的第一个参照物

宿主自带 `@deepseek-ai/dsh-client-ui-schedule`（"Host 任务管理页 + Session 提醒目录"）与我们要做的东西形态几乎一致：一个 `main` 面板 + 一个 `sidebar.panellist` 图标 + 用 `ctx.remote.schedule` 读写 Host。用 `Config.listConfigs { name: "@deepseek-ai/dsh-client-ui-schedule" }` 拿到 `packageDir` 后读它的实现与类型，比从零设计快得多。
