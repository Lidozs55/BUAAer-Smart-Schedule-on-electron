# 00 · 迁移执行清单（v2 · 2026-10-17 拍板）

> **本文是迁移的唯一执行台账**：范围以本文为准。`07-migration-map.md` 降级为底稿（逐文件清点依据），两者冲突时以本文为准。
> 标记：✅ 迁移（语义保留、实现重写）｜🔁 换形态（能力保留、载体改变）｜🤝 移交宿主/Agent｜❌ 删除｜⏸ 本轮不做（记录去向，避免反复）｜🐛 现状已坏，迁移时顺手修。
> 接口签名与机制细节见同目录 `01`–`08`；本文只回答"做不做、放到哪、何时验"。

---

## 1. 本轮拍板（相对 07 底稿的范围变更）

| # | 拍板内容 | 波及 |
|---|---|---|
| R1 | UI 全面贴近 DSH：样式只用 `--dsw-*` token；**移除一切自主调色**（主题色选择、Entry 任意 hex 颜色）。条目颜色收敛为**语义类别枚举 → token 映射** | §3.1 / §3.6 / §4 |
| R2 | 提醒逻辑独立成主插件内的**提醒子系统**（`host/reminders.js`：可选 seam 判空降级 + `Config` 开关与提前量。2026-10-17 修订：原拟次级 plugin 并入主插件——零 UI 且对主插件硬依赖，独立成包无独立价值；真正的边界在"提醒策略（主插件）× 投递表面（桥）"）；与 dsh-vivarium 桌宠壳的**桥 plugin 本轮不实现**（接口边界见 §2.1 与 `09`） | §2 / §3.5 / M6 |
| R3 | 主页**左右分栏（任务｜日历）→ 同一面板内切换页**（`日程 \| 任务` 两个 tab），按侧栏窄幅设计，压缩横向占宽 | §3.6 / §6 |
| R3.1 | **无对话 session 的打开形式：暂缓**。root-scope `main`（非 `conversation` key）天然无 Session 绑定，纯查看已可用；卡点只在写路径与导入体验（D-1 / D-2），随它们一并解决 | §7 |
| R4 | **插件内零 LLM 调用**。所有"智能解析/修改日程"= 用户新建 session，让 Agent 调本插件注册的**工具**完成。插件不配 prompt、不配 key、不配 SDK | §3.2 / §3.4 / §5 |
| R5 | **自动排期、休息条目、由任务生成条目：本轮不迁移**（实现存疑 + 不愿被安排） | §3.2 / §3.7 |
| R6 | **确定性离线解析（`ctx.llm` seam 方案）移除**——DSH 里人人有 LLM | §3.4 |
| R7 | **语音输入移除；图片 OCR 移除**（EasyOCR 不保留子进程）。需要时用户把图直接发给 session 内 Agent | §3.4 |
| R8 | **剪贴板队列保留，独立成页**；导入形式 = 把队列文本**发送到 session 内 Agent**，由 Agent 调工具落库 | §3.4 / §6 / D-2 |
| R9 | **精力周期完全移除**（数据、设置项、相关逻辑） | §3.7 |
| R10 | 大组件**按职能拆分重写**，不整体搬运：`CalendarView.vue`(2090)、`TaskSidebar.vue`(1165)、`SettingsPanel.vue`(1095)、`App.vue`(1896) → §6 组件树，单组件 ≤300 行 | §6 |
| R11 | LLM 一律由 DSH 侧管理（模型选择、key、限流均不进插件） | §3.7 |

维护规则：每完成一项在 §8 打勾；范围再变更必须先更新本表与相关条目，不允许口头改范围。

---

## 2. 目标形态

### 2.1 包与角色

| 包（建议名） | 角色 | 半侧 | 本轮 |
|---|---|---|---|
| `@buaaer/dsh-schedule`（row id `buaaer-schedule`） | **主插件**：storage domain、领域服务、Agent 工具、人类命令、UI 面板 ×2、设置节、**提醒子系统**（`host/reminders.js`，可选 seam + Config） | Host + Client | ✅ |
| `@buaaer/dsh-vivarium-bridge`（暂名，位置未定） | **桥插件**：链接主插件与 `dsh-vivarium`（`@vivarium/*` 桌宠 base 壳）并新增联动功能（如桌宠播报提醒） | — | ⏸ 本轮不实现 |

- 桥的对接面是主插件服务：数据走 `listTasks`/`subscribe`，提醒派生集走 `upcomingReminders()`（提前量策略只此一处）；桥落在哪个仓库、链接哪一侧，届时立项再定；职责边界与已定联动见 `09-vivarium-bridge.md`。
- 提醒子系统经 `attachReminders(ctx, service, config)` 挂进主插件 `apply`；`schedule`/`sessionController` 一律 `ctx.get` 判空（**绝不进 `inject`**——官方 profile 默认无「自动化任务」，硬注入会拖死整个日历）。
- 包名/row id 安装即绑定 profile，**改名 = 重装**；`@buaaer/dsh-schedule` 现已定死。

