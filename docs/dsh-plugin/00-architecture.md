# 00 · 架构与既定决策

> 本文是本插件的**架构基线**：代码地图、拍板决策、数据模型、平台契约陷阱、旧实现参照与验收状态。
> DSH 平台通用参考见 `01`–`06`；开发/验证流程见 `08`；**当前进行中的返工任务见 `10`**。
> 历史过程（迁移清单演化、逐文件清点底稿）已由 git 留档，不再在文档中保留。

---

## 1. 当前形态与代码地图

三个 bundle，依赖方向是单向的：

- **日程核心** `dsh-plugin/dsh-schedule/`（包名 `@lidozs55/dsh-schedule`，row id
  `schedule-core`）——通用日程数据、服务、工具、UI、提醒。不知道任何学校/导入来源。
- **北航来源适配器** `dsh-plugin/dsh-schedule-buaa/`（`@buaaer/dsh-schedule-buaa`，
  row id `buaa-schedule`）——依赖核心注入的 `scheduleCore`，只拥有北航 SSO、
  教务同步与来源状态。
- **桌宠桥** `dsh-plugin/dsh-schedule-bridge/`（`@lidozs55/dsh-schedule-bridge`，host-only，
  见 `09`）——只依赖核心的读面与提醒派生集。

```
dsh-plugin/dsh-schedule/
├── package.json          # exports: "." / "./client"；dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 插入 row schedule-core
├── index.js              # Host 入口：inject 声明 + Config + 装配（见 §4.3）
├── host/
│   ├── domain.js         # storage domain spec（schedule_core，§3）
│   ├── semester.js       # 通用教学周/显示日/课程周次推导（deriveWeekOccurrences）
│   ├── conflicts.js      # 写入路径的重叠检测
│   ├── service.js        # 领域服务 scheduleCore（唯一业务实现 + sourceState）
│   ├── tools.js          # 通用 Agent 工具（sched_*）
│   ├── api.js            # /api/schedule-core 客户端数据通道
│   ├── import.js         # 本插件 export 格式的回灌
│   ├── schedule-reminders.js  # 上课/条目提醒时刻派生（纯函数，§4.4）
│   └── reminders.js      # 提醒子系统（派生集 + ctx.schedule 镜像，§4.4）
├── client.js             # Client 入口：依赖序装载分块 + 槽位注册（§6.2）
└── client.*.js           # 分块：core/gridmath/weekgrid/editors/tasks/calendar/clipboard/settings/style
```

```
dsh-plugin/dsh-schedule-buaa/
├── package.json          # exports: "." / "./client"；dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 插入 row buaa-schedule
├── index.js              # inject: ['scheduleCore', 'connection', 'tools']
├── host/
│   ├── state.js          # sourceState.buaa（学号/学期码，仅供显示）
│   ├── jw.js             # 北航 SSO + 两个整学期端点（课表 / 考试），无会话缓存
│   ├── parse.js          # 整学期课表 → 课程规则（周次归一化）
│   ├── sync.js           # 一次同步：登录 → 拉取 → replaceCourses + 考试对账
│   ├── tools.js          # buaa_course_sync
│   ├── api.js            # /api/buaa-schedule（设置页通道）
│   └── time.js           # 来源侧学期码/教学周换算（不 import 核心内部模块）
└── client.js / client.settings.js  # 往核心的 schedule.settings.blocks 槽里追加设置卡
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
| R1 | UI 全面贴近 DSH：样式只用 `--dsw-*` token；移除自主调色体系；条目颜色 = 类别枚举 → token 映射（§3.3，唯一一处常量） |
| R2 | 提醒逻辑是核心插件内的**子系统**（`host/reminders.js`），不是独立插件；桌宠联动经**桥插件** `@lidozs55/dsh-schedule-bridge`（已落地 v1，见 `09`）：策略/真相在核心，投递表面（会话兜底 + 桌宠气泡）可多个 |
| R3 | 主面板 = 同一面板内 `日程 \| 任务` 双 tab（窄幅侧栏设计），不搞左右分栏 |
| R4 | 插件内零 LLM：智能解析/修改 = 用户在 session 内让 Agent 调 `sched_*` 工具 |
| R5 | 自动排期、休息条目、由任务生成条目：**不做**（原实现本就是坏的/恒空的） |
| R6/R7 | 确定性离线解析（ctx.llm seam）、语音、图片 OCR：**不做** |
| R8 | 剪贴板队列保留为独立面板；导入 = 队列文本发送到新会话，Agent 调批量工具落库 |
| R9 | 精力周期整个概念（数据/设置/逻辑）：**删除** |
| R10 | 大组件按职能拆分重写（单组件 ≤300 行），不整体搬运 Vue 代码 |
| R11 | 模型选择/key/限流均不进插件 |

**有意不迁移/已删除**（未来不要"顺手恢复"）：Electron 托盘/悬浮窗/窗口控制、cpolar 与手机端 SPA、Flask/JWT/静态托管、自有 LLM key 管理、`--primary-color` 主题体系、条目任意 hex 颜色、`Task.urgency`、课程未来 7 天物化行（改为教学周现算）。旧 README 声称的四象限视图、SPOC 同步、专注模式、头像上传、Chart.js **代码里从未存在**，属新功能立项范畴。

---

## 3. 数据模型（domain `schedule_core`，version 1，zod）

时间字段**只有一种语义**：带偏移的 ISO 8601（如 `2026-10-19T08:00:00+08:00`）。

```ts
courses: { id, courseName, teacher, classroom,
           dayOfWeek /*1-7*/, weekRange /*"1-16" 文法: N | N-M | 逗号列表*/,
           startTime /*"HH:mm"*/, endTime /*"HH:mm"*/, updatedAt }

