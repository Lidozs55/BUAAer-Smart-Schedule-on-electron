# 00 · 架构与既定决策

> 本文是本插件的**架构基线**：代码地图、拍板决策、数据模型、平台契约陷阱、旧实现参照与验收状态。
> DSH 平台通用参考见 `01`–`06`；开发/验证流程见 `08`；UI 历史意图见 `10`，统一条目模型与切换边界见 `13`。
> 历史过程（迁移清单演化、逐文件清点底稿）已由 git 留档，不再在文档中保留。

---

## 1. 当前形态与代码地图

四个 bundle，依赖方向是单向的：

- **日程核心** `dsh-plugin/dsh-schedule/`（包名 `@lidozs55/dsh-schedule`，row id
  `schedule-core`）——通用日程数据、服务、工具、UI、提醒。不知道任何学校/导入来源。
- **北航来源适配器** `dsh-plugin/dsh-schedule-buaa/`（`@buaaer/dsh-schedule-buaa`，
  row id `buaa-schedule`）——依赖核心注入的 `scheduleCore`，只拥有北航 SSO、
  教务同步与来源状态。
- **二游前瞻来源** `dsh-plugin/dsh-schedule-gacha/`（`@lidozs55/dsh-schedule-gacha`，
  row id `gacha-schedule`，见 `12`）——只读 B 站官方公告/视频，定时为六款游戏对账
  前瞻直播条目；版本更新只保留在来源卡。
- **桌宠桥** `dsh-plugin/dsh-schedule-bridge/`（`@lidozs55/dsh-schedule-bridge`，host-only，
  见 `09`）——只依赖核心的提醒派生集与任务完成写面（气泡上的「已完成」）。

```
dsh-plugin/dsh-schedule/
├── package.json          # exports: "." / "./client"；dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 插入 row schedule-core
├── index.js              # Host 入口：inject 声明 + Config + 装配（见 §4.3）
├── host/
│   ├── domain.js         # storage domain spec（schedule_core，§3）
│   ├── semester.js       # 通用教学周/显示日换算
│   ├── migrate.js        # 启动时一次性存量转换，完成后只打开两表模型
│   ├── model.js          # 类别/类型/来源 ID 与时间格式常量
│   ├── conflicts.js      # 写入路径的重叠检测
│   ├── service.js        # 领域服务 scheduleCore（唯一业务实现 + sourceState）
│   ├── tools.js          # 通用 Agent 工具（sched_*）
│   ├── api.js            # /api/schedule-core 客户端数据通道
│   ├── import.js         # 本插件 export 格式的回灌
│   ├── schedule-reminders.js  # 条目提醒时刻派生（纯函数，§4.4）
│   └── reminders.js      # 提醒派生（无状态、无会话投递，§4.4）
├── client.js             # Client 入口：依赖序装载分块 + 槽位注册（§6.2）
└── client.*.js           # 分块：core/notify/gridmath/weekgrid/editors/tasks/calendar/clipboard/settings/style
```

```
dsh-plugin/dsh-schedule-buaa/
├── package.json          # exports: "." / "./client"；dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 插入 row buaa-schedule
├── index.js              # inject: ['scheduleCore', 'connection', 'tools']
├── host/
│   ├── state.js          # sourceState.buaa（学号/学期码，仅供显示）
│   ├── jw.js             # 北航 SSO + 两个整学期端点（课表 / 考试），无会话缓存
│   ├── parse.js          # 整学期课表 → 按实际周次生成带日期的课程条目
│   ├── sync.js           # 一次同步：登录 → 拉取 → replaceSourceEntries + 考试任务对账
│   ├── tools.js          # buaa_course_sync
│   ├── api.js            # /api/buaa-schedule（设置页通道）
│   └── time.js           # 来源侧学期码/教学周换算（不 import 核心内部模块）
└── client.js / client.settings.js  # 往核心的 schedule.settings.blocks 槽里追加设置卡
```