目录：

```
dsh-plugin/
└── buaaer-schedule/                 # 主插件
    ├── package.json                 # exports: "." / "./client"; dsh.bundle.patch + dsh.client
    ├── cordis.patch.yml
    ├── index.js                     # Host：domain + 服务 + 工具 + 命令 + prompt 段 + Config + 提醒子系统装配
    ├── client.js                    # Client：两个面板 + 设置节 + locale
    └── …（host/ 与 client 产物子文件按需拆，见 01 §2 手写产物约束；reminders.js 为提醒子系统）
```

### 2.2 UI 面板与槽位布局

| 槽位 | 注册 | 内容 |
|---|---|---|
| `main`（keyed/root） | `{ key: 'buaaer-calendar' }` | 主面板：内部 tab **`日程 \| 任务`**（R3），窄幅布局 |
| `main`（keyed/root） | `{ key: 'buaaer-clipboard' }` | 剪贴板队列页（R8） |
| `sidebar.panellist`（list/root） | `{ id: 'buaaer-calendar', … }`、`{ id: 'buaaer-clipboard', … }` | 两个入口；**id 必须与各自 main key 完全一致** |
| `settings.section`（list/root） | `{ id: 'buaaer-schedule', … }` | 学号、学期起点、同步、数据导入导出 |

- 槽位字段与 props 一律先 `Slots.listSubTree` 现场核对（03 §3）；注册不传 `priority`。
- 不注册 `root`；不用 iframe；样式注入走 `ctx.effect`。

### 2.3 调用与数据流

```
Client UI（渲染 + 交互） ──写路径 D-1──▶ Host 领域服务（唯一业务实现） ──▶ storageDomain（buaaer_schedule）
session 内 Agent ──buaaer_* 工具（同一方法）──▶ ┘
提醒子系统（主插件 host/reminders.js）──service.subscribe()──▶ 截止变化 → ctx.schedule 登记/撤销
（未来）vivarium-bridge ──▶ service.upcomingReminders() / listTasks（本轮只保证边界干净，不实现）
```

铁律：**一个操作只有一个实现**（Host 服务方法）；UI 写路径与工具调用同一方法（06 §4）。

---

## 3. 原子功能取舍总表

### 3.1 数据层（SQLite → storage domain `buaaer_schedule`，见 §4 定稿）

| 原子功能/数据 | 取舍 | 迁移形式 | 要点 |
|---|---|---|---|
| `User.buaa_id` | ✅ | domain `global.buaaId` | 单例事实；`password_hash`（死字段）、`buaa_cookies`（进程内即可）、`username` 均不搬 |
| `Course` 周期规则（`day_of_week`/`week_range`/起止时间/教师/教室） | ✅ | `courses` 表 | 保留"第 1-16 周"语义；upsert 去重键见 §4 |
| `Course.date`（未来 7 天物化行） | 🔁 | **删除物化，改为现算** | 现状只能显示同步过的 7 天；改为「教学周号 × week_range」推导任意周，需新增 `global.termStart`（设置节可改）。⚠️ 这是行为变更，M4 验收要覆盖"非本周也有课" |
| `Task`（标题/描述/类型/截止/完成） | ✅🐛 | `tasks` 表 | `deadline` 统一**带时区 ISO 8601**（现状本地时间当 UTC 存，`to_dict` 明确不带时区） |
| `Task.priority`（0-100，四象限纵坐标） | 🔁 | `priority: 'high'\|'medium'\|'low'` 枚举 | 四象限视图并不存在（README 幻影）；导入时映射 ≥67→high、≥34→medium、其余→low |
| `Task.urgency`（0-100 float） | ❌ | 不迁移 | 无任何视图消费的遗留字段 |
| `Task.entry_id`（任务↔条目关联） | ✅ | `task.entryId`（存 entries 的 key） | "完成联动"改为**渲染层**按 `task.completed` 显示，不再改条目颜色/拼标题 `[任务已完成]` |
| `Entry.color`（任意 hex，默认 `#4a90e2`） | 🔁 R1 | 删除字段；`entry_type` 升格为**类别枚举** | 类别 → token 集中映射一处（§4.3）；导入时旧 hex 不做反推，按 `entry_type` 归类 |
| 提醒偏好（reminderSettings） | 🔁 R2 | 主插件 `Config`（`remindersEnabled` 开关 + 三档提前量） | 分立插件时代"主插件无提醒配置"的约束随 R2 修订作废 |
| 过期任务自动清理（挂在 `GET /api/reminders/upcoming` 的删除副作用） | 🐛❌ | 删除该行为 | 读接口不得有写副作用；过期任务由用户经工具/页面自行处理 |