tasks: { id, title, description|null, taskType /*'homework'|'exam'|'lecture'|'other'*/,
         due /*ISO8601 带时区，必填*/, priority /*'high'|'medium'|'low'*/,
         completed, entryId /*→entries key|null*/, source /*open id, e.g. 'manual'|'source_sync'|'agent'|'import'*/, updatedAt }

entries: { id, title, description|null, category /*§3.3 枚举*/,
           start /*ISO8601 带时区*/, end, allDay?, taskId?, updatedAt }

global: { termStart: '' /*学期第一周周一 YYYY-MM-DD*/,
          sourceState: {} /*来源 id → JSON 字符串；来源插件私有*/ }
```

- 三表 key 用 `crypto.randomUUID()`；量级（百级/年）下全表遍历可接受，暂不做前缀 key 优化。
- global 一律空字符串 = 未设置（`null` 是后端"从未写入"哨兵，global schema 不接受可空）。
- `sourceState` 是来源插件唯一的状态扩展点：核心只做 JSON 往返，不解释内容；新增来源不需要
  domain 迁移。
- 课程同步按去重键 `(courseName, dayOfWeek, startTime, weekRange)` 写入，绝不清表重插。
  部分快照走 `upsertCourses`（只增改）；整份快照走 `replaceCourses`（缺席规则连同例外一并删除）。
- 通用数据迁移：核心设置卡的「导出 JSON / 导入 JSON」只处理本插件自己的导出格式；
  「清除全部日程数据」一键清空四张数据表（学期起点与 `sourceState` 保留）。

### 3.3 类别 → token 映射（唯一一处常量，client 半）

| category | token |
|---|---|
| `course` | `--dsw-alias-brand-primary` |
| `homework` | `--dsw-alias-state-warn-primary` |
| `exam` | `--dsw-alias-state-error-primary` |
| `meeting` / `study` / `sports` / `other` | `--dsw-alias-state-idle-primary` |

完成态（经 `task.completed` 关联）：次文字色 + 删除线 + 降透明度，**只改渲染不改数据**。

---

## 4. 架构决策记录（已定，勿重开）

| 问题 | 结论 |
|---|---|
| root-scope 页面的写路径 | `ctx.connection.fetch.register()` 在共享 `/api` 前缀上挂精确路由 `/api/schedule-core`（GET snapshot + POST op）。浏览器信任围栏 + cookie 鉴权先于插件 handler，与 Remote RPC 同级可信。裸 `ctx.webServer` 路由**无鉴权**，不承载业务写 |
| 剪贴板"发送到新会话" | 0.2.x 无 composer 预填面。用 `ctx.remote.session.create({})` → `ctx.remote.session.prompt({mode:'queue', content:[text]})` → `ctxWorkspace.openSession(id)`——队列文本直接成为新会话首条消息 |
| 服务暴露形态 | `export function apply` + `ctx.effect(() => ctx.provide('scheduleCore', service))`；未来桥走 `inject: ['scheduleCore']` |
| 提醒投递 | 镜像进 `ctx.schedule`，投递回绑定 Session（一次性 `sessionController.create({})` 创建，id 存 domain）；记录 title 前缀 `[sched:<taskId>]` 供 resync 识别；对外派生集 = `service.upcomingReminders()` |
| 冲突校验 | `createEntry/updateEntry/moveEntry/batchCreateEntries` 全量内置重叠检测（课程现算也参与）；默认拒绝并返回可行动原因，`allowConflicts=true`（工具参数/UI 确认框）放行 |
| "24h 内到期"条 | 核心插件 `UpcomingStrip` 纯读展示；提醒子系统不依赖它 |

### 4.3 Host 的 inject 声明（重要权衡）

`index.js` 目前声明 **六个全部为必需**：

```js
export const inject = ['storageDomain', 'tools', 'connection', 'systemPrompt', 'schedule', 'sessionController']
```

- **为什么**：`ctx.get()` 是即时查找、无激活顺序保证——本包先于 `connection` 激活时 get 返回 undefined，静默降级导致 `/api` 路由从未注册（2026-10-17 实测 404 事故）。必需 inject 让 cordis park 到提供者激活为止，是唯一确定性契约。
- 代价（已知限制）：profile 里缺任一提供者（典型：未启用「自动化任务」bundle 的 `schedule`）时
  **整个核心插件不激活**。web/desktop 部署的 base + web-app bundle 恒提供全部六个，所以当前
  可接受；若未来要支持精简 profile，须把 `schedule`/`sessionController` 降回可选并解决
  "提供者后激活"的监听问题（vendored cordis 的动态插件无 `ctx.inject` 晚绑定动词）。
- `if (ctx.get(…))` 守卫保留为防御性兜底，不再是主要机制。

**来源适配器** `@buaaer/dsh-schedule-buaa` 声明 `inject = ['scheduleCore', 'connection', 'tools']`：
`scheduleCore` 是硬依赖（核心未激活则 cordis park 住来源插件）；`connection`/`tools` 是
设置页通道与 Agent 工具的硬需求。`systemPrompt` 用 `ctx.get` 可选读取，缺失时只少对应表面，
不影响同步与数据写入。

### 4.4 提醒子系统

`attachReminders(ctx, service, config)`：Config 提供 `remindersEnabled` 开关与提前量（任务按作业/考试/其他三档；上课 `classLeadMinutes`；条目 `eventLeadMinutes`，考试类条目走考试档）。派生集 `service.upcomingReminders()` 覆盖三类提醒时刻，条目带 `kind: 'task'|'class'|'entry'` 与确定性 `key`：任务截止（`host/reminders.js` 内联派生）+ 上课/条目（`host/schedule-reminders.js` 纯函数：`weekOccurrences` 投影 + 8 天条目窗，停课不提醒）。只有**任务**镜像进 `ctx.schedule`（`service.subscribe()` 驱动 diff 后 create/delete `at` 提醒；上课一节一条 agent 提醒是骚扰，气泡即表面）；`remindersEnabled: false` 派生集为空（策略一致性），bundle 缺席只停镜像不停派生；任何故障只降级不影响日历主功能。提醒持久状态归 `ctx.schedule`，domain 不镜像"是否已提醒"。

---

## 5. 接口面（速查）

**领域服务 `scheduleCore`**（核心）：条目 `listEntries/createEntry/updateEntry/moveEntry/deleteEntry/batchCreateEntries`；任务 `listTasks({scope, includeCompleted})/createTask/updateTask/setTaskCompleted/deleteTask`；课程 `listCourses/weekOccurrences(weekStart)/listCourseOverrides/saveCourseOccurrence/resetCourseOccurrence/upsertCourses(rules)/replaceCourses(rules, {source, termCode})`；元 `getMeta/setMeta/snapshot/getSourceState/setSourceState`；维护 `clearAllData()`（清空条目/任务/课程规则/例外，设置保留）；`subscribe(listener)`；`upcomingReminders()`。

`upsertCourses` 用于**部分快照**（缺席的规则不删，课程行没有 source 列所以不收来源参数）；
`replaceCourses` 用于**整份快照**（一次拉全时，缺席的规则连同其 per-occurrence 例外一并删除，
存活的规则保留 id 以便例外继续绑定）。

**核心 Agent 工具**（`sched_` 前缀，写工具不声明 `isConcurrencySafe`）：两个族工具 `sched_task`、`sched_entry`，用 `action` 选操作（task：`list/create/update/complete/delete`；entry：`list/create/update/delete/batch_create`）。2026-10-20 由 10 个单动词工具合并——工具 schema 每轮都进上下文，动词改由 `action` 枚举表达；格式、类别与冲突细则移入 `schedule` skill 按需加载。返回 canonical value，人读文本只进 `render`。

**核心客户端通道**：`GET /api/schedule-core?weekStart=YYYY-MM-DD`（snapshot：revision/global/termWeek/today/courses/occurrences/entries/tasks）+ `POST`（op 分发，同服务方法；含本格式 export/import）。插件数据无推送通道，客户端靠 20 s revision 轮询；面板外的批量写入面（设置卡导入、来源适配器）在完成后派发同窗 `schedule:data-changed` window 事件（契约归 `client.core.js`），挂载中的日程视图立即重拉，未挂载的靠挂载时取数。

**北航来源插件**：Agent 工具 `buaa_course_sync`；客户端通道 `GET/POST /api/buaa-schedule`
（学号、同步）。教务的 `getMyScheduleDetail.do` 一次返回整学期课表且每个格自带星期/时间/周次，
所以同步没有窗口、没有分页、没有会话缓存：一次登录 + 两个请求（课表、考试），课表按
`replaceCourses` 整份替换，周次直接取教务给的值，不外推。学期码由用户填的学期起始日期
（第一周周一，归核心设置页所有）推导，`termCode={Y-1}-{Y}-3` 为 7–8 月的暑期学期。
设置卡只填学号与密码，不重复学期起点输入。
`sourceState.buaa = { buaaId, termCode }` 仅供显示。它不注册日历面板/条目工具，也没有 `/buaa-sync`
（密码不能出现在命令输入里）。

**systemPrompt 常驻段**：核心段只保留教学周与工具入口（细则在 `schedule` skill）+ 北航段
（`buaa_course_sync`、密码仅当次使用、整学期快照语义）。

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
- CSS 只用 `--dsw-*` token，零颜色字面量；圆角/阴影走 token 刻度；locale zh/en 双语强制。
- 提醒子系统 `schedule`/`sessionController` 的取用形态见 §4.3 的权衡说明。

---

## 7. 旧实现迁移结论（2026-10-19 逐条核对完毕，2026-10-20 旧代码已删除）

旧 Electron 版源码（`electron/`、`backend/`、`frontend/` 与根级构建脚本）曾作为意图参照，**已于
2026-10-20 全部移除**，考古请看 git 历史。逐函数原子功能枚举（约 330 条）的判定结论保留如下：

**已迁移（含等价重设计）**：周视图全部交互（拖选/幽灵/拖动/缩放/undo-redo/黑名单/4–28 轴/
任意锚点窗口/回今天/键盘）、任务筛选/排序/统计/进度环/即将到期条、条目与任务编辑器
（含删除确认——核对时补上的最后缺口）、冲突检测（内置到全部写路径，替代独立接口）、
教务同步（SSO 登录、整学期课表一次拉取、考试、周次归一化、整份替换）、
提醒镜像（任务截止，含作业/考试/其他三档提前量）、
剪贴板队列（语义改为"交给 Agent 落库"）、设置页（学号/学期起点/同步/导入导出/清空）。

**明确不迁移**（依据 §2 R 决策，勿"顺手恢复"）：Electron 托盘/悬浮窗/窗口控制、cpolar 与
手机端、Flask/JWT/静态托管、自有 LLM key 管理与测试连接、`--primary-color` 主题体系与深色
模式自有样式（DSH token 覆盖）、条目任意 hex 颜色（类别→token）、`Task.urgency`、课程未来
7 天物化行（教学周现算）、精力周期、自动排期/休息条目/由任务生成条目、语音/图片 OCR、
SmartInput 前端 LLM 解析（Agent 会话 + 剪贴板队列替代）、读接口删过期任务的副作用
（已知缺陷，不修）、手动课程 CRUD（同步+导入已覆盖获取；一次性课用条目替代）、
同步成功后自动刷新课表的颜色联动（完成态只改渲染不改数据）。

**延后项**（有真实价值，按需立项）：快速跳转月历 + 重要度色点（表头点击跳锚点已实现）、
批量日常任务（BatchAddModal，host 侧 `batchCreateEntries` 已就绪）、浏览器系统通知
（ctx.schedule 会话投递已覆盖主路径；课程/条目提醒 2026-10-21 已入提醒子系统派生集，
桌宠气泡投递，见 §4.4 与 `09`）。

旧实现的已知缺陷清单（时区混存、日期窗口 +1 天、读接口带删除副作用等）在迁移中已全部
修掉；如需考古看 git 历史里的 `07-migration-map.md`。

**二轮 subagent 函数级复审的收敛结论（2026-10-19，判定完毕勿重开）**：
- M1 考试两级提醒（提前 1 天 + 当天）**有意收敛为单档**提前量，Config 可调（R6 决策：DSH
  提醒通道单次投递，两档由 Config 配多任务等价实现）。
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
  直接丢弃。课程写入改走 `replaceCourses`（整份替换，教务删除的课会消失），学期码由学期起点推导
  并支持暑期学期 `-3`。学期起点输入只在核心设置页保留一处。

---

## 8. 验收状态（2026-10-20）

- **插件拆分（本轮）**：核心 / 北航来源适配器 / 桌宠桥三个 bundle，依赖方向为
  核心 ← 北航、核心 ← 桥。核心不再包含 SSO、教务同步、旧库导入或 `buaaId`/`termCode`
  业务逻辑；北航插件通过 `inject: ['scheduleCore']` 写入同一服务。
- **UI 意图对齐返工（`10`）已完成**：P2–P8 在 scratch web 宿主经浏览器自动化逐项验证；P1（设置页
  `inject: share`）随后在**真实桌面宿主**验证通过（应用内设置 → 日程设置卡渲染）。
- **真实桌面宿主（profile `…\.desktop-build\development\home\profiles\desktop`，`link:` 安装）**：
  拆分后需重新安装 `@buaaer/dsh-schedule-buaa` 并重启；核心与桥仍为 link 安装。
- **未验证**（后续按需）：键盘快捷键手感、BUAA 同步全流程（需真实学号密码）、提醒投递与
  桥气泡的真机触发、明暗双主题逐页核对。
- **二轮修订（2026-10-19 深夜，`10` §6）**：真机实测 8+3 问题全部修复并在 scratch 宿主逐项
  验证通过——SSO 401、网格对齐、跨列拖、拖后误点击、幽灵、跳转小日历、剪贴板并入 tab、
  批量新建、中性色提亮、Windows 风格交互模型（右键建幽灵/双击编辑/框选/Del/整批 undo）。
  注意客户端分块缓存三重坑（`10` §4）：用户侧更新后须重启宿主并强刷页面。
- 收尾（2026-10-20 完成）：旧实现目录（`electron/ backend/ frontend/`）与根级旧脚本已全部删除，
  根 `package.json` 精简为仓库元信息（原 electron-builder/cpolar 配置随旧实现作废）；
  根 README 已更新。（`/buaa-import` 与 `scripts/export-legacy-db.mjs` 更早已移除，旧库迁移通道关闭。）
  仓库现在只有 `docs/`、`dsh-plugin/`、`README.md`、`package.json` 四项。