```
dsh-plugin/dsh-schedule-gacha/
├── package.json          # exports: "." / "./client"；dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 插入 row gacha-schedule
├── index.js              # inject: ['scheduleCore', 'connection', 'tools']；6 小时刷新
├── host/
│   ├── games.js          # 六款游戏的 mid / 标题正则 / 默认窗口与节奏 / 条目归属标记
│   ├── bilibili.js       # 串行限流、匿名 cookie、按端点 Referer、瞬时错误重试
│   ├── parse.js          # 公告/视频/动态的纯规则解析与 planNext 推算
│   ├── state.js          # sourceState.gacha
│   ├── service.js        # 摘要优先解析、条目对账、Agent 覆盖、周检登记
│   ├── tools.js          # gacha_schedule
│   └── api.js            # /api/gacha-schedule（设置页通道）
├── client.js / client.settings.js  # 六款游戏开关 + 刷新 + Agent 核对入口
└── test/parse.test.mjs   # 离线规则测试（node --test）
```

数据流铁律：**一个操作只有一个实现**（核心服务方法）。来源插件通过
`inject: ['scheduleCore']` 调同一套方法；UI 写路径（`/api` 路由）与 Agent 工具也调同一方法。
来源插件不得 import 核心包的内部文件，也不得直接打开核心的 storage domain。核心不 import
任何来源包。LLM 一律由 DSH 宿主/Agent 侧承担，插件内零 LLM 调用。

来源状态铁律：核心 domain 的 `global.sourceState` 是来源插件的扩展点——每个来源一个 key，
值是 JSON 字符串，核心不理解其内容。新增学校/导入格式不需要改核心 schema。

时间语义铁律（2026-10-19 起）：**显示日 = 04:00 → 次日 04:00**。客户端几何/分桶在
`client.gridmath.js`（唯一一份），宿主锚点/推导在 `host/semester.js`（唯一一份）；
"今天"的显示锚点在 04:00 前取昨天（`anchorToday`，双侧同规则）。

---

## 2. 既定决策（浓缩版，逐条仍有效）

| # | 决策 |
|---|---|
| R1 | UI 全面贴近 DSH：shell 样式只用 `--dsw-*` token；类别块允许使用用户配置的鲜明 `#RRGGBB` accent，其余颜色仍走 token（§3.3） |
| R2 | 提醒逻辑是核心插件内的**子系统**（`host/reminders.js` 派生 + `client.notify.js` 轮询通知），不是独立插件；桌宠联动经**桥插件** `@lidozs55/dsh-schedule-bridge`（已落地设计 v2，见 `09`）：策略/真相在核心，投递表面（页面通知/Web Notification + 桌宠气泡）可多个，均不经过 Agent 会话 |
| R3 | 主面板 = 同一面板内 `日程 \| 任务 \| 剪贴板` 三 tab（窄幅侧栏设计），不搞左右分栏 |
| R4 | 插件内零 LLM：智能解析/修改 = 用户在 session 内让 Agent 调 `sched_*` 工具 |
| R5 | 自动排期、休息条目、由任务生成条目：**不做**（原实现本就是坏的/恒空的） |
| R6/R7 | 确定性离线解析（ctx.llm seam）、语音、图片 OCR：**不做** |
| R8 | 剪贴板队列保留在主面板第三个 tab；导入 = 队列文本发送到新会话，Agent 调批量工具落库 |
| R9 | 精力周期整个概念（数据/设置/逻辑）：**删除** |
| R10 | 大组件按职能拆分重写（单组件 ≤300 行），不整体搬运 Vue 代码 |
| R11 | 模型选择/key/限流均不进插件 |

**有意不迁移/已删除**（未来不要"顺手恢复"）：Electron 托盘/悬浮窗/窗口控制、cpolar 与手机端 SPA、Flask/JWT/静态托管、自有 LLM key 管理、`--primary-color` 主题体系、条目逐条任意 hex 颜色（类别配色不在此限制内）、`Task.urgency`、只物化未来 7 天的截断导入。旧 README 声称的四象限视图、SPOC 同步、专注模式、头像上传、Chart.js **代码里从未存在**，属新功能立项范畴。

---

## 3. 数据模型（domain `schedule_core`，version 1，zod）