### 3.2 Host 服务与 Agent 工具（= R4 的"session 内 LLM 接口"）

| 原子功能 | 取舍 | 迁移形式 | 要点 |
|---|---|---|---|
| 任务 CRUD + complete/uncomplete | ✅ | 服务方法 + `buaaer_task_*` 工具 | 完成/撤销完成=单次 `update`；不碰标题字符串 |
| 日历条目 CRUD | ✅🐛 | 服务方法 + `buaaer_entry_*` 工具 | 修掉日期窗口 `+1 天` 偏移；窗口语义 `from..to` 闭开区间写清注释 |
| 批量添加（原前端循环调 addEntry） | ✅ | 单个批量服务方法 + `buaaer_entry_batch_create` | 一次调用 + 逐条校验，返回逐条成功/失败结构 |
| 冲突检测（写入路径用） | ✅🐛 | 写服务内部的轻量重叠检测 | 现状读不存在的 `Course.user_id`/`Task.estimated_time` 列，本来就是坏的；新版只做"候选与课程/既有条目重叠"检查并返回可行动原因（D-6） |
| 查询面（任务列表/某周日历/周概览） | ✅ | 服务方法 + `buaaer_task_list` / `buaaer_entry_list` 工具 | Agent 回答"我这周有什么"靠它们；schema 里带窗口与过滤参数 |
| 领域说明注入 | ✅ | `ctx.systemPrompt.section()` 小段常驻 | 教学周计算规则、类别枚举语义、工具使用要点；不塞长文 |
| 自动排期 `auto_schedule` | ⏸ R5 | 不迁移 | 07 §2 中它依赖不存在的列，本就是坏的 |
| 找空档 `find_available_slots` | ⏸ R5 | 不迁移 | 恒返回空数组，从未实现 |
| 休息条目 `schedule_break` | ⏸ R5 | 不迁移 | — |
| 由任务生成条目 `entries_from_task` | ⏸ R5 | 不迁移 | 用户不想要"被安排"；Agent 想排也可用通用写入工具自行完成 |

### 3.3 BUAA 教务同步（保留，形态全变）

| 原子功能 | 取舍 | 迁移形式 | 要点 |
|---|---|---|---|
| SSO 登录（HTML 刮 `execution`） | ✅ | Host 服务内 `fetch`（Node，同进程） | 学号/密码**仅作当次调用入参**：来自会话内工具参数或设置节触发表单；绝不落盘、不进 Config、不进 credentials |
| 逐日课表抓取 `detail.do`（×7，间隔 ~0.2s） | ✅🐛 | `ctx.jobs` 后台作业 + `buaaer_course_sync` 工具 + `/buaaer-sync` 命令 | `append()` 报逐日进度、可取消；**upsert 周期规则**，废除"先删全表再插" |
| 考试安排 `exams.do` | ✅ | 并入同一 job | 产出 `task_type:'exam'` 的任务（供提醒子系统消费） |
| 学期码规则（8-12 月 `{Y}-{Y+1}-1` 等）与请求头/UA/Referer | ✅ 原样 | Host 模块常量 | 学校侧要求，不是包袱 |
| SSO 会话与 30min 空闲过期 | ✅ | 插件内存状态 | 不进 domain |
| "删全表再插入"破坏性写 | 🐛❌ | 改为按去重键 upsert | 去重键：`(course_name, day_of_week, start_time, week_range)` |

### 3.4 输入入口（智能输入全线重定向，R4/R6/R7/R8）

| 原子功能 | 取舍 | 迁移形式 | 要点 |
|---|---|---|---|
| 自然语言建任务/条目（原 SmartInput 文本路径 + 后端 prompt 拼装） | 🔁 R4 | **删除自有解析**；用户在 session 内让 Agent 调 `buaaer_task_create` / `buaaer_entry_batch_create` | 插件内零 prompt、零 LLM 客户端 |
| 确定性离线解析（`ctx.llm` seam） | ❌ R6 | 不做 | — |
| 语音输入 | ❌ R7 | 不做 | 未来若宿主语音 seam 成熟且用户要，再立项 |
| 图片 OCR（EasyOCR） | ❌ R7 | 不做；用户把图发给 session 内 Agent | 不保留 Python 子进程 |
| 剪贴板队列 | ✅ R8 | 独立面板 `buaer-clipboard`：队列增删改排序（组件本地态） | 导入 = 拼装队列文本 → **新会话预填 composer**（D-2），用户确认发送，Agent 调批量工具落库 |
| `_get_occupied_slots` 服务端自调 HTTP | 🐛❌ | 直接读 domain | 自调 `127.0.0.1:5000` 的路径随 Flask 一起消失 |

