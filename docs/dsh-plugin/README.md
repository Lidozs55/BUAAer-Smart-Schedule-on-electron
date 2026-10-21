# DSH 插件开发文档

本目录是 BUAAer 智能日程的 DSH/Cordis 插件开发文档。当前由四个 bundle 组成：日程核心
`@lidozs55/dsh-schedule`、北航来源适配器 `@buaaer/dsh-schedule-buaa`、桌宠桥
`@lidozs55/dsh-schedule-bridge`、二游前瞻来源 `@lidozs55/dsh-schedule-gacha`。

写作前提：**读者此前没有接触过 DSH 插件开发**——所以这里既有"本项目长什么样"，也有"DSH 侧接口到底长什么样"。

> **当前状态（2026-10-21）**：核心/来源拆分完成，核心代码在 `dsh-plugin/dsh-schedule/`，
> 北航适配器在 `dsh-plugin/dsh-schedule-buaa/`；桌宠桥 `dsh-plugin/dsh-schedule-bridge/`
> 已到设计 v2（`09`）；二游前瞻适配器在 `dsh-plugin/dsh-schedule-gacha/`（`12`）。
> 架构基线见 `00`，新增来源的契约见 `11`。

---

## 文档地图

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| `00-architecture.md` | **架构基线**：代码地图、既定决策（R1–R11）、数据模型、架构决策记录（写路径/剪贴板/提醒/inject 权衡）、平台契约陷阱、旧实现参照地图、验收状态 | **第一个读**；改架构前必读 |
| `01-plugin-anatomy.md` | bundle / 清单 / patch 方言 / 安装启用 / 生命周期与释放 / HMR 语义 / 硬性禁止 | 动手前必读 |
| `02-host-api.md` | 怎么用 `cordis_inspect_query` 查证；`inject` vs `ctx.get`；Host 服务速查；事件与五种分发模式；`Config` 写法 | 写 Host 代码前；查签名时 |
| `03-client-ui.md` | Client 半的清单与产物格式；槽位与组件 props；主题 token 与样式规范；i18n；Client→Host 调用路径 | 写任何 UI 前 |
| `04-data-and-state.md` | 数据放哪里（Session 投影 / 存储 domain / 凭据 / 配置 / 文件）；domain 声明与使用契约 | 设计数据结构时 |
| `05-time-and-background.md` | `ctx.timer` / `ctx.jobs` / `ctx.schedule` / 人类命令；提醒与长任务怎么做 | 做提醒、同步、后台任务时 |
| `06-tool-and-agent.md` | `defineTool` 与 `ToolDefinition`；描述与 schema 规范；"一个操作两个调用者"；扩展点强弱；反模式 | 要暴露能力给 Agent 时 |
| `08-workflow-and-verification.md` | 开发循环（含 scratch web 宿主）、自检清单、安装与返回值语义、验收清单、排查表、禁忌汇总 | 每次交付前 |
| `09-vivarium-bridge.md` | 桌宠桥 `@lidozs55/dsh-schedule-bridge`（已落地设计 v2）：职责边界、提醒气泡（任务/上课/条目）/任务状态上报、接口契约、延后项 | 动桥插件 / 提醒对外表面时 |
| `10-ui-parity-rework.md` | UI 意图对齐返工**完成记录**：8 项根因与修复、scratch 验证结果、原版意图逐条清单 | 查交互设计意图时 |
| `11-source-plugins.md` | 来源适配器契约：核心服务注入面、`sourceState`、路由/设置卡/tool 的拆分规则、新增来源步骤 | 接入新学校/导入格式时 |
| `12-gacha-preview.md` | 二游前瞻适配器：B 站官方公告/视频、摘要优先解析、六款游戏推算规则、条目标记、Agent 写入与周检、设置卡 | 动二游来源 / 排查日期不准时 |

推荐路线：

- **接手开发**：`00` → `01` → `08`，再按任务读对应篇。
- **只做 Host（服务/存储/提醒/工具）**：`01` → `02` → `04` → `05` → `06` → `08`。
- **只做 UI**：`01` → `03` → `00` §5/§6 → `10` → `08`。

---

## 事实基线与核对方式

- 本机 DSH checkout：`D:\deepseek-harness`，版本 `0.2.1-rc.2`，Node `^22.19.0 || >=24.0.0`，pnpm `11.7.0`。
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
| **bundle** | 一个 npm 包，用 `dsh.bundle.patch` 把若干 plugin row 插进 profile。本插件的产出物就是它 |
| **plugin / row** | 一个插件模块；profile 组合里的一行（有 `id` / `name` / `config` / `disabled`） |
| **profile** | 用户当前的插件组合（有序 patch 层），存在于 `$DSH_PROFILE_DIR` |
| **patch** | 一层 YAML：`insert` 追加 row，按 `id` 覆盖既有 row（`config` 整体替换、不深合并） |
| **fiber** | Cordis 的插件生命周期单元：`PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`（失败进 `FAILED`） |
| **effect** | `ctx.effect(fn)`：`fn` 立即执行、返回的清理函数在卸载时执行。**所有注册都该是 effect** |
| **inject / ctx.get** | 硬依赖（缺失则 park 到提供者激活）/ 可选读取（即时查找、无顺序保证；见 `00` §4.3 的权衡） |
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
- 旧实现（`electron/`、`backend/`、`frontend/`）已于 2026-10-20 删除（迁移结论保留在 `00` §7，代码看 git 历史）。
- 包名/row id 现已定死：核心 `@lidozs55/dsh-schedule` / `schedule-core`，北航适配器
  `@buaaer/dsh-schedule-buaa` / `buaa-schedule`，桥 `@lidozs55/dsh-schedule-bridge` /
  `schedule-bridge`，二游前瞻 `@lidozs55/dsh-schedule-gacha` / `gacha-schedule`；改名等于重装
  （核心与桥原为 `@buaaer/` 前缀，与北航无关，已改到 `@lidozs55/`）。
- 不要把 DSH 侧文档整段抄进代码注释：注释写"为什么"，接口细节留给文档与 `cordis_inspect_query`。

---

## 已知环境问题（本机）

- **pwsh 调用可能因 Windows 文件权限失败**：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\Code\BUAAer-Smart-Schedule)`。此时文件读写工具正常，但任何 shell 命令都起不来。处理方式：把会话切到**完全权限**（或对单条命令申请一次更宽权限），或用 `diagnose-windows-sandbox-acl` 技能自带的那条命令诊断并修复该目录权限。**这不是插件本身的错误**，不要在插件代码里试图绕开它。
- **Client inspect 查询可能超时**：`Client inspect query <Provider>.<method> timed out after 10000ms. Open or reconnect the Harness page, then retry.` 这时**先打开/重连 Harness 页面再重试**，不要据此推断"没有这个槽位/服务"；必要时改从 DSH checkout 的源码与 `lib/types/**/*.d.ts` 取证。

---

## 最好的参照物

宿主自带 `@deepseek-ai/dsh-client-ui-schedule`（"Host 任务管理页 + Session 提醒目录"）与本插件形态几乎一致：一个 `main` 面板 + 一个 `sidebar.panellist` 图标 + 用 Remote 读写 Host。用 `Config.listConfigs { name: "@deepseek-ai/dsh-client-ui-schedule" }` 拿到 `packageDir` 后读它的实现与类型，比从零设计快得多。