时间统一为带偏移的 ISO 8601（如 `2026-10-19T08:00:00+08:00`）。当前业务表只有 `entries` 与 `tasks`：

```ts
entries: { id, title, description: string|null, location: string|null,
           lock: boolean /*创建默认 false，仅限制左键快捷移动/缩放*/,
           source?: string|null, sourceKey?: string|null,
           category /*§3.3*/, start, end, allDay?, taskId?, updatedAt }
tasks: { id, title, description: string|null,
         taskType /*'homework'|'exam'|'lecture'|'other'*/, due,
         priority /*'high'|'medium'|'low'*/, completed, entryId: string|null,
         source, updatedAt }
global: { termStart: '' /*第一周周一 YYYY-MM-DD；空串表示未设*/,
          sourceState: {} /*来源 id → JSON 字符串*/,
          entryModelVersion: 2, categoryModelVersion: 1,
           categories: [{ id, name, color: '#RRGGBB' }] }
```

- 所有日历块都是普通条目；导入与手建使用同一 CRUD、冲突检测、详情和提醒路径。
- `lock` 不限制编辑、删除、右键菜单、工具调用或其他行为；多选拖动排除锁定条目，多选删除仍包含它们。
- `source` / `sourceKey` 只记录归属与稳定身份，不派生另一种 UI 类型。完整来源快照的写法见 `11` §2。
- 新建 ID 通常由 `crypto.randomUUID()` 生成；来源更新按稳定键保留既有 ID。当前量级允许全表遍历。
- `sourceState` 是来源私有状态容器；核心只做 JSON 往返，不理解学号、公告或版本。
- 导出/导入主体为 `global`、`entries`、`tasks`，接受 UI 的 `exportedAt` 元数据；列表完整往返，空白目标采用备份定义，已有数据目标遇同 id 不同语义会新建 id 并重映射导入条目，重试复用等价定义（详见 `13`）；清空只删除两张业务表，保留学期起点与来源设置。
- 类别迁移独立使用 `categoryModelVersion: 1`：仅把旧 `source=buaa`、`sourceKey` 以 `teaching:` 开头且类别为 `study` 的教学条目改为 `course`；手建学习不变，旧规则直接物化为 `course`，已删除类别仍归 `other`。过渡 schema 保留类别列表与版本字段，重试不丢配置。
- 启动时一次性把存量周规则按实际周次转成带日期的条目；需要 `termStart`，保留改期，取消项不生成；无旧 API/旧 JSON 导入兼容。隔离转换与备份边界见 `13-entry-model.md`。

### 3.3 动态类别与配色

`global.categories` 是有序的 `{ id, name, color: '#RRGGBB' }[]`；id 稳定且唯一，改名不改 id，新增 id 为 `custom-UUID`。缺少列表的旧数据才使用默认七项，已有列表不补回被删除的预设。

| 默认 id | 名称 | 颜色 |
|---|---|---|
| `course` | 课程 | `#3B82F6` |
| `homework` | 作业 | `#F59E0B` |
| `exam` | 考试 | `#EF4444` |
| `meeting` | 会议 | `#A855F7` |
| `study` | 学习 | `#06B6D4` |
| `sports` | 运动 | `#22C55E` |
| `other` | 其它 | `#64748B` |

`other` 必须保留、名称固定“其它”、颜色可调；其余预设与自定义类别均可改名、改色、删除。`setCategories(categories)` 专用全量入口会把被删类别的现有条目改归 `other`，其余字段保留。手工写未知 id 报错；来源快照未知 id 归 `other`，后续同步不会复活已删预设。`setMeta` 仅修改既有学期设置，不拥有类别列表。

客户端从 snapshot 的列表动态生成 grid/editor/batch 选项和颜色；设置页通过原生颜色选择器即时预览同款日历块，显式保存后生效。小日历色点也使用实际类别颜色。锁定控件为紧凑 switch，单一文案“锁定（不可拖动）”，语义仍仅限快捷拖动。

完成态（经 `task.completed` 关联）：次文字色 + 删除线 + 降透明度，**只改渲染不改数据**。