### 3.5 提醒（主插件内子系统，R2）

| 原子功能 | 取舍 | 迁移形式 | 要点 |
|---|---|---|---|
| 60s 前端轮询 + Web Notification | 🔁 | 删除；提醒子系统用 `ctx.schedule` durable 提醒 | 投递形态 = **回绑定 Session 会话内提醒**（`[SCHEDULE REMINDER]`），不是系统弹窗——插件 UI 只在 Web 页面内，硬约束 |
| 多级提前量（课程/作业/考试各自提前 X 分钟） | ✅ | 主插件 `Config` + 为截止时间登记 `at` 提醒 | 提醒持久状态归 `ctx.schedule`；domain 不镜像"是否已提醒" |
| 登记/撤销同步 | ✅ | 提醒子系统 `service.subscribe(listener)`，diff 后 create/delete | 任务删除/完成时撤销对应提醒 |
| 可用性降级 | ✅ | `ctx.get('schedule')` 判空 | Schedule 是可选 bundle（须启用「自动化任务」）；缺失时安静降级并在设置文档说明 |
| 会话归档限制 | ✅ | 文档化告知 | 含活跃提醒的会话归档会被拒绝（05 §4） |
| 桌宠播报（vivarium 联动） | ⏸ | 桥 plugin | 本轮只保证 `upcomingReminders()` 接口边界干净 |
| 提醒逻辑的收拢 | ✅ R2 | 全部在 `host/reminders.js` 单模块 | `schedule`/`sessionController` 只经 `ctx.get`；子系统任何故障只降级、不影响日历主功能 |

### 3.6 Client UI（Vue → React，R1/R3/R10）

| 原子功能 | 取舍 | 迁移形式 | 要点 |
|---|---|---|---|
| 周视图日历 | ✅ R10 | **自绘 WeekGrid**（时间轴 + 7 天列），不引 FullCalendar | 手写 bundle 的模块表基线不含第三方包（03 §2/§5.3），FullCalendar 默认样式也与 token 体系冲突；拆分见 §6 |
| 拖拽改期 | ✅ | 组件交互 + 写路径落写 | pointer 事件 + 时间吸附（15min 粒度） |
| 撤销/重做（≤5 步） | ✅ | 组件本地撤销栈 `useUndo` | 不进 domain |
| 周末/今日着色、工具栏 | ✅ | 组件 + token | 周末用 `bg-layer` 区分，不用颜色字面量 |
| 任务侧栏 → 任务 tab | ✅ R3 | `TasksTab`：分组列表 + SVG 进度环 | `confirm()/alert()` 全部换 `ConfirmDialog` |
| 24h 内到期面板 | ✅ | `UpcomingStrip`（纯读展示） | 归属主插件（D-5）；投递归提醒子系统 |
| 事件/任务编辑弹窗、批量添加弹窗 | ✅ | `EventEditor` / `TaskEditor` / 批量并入一次调用 | 自实现 Modal：焦点圈、Escape、遮罩照宿主 |
| 设置面板 | 🔁 | `settings.section` + Config | 内容收窄为：学号、学期起点、同步动作、导入导出（§5.3）；密码字段**无**（当次输入） |
| 主题色 / 深色模式自有体系 | ❌ R1 | 宿主 token 接管 | 删 `--primary-color` 变量体系与明暗切换逻辑 |
| 条目任意配色 | ❌ R1 | 类别枚举 → token | 见 §4.3 |
| 精力周期设置 | ❌ R9 | 删除 | — |
| `App.vue` 壳（顶栏/页面切换/多定时器） | ❌ R10 | 拆散：页面切换交宿主；定时器换 `ctx.timer`；`window.electronAPI` 无对应物 | — |
| 手机端 SPA（`MobileHome` + `components/mobile/*`） | ❌ | 删除 | 宿主 Web UI 自带响应式；含假 IP/假同步的演示代码 |

### 3.7 删除 / 移交汇总（本轮不做任何保留动作）

| 项 | 处置 | 一句话理由 |
|---|---|---|
| Electron 托盘/悬浮窗/窗口控制/IPC、全局杀进程脚本 | ❌ | 插件插不进操作系统层；`taskkill /F /IM python.exe` 是危险代码 |
| cpolar、二维码、`~/.cpolar/authtoken` 明文 | ❌ | 远程访问归宿主/部署 |
| Flask 端口监听、`/api/health`、静态托管、JWT、Vite 代理 | ❌ | 同进程无端口、无启动等待、无鉴权问题 |
| LLM key 管理（`/api/settings/*`、`.env` 就地改写、test_connection 限流） | 🤝 R11 | 宿主模型配置接管；限流键写死 `'default'` 的实现一并消失 |
| `llm_parser.py`、dashscope/openai SDK 直连 | ❌ R4 | Agent 工具替代 |
| `api.js`（axios 9 命名空间）、`notification.js`、Pinia 6 store | ❌ | 换 Remote/`ctx.schedule`/组件态 + Host 读 |
| README 声称的四象限视图、SPOC 同步、专注模式、头像上传、Chart.js | ❌ 不排期 | **代码里不存在**（README 漂移）；要做属新功能立项 |
| 坏引用（`/sound/*` 路由、`icon-light-*` 图标名） | ❌ | 随旧前端一起清掉 |

---

## 4. 数据模型定稿（v1 草案，M1 实现基准）

domain：`buaaer_schedule`，`version: 1`，zod schema；名字命中 `UNIT_NAME_RE`。时间字段**只有一种语义**：带偏移的 ISO 8601（如 `2026-10-19T08:00:00+08:00`），schema 注释写死。

### 4.1 表结构

```ts
courses: { id, courseName, teacher, classroom,
           dayOfWeek /*1-7*/, weekRange /*"1-16"，文法: N | N-M | 逗号列表*/,
           startTime /*"HH:mm"*/, endTime /*"HH:mm"*/, updatedAt }

tasks: { id, title, description|null, taskType /*'homework'|'exam'|'lecture'|'other'*/,
         due /*ISO8601 带时区，必填*/, priority /*'high'|'medium'|'low'*/,
         completed, entryId /*→entries key|null*/, source /*'manual'|'buaa_sync'|'agent'|'import'*/, updatedAt }

entries: { id, title, description|null, category /*§4.3 枚举*/,
           start /*ISO8601 带时区*/, end, allDay? , taskId? /*冗余反向索引可不做，查表遍历即可*/, updatedAt }

global: { buaaId: '', termStart: '' /*学期第一周周一 YYYY-MM-DD*/, termCode: '' }
```

- key：三表用 `id`（`crypto.randomUUID()` 或短 id）；`entries` 若"取一周"高频可升级为 `YYYY-MM-DD#id` 前缀 key——M1 先用纯 `id` + 内存索引，量级（百级/年）下 `entries()` 全遍历可接受，别过早优化。
- `source` 标记任务来源，便于同步 upsert 不覆盖手动任务。
- global 一律用空字符串表示"未设置"——`null` 是存储后端"从未写入"的哨兵，domain 的 global schema 不接受可空字段（04 §3.1）。

### 4.2 旧数据导入（D-4，默认做）

一次性脚本读 `backend/instance/app.db` → 生成 JSON → `/buaaer-import` 命令（或临时工具）写入 domain。映射要点：deadline/时间加 `+08:00`；`priority` 0-100 → 三档；`urgency`、`color`、`password_hash` 丢弃；`Task.entry_id` 数字 id → 新 entries key 对照表。导入前后条目数对账。

### 4.3 类别 → token 映射（唯一一处常量，client 半）

| category | token | 语义 |
|---|---|---|
| `course` | `--dsw-alias-brand-primary` | 课程 |
| `homework` | `--dsw-alias-state-warn-primary` | 作业 |
| `exam` | `--dsw-alias-state-error-primary` | 考试 |
| `meeting` / `study` / `sports` / `other` | `--dsw-alias-state-idle-primary` | 中性类别 |

完成态（经 `task.completed` 关联）：文字 `--dsw-alias-label-secondary` + 删除线，背景降透明度；不改数据。

---

## 5. Host 接口面清单

### 5.1 领域服务（唯一业务实现；形态见 D-3）

```
buaaerSchedule:
  // 条目
  listEntries(from, to) · createEntry(input) · updateEntry(id, patch) · moveEntry(id, start, end)
  deleteEntry(id) · batchCreateEntries(inputs) → 逐条 {ok|err}
  // 任务
  listTasks({scope: 'today'|'week'|'overdue'|'all', includeCompleted})
  createTask(input) · updateTask(id, patch) · setTaskCompleted(id, completed) · deleteTask(id)
  // 课程
  listCourses() · deriveWeekOccurrences(weekStart)   // 教学周 × week_range 现算
  upsertCoursesFromSync(rules[])                     // 仅供同步 job 调用
  // 元
  getMeta()/setMeta(patch)                            // global: buaaId/termStart/termCode
  subscribe(listener) → dispose                       // 供提醒子系统与未来桥；数据变化通知
```

写入方法内部统一走：schema 校验 → 重叠检测（返回 `{conflicts: [...]}` 可行动原因）→ put。**写序即事务边界**，多写操作放一个方法内（04 §4 要点 5）。