---

## 4. 架构决策记录（已定，勿重开）

| 问题 | 结论 |
|---|---|
| root-scope 页面的写路径 | `ctx.connection.fetch.register()` 在共享 `/api` 前缀上挂精确路由 `/api/schedule-core`（GET snapshot + POST op）。浏览器信任围栏 + cookie 鉴权先于插件 handler，与 Remote RPC 同级可信。裸 `ctx.webServer` 路由**无鉴权**，不承载业务写 |
| 剪贴板"发送到新会话" | 0.2.x 无 composer 预填面。用 `ctx.remote.session.create({})` → `ctx.remote.session.prompt({mode:'queue', content:[text]})` → `ctxWorkspace.openSession(id)`——队列文本直接成为新会话首条消息 |
| 服务暴露形态 | `export function apply` + `ctx.effect(() => ctx.provide('scheduleCore', service))`；未来桥走 `inject: ['scheduleCore']` |
| 提醒投递 | 提醒是**纯派生**：`host/reminders.js` 按 Config 提前量现算 `service.upcomingReminders()`，条目带 `kind: 'task'|'entry'` 与确定性 `key`；不写 `ctx.schedule`、不建 Session、不触发 Agent。页面打开时 `client.notify.js` 每 30s 轮询 `/api/schedule-core?view=reminders`，在 `at−60s` 窗口内弹 Web Notification（未授权时页面内 toast）；桌宠桥读同一派生集做气泡。提醒无持久状态，domain 不存“是否已提醒” |
| 冲突校验 | `createEntry/updateEntry/moveEntry/batchCreateEntries` 全量内置重叠检测（所有普通条目统一参与）；默认拒绝并返回可行动原因，`allowConflicts=true`（工具参数/UI 确认框）放行 |
| "24h 内到期"条 | 核心插件 `UpcomingStrip` 纯读展示；提醒子系统不依赖它 |

### 4.3 Host 的 inject 声明（重要权衡）

`index.js` 目前声明 **四个全部为必需**：

```js
export const inject = ['storageDomain', 'tools', 'connection', 'systemPrompt']
```

- **为什么**：`ctx.get()` 是即时查找、无激活顺序保证——本包先于 `connection` 激活时 get 返回 undefined，静默降级导致 `/api` 路由从未注册（2026-10-17 实测 404 事故）。必需 inject 让 cordis park 到提供者激活为止，是唯一确定性契约。
- 代价（已知限制）：profile 里缺任一提供者时**整个核心插件不激活**。web/desktop 部署的
  base + web-app bundle 恒提供这四个，所以当前可接受。
- `schedule`/`sessionController` **不再是依赖**：提醒不经过 Session，核心在未启用「自动化任务」
  bundle 的 profile 上也能正常激活。`if (ctx.get(…))` 守卫保留为防御性兜底。
- `ctx.timer` 是混入 context 的助手，不需要 inject；`client.js` 已声明客户端侧的 `timer`。

**来源适配器** `@buaaer/dsh-schedule-buaa` 声明 `inject = ['scheduleCore', 'connection', 'tools']`：
`scheduleCore` 是硬依赖（核心未激活则 cordis park 住来源插件）；`connection`/`tools` 是
设置页通道与 Agent 工具的硬需求。`systemPrompt` 用 `ctx.get` 可选读取，缺失时只少对应表面，
不影响同步与数据写入。

### 4.4 提醒子系统

`attachReminders(ctx, service, config)`：Config 提供 `remindersEnabled` 与任务作业/考试/其他提前量、条目 `eventLeadMinutes`（考试条目走考试档）。`service.upcomingReminders()` 只有 `kind: 'task'|'entry'` 与确定性 `key`：任务按截止派生，条目由 `host/schedule-reminders.js` 按开始时间派生并携带 `location`。

**提醒是纯派生，不是 Agent 任务**：不写 `ctx.schedule`、不建 Session、不触发 LLM 轮次、无持久状态。
投递面只有两个，都读同一派生集：