### 5.2 Agent 工具（全局注册；写工具不声明 `isConcurrencySafe`，独占调度）

| 工具 | 说明 |
|---|---|
| `buaaer_task_list` / `buaaer_entry_list` | 查询；带窗口/过滤参数，结构化返回 |
| `buaaer_task_create` / `buaaer_task_update` / `buaaer_task_complete` / `buaaer_task_delete` | 任务写面 |
| `buaaer_entry_create` / `buaaer_entry_update` / `buaaer_entry_delete` | 条目写面（update 含移动） |
| `buaaer_entry_batch_create` | 批量；剪贴板导入与 Agent 批量共用 |
| `buaaer_course_sync` | 触发同步 job（凭据作当次参数）；`timeoutMs` + `exec.signal` 检查 |

命名 `buaaer_` 前缀 + snake_case；每个参数有 description；返回 canonical value（id、受影响数、冲突列表），人读文本只进 `render`（06 §2/§3）。

### 5.3 systemPrompt 与人类命令

- `ctx.systemPrompt.section()`：常驻小段——教学周计算（`termStart` + 周一对齐）、category 语义、"修改日程请用 buaaer_* 工具"。
- `ctx.commands.register`：`/buaaer-sync`（立即同步；进度看 job 面板）、`/buaaer-import`（D-4 用，验收后可移除）。

---

## 6. Client 组件树（R10 拆分方案）

`client.js` 内以工厂函数组织（无构建链、无 JSX，`React.createElement`）；**单组件/单文件 ≤300 行，超了继续拆**。

```
client.js
├─ CalendarPanel            main key='buaaer-calendar'；tab 态、面板级布局（窄幅）
│  ├─ ScheduleTab
│  │  ├─ WeekToolbar        周导航 / 回今天 / 当前教学周徽标
│  │  ├─ WeekGrid           7 天 × 时间轴网格；now-indicator；周末 bg-layer 区分
│  │  │  └─ EventBlock      类别→token 色块；完成态样式；点击→EventEditor
│  │  ├─ DragController     pointer 拖拽 + 15min 吸附 → useWrite
│  │  └─ UpcomingStrip      24h 内到期（纯读，D-5）
│  ├─ TasksTab
│  │  ├─ TaskList           分组：今日/本周/已过期/已完成
│  │  ├─ ProgressRing       SVG 自绘
│  │  └─ TaskEditor         创建/编辑对话框
│  ├─ EventEditor           条目创建/编辑对话框（手动录入路径，无 LLM）
│  ├─ ConfirmDialog         替代 confirm()/alert()
│  └─ hooks: useScheduleData（读+订阅刷新）· useWrite（D-1 写路径）· useUndo（≤5 步）
├─ ClipboardPanel           main key='buaaer-clipboard'
│  ├─ QueueList             队列增/删/改/排序（组件本地态）
│  └─ SendToSession         拼装队列文本 → 新会话预填 composer（D-2）→ 用户发送
├─ SettingsSection          settings.section id='buaaer-schedule'
│  ├─ MetaFields            学号 / 学期起点 / 学期码
│  ├─ SyncActions           /buaaer-sync 触发 + job 进度展示
│  └─ DataIo                导入（D-4）/ 导出 JSON
└─ locale + tokens 常量     文案字典；§4.3 映射表
```

样式规则回链 03 §4：只用 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-elevation-*`；0.5px 中性边框；字号行高成对；文案全部走 locale（zh/en 双语强制）。

---

## 7. 开放决策点（结论已于 2026-10-17 实现轮回填，见 §7.1）

| # | 问题 | 选项与默认 |
|---|---|---|
| **D-1** | **root-scope 页面的写路径**（R3.1 的真正卡点；决定 M3 架构） | a) 验证 client 能否经 `useSessions`/`remote.session` 拿到可执行 `ctx.remote.commands.execute` 的 Agent 引用（宿主「自动化任务」页新建会话的做法旁证可行）→ b) 不通则 M3 页面只读 + 编辑引导到会话（Agent 写）→ c) 最后才是 `ctx.webServer` 前缀路由（须先核实鉴权落在已鉴权共享前缀，03 §5.4）。**M3 开工前必须有结论** |
| **D-2** | 新会话**预填 composer** 机制（剪贴板导入与"LLM 改日程"统一入口） | 读宿主 `@deepseek-ai/dsh-client-ui-schedule` 源码（`Config.listConfigs` 拿 packageDir）复刻其"新建（composer 已预填）"路径；M5 前完成验证 |
| **D-3** | 主插件暴露服务的形态 | 默认：`apply` 函数形态 + `ctx.provide('buaaerSchedule', api)`（02 §1 文档化路径）；备选 Service 类 + `static inject`（须先在 0.2.0-rc.2 验证 static inject 生效，01 §4 反面教材） |
| **D-4** | 旧 SQLite 数据迁移 | 默认**做**（§4.2）；不做则接受空库重同步（课程可同步回来，手动任务/条目会丢） |
| **D-5** | "24h 内到期"视图归属 | 默认留主插件（纯读）；提醒子系统不依赖它。桥/桌宠若要复用，届时上移为服务方法 |
| **D-6** | 写入冲突校验范围 | 默认：全部写方法内置轻量重叠检测；若嫌过度可降级为仅 `batch_create` 与工具路径启用。自动排期类"建议"能力不做（R5） |

### 7.1 结论回填（2026-10-17，实现轮；依据为对 `D:\deepseek-harness` 0.2.0-rc.2 源码的核对）

| # | 结论 |
|---|---|
| **D-1** | **第四条路（优于原 a/b/c）**：`ctx.connection.fetch.register()` 在共享 `/api` Fetch 注册表上挂精确路由（`/api/buaaer-schedule`，GET+POST）。核实依据：`client/connection` 的 `ConnectionFetchRoute` 文档明言 *"Handle one request after the physical carrier has applied its trust and authentication policy"*——即浏览器信任围栏 + 签名 cookie 鉴权先于插件 handler，与 Remote RPC 同级可信；裸 `ctx.webServer` 路由已核实**无鉴权**（README 原话 "carries no TLS, authentication, or origin policy"），维持不承载业务写的判断。UI 写路径 = `/api` 路由 → 同一 `buaaerSchedule` 服务方法（铁律保持） |
| **D-2** | **composer 预填在 0.2.0-rc.2 不存在插件可用面**：`startSession(workspaceId?)` 无预填参数；draft/composer 存储属 ui-conversation 包内部（`ComposerKeyboard` 注释 "never across a plugin boundary"）；官方参照页 ui-schedule 的"新建"也只是裸 `startSession()`。**替代**：剪贴板页一键 = `ctx.remote.session.create({})` → `ctx.remote.session.prompt({mode:'queue', content:[text]})` → `uiWorkspace.openSession(id)`——队列文本直接成为新会话首条消息，Agent 据此调 `buaaer_entry_batch_create` 落库。比预填更少一步确认，语义等价 |
| **D-3** | 采用默认：`export function apply(ctx, config)` + `ctx.effect(() => ctx.provide('buaaerSchedule', service))`；提醒子系统直接引用 service 对象（原次级插件 `inject` 形态随 R2 修订作废，未来桥仍走 `inject: ['buaaerSchedule']`） |
| **D-4** | 做。产物两件：`scripts/export-legacy-db.mjs`（旧库 → JSON，node:sqlite；Node 22 需 `--experimental-sqlite`）+ Host 侧 `host/import.js`（映射/去重/对账）。命令入口 `/buaaer-import <json路径>`，设置页另有图形导入。注意契约：导出的 entries 必须带 `id` 列（任务 entry_id 靠它重映射） |
| **D-5** | 留主插件：`UpcomingStrip` 纯读展示，数据来自 `/api` snapshot；提醒子系统不依赖它 |
| **D-6** | 全量内置：`createEntry/updateEntry/moveEntry/batchCreateEntries` 均跑重叠检测；默认拒绝并返回可行动原因，`allowConflicts=true`（工具参数/UI 确认框）后放行。课程出现（现算）也参与占位判断 |

### 7.2 实现附记（本轮落地形态，2026-10-17）

- 产物位置：`dsh-plugin/buaaer-schedule/`（主插件，Host + Client；提醒子系统在其 `host/reminders.js`）。
- **Client 半拆分为包内分块**：模块系统支持 `require.async('./client.<name>.js')`（`CLIENT_CHUNK` 协议，`client.*.js` 命名），入口 `client.js` 依次装载 `client.core.js → weekgrid/editors/tasks/calendar/clipboard/settings/style`。core 必须先物化（后续分块同步 require 它）——真实 require 对已注册未物化的分块会按需物化，顺序仍由入口保证。
- Host 半 ESM 多文件：`index.js`（装配 + Config）+ `host/{domain,semester,conflicts,service,tools,api,sso,sync,commands,import,reminders}.js`。
- 提醒子系统的身份约定：schedule 记录 title 前缀 `[buaaer:<taskId>]`，resync 靠它识别自有记录；投递会话由 `sessionController.create({})` 一次性创建并存入自有 domain `buaaer_reminders.global.boundSessionId`；对外派生集 = `service.upcomingReminders()`。
- 本轮**未做**（诚实边界）：在真实 DSH 宿主中的安装/激活/渲染验收（M0–M6 的运行时勾选全部未发生）；§8 勾选框保持未勾，待装进宿主后逐项验收。已完成的离线验证：22 个文件 `node --check`、semester/conflicts/sync 解析与 service/import 逻辑断言（含时区、周次、学期翻转、幂等导入）、client 分块在模拟 ModuleLoader 下的装配冒烟（槽位注册完整、main key ↔ sidebar id 一致、CSS 无颜色字面量）。

---

## 8. 里程碑与验收（每项验收通过后勾选；旧实现删除不早于对应验收）

> **状态（2026-10-17）**：M0–M6 的**代码已全部实现**（见 §7.2），但运行时验收尚未发生——需要把 bundle 装进真实 DSH 宿主逐项验证。勾选框全部保持未勾，验收时逐项打勾。

### M0 骨架（主插件）
- [ ] `dsh-plugin/buaaer-schedule/` 可安装：`plugin_manager install_bundle` 返回 `application: "applied"`
- [ ] 两个 main key + sidebar 图标空页可见，刷新后仍在；控制台无 `slot entry crashed`
- [ ] tab 壳（`日程 | 任务`）+ locale（zh/en）+ 样式注入生效；明暗两主题均正常

### M1 数据层 + 服务
- [ ] domain `buaaer_schedule` 四单元按 §4 落地；`open()` 各失败路径显式报错
- [ ] §5.1 服务方法全量可用；写后即读一致；重启后数据仍在
- [ ] `subscribe()` 能收到变更通知（为 M6 预演）
- [ ] （D-4）旧库导入完成并对账

### M2 Agent 工具面
- [ ] §5.2 工具注册进 schema（inspect 可见）；**纯工具**跑通任务/条目增删改查与批量
- [ ] 冲突写入返回可行动原因；中断（signal）不留半写状态
- [ ] systemPrompt 段与 `/buaaer-sync` 命令壳就位

### M3 UI 页面（依赖 D-1 结论）
- [ ] 日程 tab：周视图现算课程出现（含非本周）、拖拽改期、撤销 ≤5 步
- [ ] 任务 tab：分组列表 + 进度环 + 编辑弹窗；无 `confirm/alert`
- [ ] 写路径与工具同源（同一服务方法）；失败可见
- [ ] 窄幅布局在侧栏宽度下可用；明暗主题、locale、token 合规（08 §6.2 全项）

### M4 BUAA 同步
- [ ] 学号/学期起点设置节可用；密码仅当次入参、无任何持久化痕迹
- [ ] 同步 job 可观察（逐日进度）、可取消；**upsert 不清旧课**
- [ ] 失败（凭据错/网络断）留下可行动原因；考试生成 exam 任务

### M5 剪贴板页（依赖 D-2 结论）
- [ ] 队列管理（本地态）+ 一键"发送到新会话"（composer 预填队列文本）
- [ ] Agent 据此经 `buaaer_entry_batch_create` 落库，结果在页面可见

### M6 提醒子系统（主插件内）
- [ ] 任务/考试截止按 Config 提前量登记 `at` 提醒；删除/完成任务自动撤销
- [ ] 到点投递回绑定 Session；Host 重启后提醒仍在
- [ ] 未启用「自动化任务」/缺 `sessionController`/`remindersEnabled=false` 时判空降级；提醒子系统任何故障不影响日历主功能
- [ ] `service.upcomingReminders()`（未来桥的挂点）形状稳定，代码注释边界清晰

### 收尾
- [ ] 删除旧实现（`electron/`、`backend/`、`frontend/`、cpolar/打包脚本），更新根 README
- [ ] D-1…D-6 结论回填本文；`07` 标注"已被 00 取代"存档

---

## 9. 本轮硬性规则（08 §9 之外新增）

1. 样式**零颜色字面量、零自造 CSS 变量**；类别→token 只在 §4.3 那一处常量。
2. 插件代码中**不得出现任何 LLM SDK、模型 HTTP 调用、prompt 模板**（R4/R6/R11）。
3. 提醒逻辑只收在 `host/reminders.js` 单模块；`schedule`/`sessionController` 只经 `ctx.get` 可选读取，**绝不进 `inject`**；子系统任何故障（open 失败、resync 抛错）只降级不外溢（R2）。
4. 学号之外的一切凭据**只作当次调用入参**，不落盘、不进 Config、不进 credentials。
5. UI 与工具的写操作**必须**收敛到同一服务方法；两处各写一套即缺陷。
6. 单组件 ≤300 行；超限先拆再继续。
7. 手写 bundle 禁 `require('@deepseek-ai/dsh-client-*')`、禁 iframe、禁第三方 UI 库（03 §2）。