- `client.notify.js`：页面打开时每 30s 轮询 `GET /api/schedule-core?view=reminders`，在 `at−60s`
  窗口内用 Web Notification 呈现（未授权/前台时退化为页面内 toast），按 `key@at` 去重；
- 桌宠桥：`ctx.vivarium.notices.post` 气泡（可选增强，核心不依赖）。

`remindersEnabled: false` 时派生集为空，页面通知与桌宠气泡同步静默（策略一致性）。页面关闭后
轮询停止，这是 Web Notification 方案的固有限制；装了桌宠桥时气泡可独立于页面运行。

---

## 5. 接口面（速查）

**领域服务 `scheduleCore`**（核心）：条目 `listEntries/createEntry/updateEntry/moveEntry/deleteEntry/batchCreateEntries`；完整来源快照 `replaceSourceEntries(source, inputs)`；任务 `listTasks({scope, includeCompleted})/createTask/updateTask/setTaskCompleted/deleteTask`；元数据 `getMeta/setMeta/setCategories/snapshot/getSourceState/setSourceState`；维护 `clearAllData()`（清空条目/任务，设置保留）；`subscribe(listener)`；`upcomingReminders()`。

`replaceSourceEntries` 先校验整份输入与唯一 `sourceKey`，再增改并删除本来源缺席条目；稳定键保留既有 ID，不触碰其他来源。详细约束见 `11` §2。

**核心 Agent 工具**（`sched_` 前缀，写工具不声明 `isConcurrencySafe`）：两个族工具 `sched_task`、`sched_entry`，用 `action` 选操作（task：`list/create/update/complete/delete`；entry：`list/create/update/delete/batch_create`）。2026-10-20 由 10 个单动词工具合并——工具 schema 每轮都进上下文，动词改由 `action` 枚举表达；格式、类别与冲突细则移入 `schedule` skill 按需加载。

返回 canonical value；DSH 仅将 `output.render` 的 content 发给模型，不会自动发送 canonical value，所以 render 同时输出人读摘要与完整 JSON，列表、写入和冲突都不能只给摘要。

entry 的 `category` 为动态字符串 id；`action=list` 返回 `{count, entries, categories, termStart}`，空列表同样返回当前类别。create/update 回显已持久化完整条目；batch_create 的成功项含 `entry`，失败项保留 `conflicts`，只重试失败项。条目回执附响应专用 `week: number | null`、`dayOfWeek: 1..7`，按 start 自带时区的日期和学期起点计算，不写入存储或外推缺课。未知起点或学期前日期的 week 为 null。读工具只暴露条目与公开元数据，不返回来源配置或凭据；正常成功不再读取内部文件校验。

**核心客户端通道**：`GET /api/schedule-core?weekStart=YYYY-MM-DD`（snapshot：revision/global/weekStart/termWeek/today/entries/tasks）+ `POST`（op 分发，同服务方法；含 `op=setCategories`（参数 `categories`，返回更新后的 getMeta）及本格式 export/import）。插件数据无推送通道，客户端靠 20 s revision 轮询；面板外的批量写入面（设置卡导入、来源适配器）在完成后派发同窗 `schedule:data-changed` window 事件（契约归 `client.core.js`），挂载中的日程视图立即重拉，未挂载的靠挂载时取数。

**北航来源插件**：Agent 工具 `buaa_course_sync`；客户端通道 `GET/POST /api/buaa-schedule`
（学号、同步）。教务的 `getMyScheduleDetail.do` 一次返回整学期课表且每个格自带星期/时间/周次，
所以同步没有窗口、没有分页、没有会话缓存：一次登录 + 两个请求（课表、考试），课表按
`replaceSourceEntries` 对账锁定的课程与考试条目，周次直接取教务给的值并转换为日期，不外推；考试任务同时保留。学期码由用户填的学期起始日期
（第一周周一，归核心设置页所有）推导，`termCode={Y-1}-{Y}-3` 为 7–8 月的暑期学期。
设置卡只填学号与密码，不重复学期起点输入。
`sourceState.buaa = { buaaId, termCode }` 仅供显示。它不注册日历面板/条目工具，也没有 `/buaa-sync`
（密码不能出现在命令输入里）。

**二游前瞻来源插件**：Agent 工具 `gacha_schedule`（`list/refresh/apply_official/watch`）；
客户端通道 `GET/POST /api/gacha-schedule`（设置卡状态、六款游戏开关、立即刷新）。只读 B 站
官方公告/视频，为原神、崩坏：星穹铁道、绝区零、鸣潮、明日方舟：终末地、异环各维护
前瞻直播条目（推算 `lock=false`，官方明确时刻 `lock=true`）；版本更新只在来源卡显示。条目带来源归属，只删改本源条目，不触碰其他来源或用户手建日程。`sourceState.gacha` 存上次公告 id、解析结果、开关与周检登记；
后台每 6 小时刷新（`ctx.timer`，缺失时只停自动刷新，工具与设置卡仍可用）。

**Agent 知识入口分层**：核心 `systemPrompt` 只保留当前教学周/起点、核心工具入口与安全底线；`schedule` skill 只讲主插件通用操作，不包含来源工具、学校导入、游戏刷新或桥接规则。各来源 bundle 只在自身启用时注入自己的 prompt/tool 规则：北航负责导入前提、快照和统计回执；二游负责刷新、官方校正和固定周检。参数以工具 schema 为准，开发文档不作为日常操作前置。职责与验收见 [06 · 工作 Agent 的知识边界](06-tool-and-agent.md#0-工作-agent-的知识边界)。

---

## 6. 平台契约与陷阱（本项目实测，写代码前过一遍）

### 6.1 依赖声明

- **宿主共享包只能走 `peerDependencies`**（`@deepseek-ai/*`、`zod`）：树外 `link:` 安装的 bundle 由 `routeLinked` 按 peer 名拦截映射到宿主实例；写进 `dependencies` 激活即 `ERR_MODULE_NOT_FOUND`。
- **client 半**：apply 里读到的每个 `ctx.*` 服务必须出现在 client 导出的 `inject` 数组——runner 守卫直接拒绝未声明访问（`cannot get property "X" without inject`）。当前声明：`slots/locale/remote/remote.session/uiWorkspace/timer`。
- **host 半**：见 §4.3。
- **跨 bundle**：来源插件只通过 `inject` 拿到 `scheduleCore` 服务，不 import 核心包的内部
  文件；核心也不 import 来源包。共享的时间/日期纯函数在两侧各自持有（来源侧 `host/time.js`），
  避免把实现细节变成隐式契约。

### 6.2 分块加载顺序

`require.async('./client.<name>.js')` 是 `CLIENT_CHUNK` 协议；**同步 require 不会按需物化包内分块**（不在注册依赖图里，未物化即抛 `missed the module table`）。入口 `client.js` 的 `require.async` 顺序就是依赖序：core 先物化，叶分块先于引用它们的分块。新增分块遵守 `client.<name>.js` 命名并在入口登记。

### 6.3 槽位注册

- `sidebar.panellist` 的 `id` 必须与对应 `main` 的 `key` 完全一致。
- **组件要用 `env`（api/timer/session 助手）的注册必须带 `inject: share`**——漏了则 `props.env` 为 undefined，组件抛错白屏（2026-10-18 设置页空白事故）。
- 注册带 `locale: NS` 才有 `props.t`；样式注入走 `ctx.effect` 返回清理。

### 6.4 其他

- 无参命令**整个省略 `input`**（`input: { hint: '' }` 抛 "input hint must not be empty"）。
- API 查询参数做 nullish 与格式校验（双端），防止 `"undefined"` 字符串污染快照字段（2026-10-18 aN-NaN 事故链）。
- CSS shell 使用 `--dsw-*` token；唯一业务配色例外为配置类别的 `#RRGGBB` accent；圆角/阴影走 token 刻度；locale zh/en 双语强制。
- 提醒子系统不依赖 `schedule`/`sessionController`；通知面见 §4.4 与 `client.notify.js`。

---

## 7. 旧实现迁移结论（2026-10-19 逐条核对完毕，2026-10-20 旧代码已删除）

旧 Electron 版源码（`electron/`、`backend/`、`frontend/` 与根级构建脚本）曾作为意图参照，**已于
2026-10-20 全部移除**，考古请看 git 历史。逐函数原子功能枚举（约 330 条）的判定结论保留如下：

**已迁移（含等价重设计）**：周视图全部交互（拖选/幽灵/拖动/缩放/undo-redo/条目锁/4–28 轴/
任意锚点窗口/回今天/键盘）、快速跳转小日历 + 重要度色点、批量新建日程（BatchEditor、
host `batchCreateEntries`）、任务筛选/排序/统计/进度环/即将到期条、条目与任务编辑器
（含删除确认——核对时补上的最后缺口）、冲突检测（内置到全部写路径，替代独立接口）、
教务同步（SSO 登录、整学期课表一次拉取、考试、周次归一化、整份替换）、
提醒派发（任务截止/条目统一派生 + 页面 Web Notification/toast + 可选桌宠气泡，作业/考试/其他任务与条目提前量）、
剪贴板队列（语义改为"交给 Agent 落库"）、设置页（学号/学期起点/同步/导入导出/清空）。

**明确不迁移**（依据 §2 R 决策，勿"顺手恢复"）：Electron 托盘/悬浮窗/窗口控制、cpolar 与
手机端、Flask/JWT/静态托管、自有 LLM key 管理与测试连接、`--primary-color` 主题体系与深色
模式自有样式（DSH token 覆盖）、条目逐条任意 hex 颜色（当前允许类别级配置，见 §3.3）、`Task.urgency`、只物化未来
7 天的截断导入、精力周期、自动排期/休息条目/由任务生成条目、语音/图片 OCR、
SmartInput 前端 LLM 解析（Agent 会话 + 剪贴板队列替代）、读接口删过期任务的副作用
（已知缺陷，不修）、独立导入条目编辑路径（统一到普通条目 CRUD）、
同步成功后自动刷新课表的颜色联动（完成态只改渲染不改数据）。

**延后项**（有真实价值，按需立项）：桥侧拖拽收纳/常驻徽标见 `09` §4。
页面提醒已落地（`client.notify.js`，2026-10-21）：30s 轮询 + Web Notification，未授权时页面内 toast；
条目与任务共用同一派生集。页面关闭后的系统级通知仍取决于桌宠桥或浏览器能力。

旧实现的已知缺陷清单（时区混存、日期窗口 +1 天、读接口带删除副作用等）在迁移中已全部
修掉；如需考古看 git 历史里的 `07-migration-map.md`。

**二轮 subagent 函数级复审的收敛结论（2026-10-19，判定完毕勿重开）**：
- M1 考试两级提醒（提前 1 天 + 当天）**有意收敛为单档**提前量，Config 可调（R6 决策：提醒通道单次投递，两档由 Config 配多任务等价实现）。
- M6 考试接口的**结束时间不进 `due`**：任务模型只认截止时刻，`endTime` 写进备注（`结束：15:20`），
  不另造字段。
- M8 教务请求**不带 Referer**：当前实测可用（问题 1 修复后 302 链路通）；若日后教务加校验，
  再按浏览器实测补。
- M10 旧版 urgency/80–240 分钟折叠算法**随 R1 废弃**（urgency 字段不迁）。
- M11 任务占用时段**不参与冲突检测**（随 R5：任务非日程块）。
- M12 多设备 Cookie 冲突取 **last-wins**（比旧版的保留策略更符合会话语义）。
- client 侧：帮助弹窗与「安全与隐私」说明卡**有意不做**（DSH 无对应挂载位，内容并入命令
  hint）；周末表头日期变蓝**忽略**（token 体系无该语义色，日期蓝由 is-today 承担）。
- 二轮顺手修复：考试同步去重键宽化为去空格「考试」后缀比对；条目默认 taskType=other 兜底。
- **考试同步口径（2026-10-20 真实数据校正）**：`exams.do` 实测字段是
  `courseName/examDate/startTime/endTime/examPlace/examSeatNo`（`examDate` 带 ` 00:00:00` 后缀），
  早期按旧接口猜的 `kcmc/ksrq/kssj` 全错。更重要的是**同一门课一学期可能有两场考试**（期中 +
  期末），所以去重键是「课程名 + 考试日期」而非课程名，否则两场会合成一条。删除范围限定为
  本源创建且日期不早于学期起点，用户手建的同类任务只校正 `due`。
- **教务同步改版（2026-10-20）**：改用 `getMyScheduleDetail.do?type=term` 一次拉整学期
  （每格自带星期/时间/周次），因此**取消了**逐日抓取窗口（`start_day`/`days`）、`/buaa-sync`
  命令、`checkSession`/`clearSyncSession` 与 30 分钟 SSO 会话缓存、`ctx.jobs` 后台作业以及
  新旧两种解析格式并存——一并删除，不做兼容。教师姓名、学分、课程号等日历不消费的字段在解析时
  直接丢弃。教学安排按实际周次生成带日期的普通条目，写入走 `replaceSourceEntries`（完整来源快照），学期码由学期起点推导
  并支持暑期学期 `-3`。学期起点输入只在核心设置页保留一处。

---

## 8. 验收状态（2026-10-21）

- **插件拆分（本轮）**：核心 / 北航来源适配器 / 二游前瞻来源 / 桌宠桥四个 bundle，依赖方向为
  核心 ← 北航、核心 ← 二游前瞻、核心 ← 桥。核心不再包含 SSO、教务同步、旧库导入或 `buaaId`/`termCode`
  业务逻辑；北航与二游前瞻都通过 `inject: ['scheduleCore']` 写入同一服务。
- **UI 意图对齐返工（`10`）已完成**：P2–P8 在 scratch web 宿主经浏览器自动化逐项验证；P1（设置页
  `inject: share`）随后在**真实桌面宿主**验证通过（应用内设置 → 日程设置卡渲染）。
- **真实桌面宿主（profile `…\.desktop-build\development\home\profiles\desktop`，`link:` 安装）**：
  拆分后需重新安装 `@buaaer/dsh-schedule-buaa` 并重启；二游前瞻为新 bundle，同样需安装后重启；
  核心与桥仍为 link 安装。
- **未验证**（后续按需）：键盘快捷键手感、BUAA 同步全流程（需真实学号密码）、提醒投递与
  桥气泡的真机触发（任务/条目两类）、明暗双主题逐页核对。
- **二轮修订（2026-10-19 深夜，`10` §6）**：真机实测 8+3 问题全部修复并在 scratch 宿主逐项
  验证通过——SSO 401、网格对齐、跨列拖、拖后误点击、幽灵、跳转小日历、剪贴板并入 tab、
  批量新建、中性色提亮、Windows 风格交互模型（右键建幽灵/双击编辑/框选/Del/整批 undo）。
  注意客户端分块缓存三重坑（`10` §4）：用户侧更新后须重启宿主并强刷页面。
- 收尾（2026-10-20 完成）：旧实现目录（`electron/ backend/ frontend/`）与根级旧脚本已全部删除，
  根 `package.json` 精简为仓库元信息（原 electron-builder/cpolar 配置随旧实现作废）；
  根 README 已更新。（`/buaa-import` 与 `scripts/export-legacy-db.mjs` 更早已移除，旧库迁移通道关闭。）
  仓库现在只有 `docs/`、`dsh-plugin/`、`README.md`、`package.json` 四项。
- **提醒扩展（2026-10-21）**：`host/schedule-reminders.js` 纯函数覆盖条目派生
  （当前用例以测试文件为准）；桥按 `kind` 分支，任务可气泡完成。真机触发仍未验证。
- **二游前瞻（2026-10-21）**：新增第四个 bundle `@lidozs55/dsh-schedule-gacha`
  （`12`），同样只依赖 `scheduleCore`；单测 16 项全绿，六款游戏真实接口冒烟全部 `ok`。
  它只维护本来源的前瞻条目；版本更新保留在来源卡，不触碰其他来源。
