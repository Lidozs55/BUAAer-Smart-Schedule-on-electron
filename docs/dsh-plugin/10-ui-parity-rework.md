# 10 · UI 意图对齐返工(已完成 2026-10-19)

> **状态:八项全部实现,scratch web 宿主验证通过**(验证记录见 §5)。
> 本文保留为意图对照与验收记录;后续返工以 `00-architecture.md` 为基线。

> 背景:首轮迁移(commit 18b42b8 之后)为了跑通激活,把原版 UI 大幅压缩了——原版
> `CalendarView.vue` 单文件 2090 行,迁移后全部客户端仅 ~1370 行,多个交互意图被静默丢弃。
> 用户在真实 DSH 宿主中验收后报告 8 个问题(2026-10-18)。本文档是逐项根因 + 修复要求 +
> 原版意图逐条清单,供接手的 agent 直接执行。
>
> **前置状态**:上一轮激活修复(peerDependencies / client inject 'timer' / host inject 激活竞态)
> 已完成并验证;连同 2026-10-18 的文档整编(架构基线收敛到 `00-architecture.md`)一并**未提交**。
> 接手后在这些改动之上继续,不要回退。

## 0. 关键路径与验证方式

- 迁移侧代码：`dsh-plugin/dsh-schedule/`（client 半 = `client.js` + `client.*.js` 分块；host 半 = `index.js` + `host/*.js`）
- 原版参照（意图的唯一事实来源）：
  - `frontend/src/components/CalendarView.vue`（周视图全部交互）
  - `frontend/src/components/TaskSidebar.vue`（任务筛选/排序/进度）
  - `frontend/src/components/EventEditModal.vue` / `BatchAddModal.vue`（编辑器字段）
- 平台契约文档：本目录 `01`–`06`、`08`（尤其 03 槽位契约、08 验证流程）；架构基线与平台陷阱见 `00`
- 验证：scratch web 宿主（流程见 `08-workflow-and-verification.md`）；每个改动文件过 `node --check`。
  真机验收由用户重启 DSH 桌面端完成（插件 `link:` 安装，改源码重启即生效）。

## 1. 八个已报告问题：根因与修复要求

### P1 · 设置页空白

- **根因（已定位，证据确凿）**：`client.js:85-87` 的 `settings.section` 注册**漏了 `inject: share`**
  （对比 `client.js:74-77` 两个 main 注册都带）。`client.settings.js:18-19` 读 `props.env.api`，
  `env` 为 undefined → TypeError → React 子树崩掉 → 设置页空白。
- **修复**：注册 options 加 `inject: share`（settings 只用 `env.api`，share 里多给的
  timer/openSession/session 无害）。顺带审计其余槽位注册的 share 一致性。
- **验收**：设置页渲染三张卡（账号/学期、教务同步、数据导入导出），保存学号/学期起点生效。

### P2 · 拖拽新建失效（现在是双击/单击直接开编辑器）

- **原版意图**（CalendarView.vue）：
  - `selectable + selectMirror + selectConstraint(04:00–28:00)`；**拖选空白区** → `select`
    回调（625-656 行）创建半透明"幽灵"临时事件（标题"新建事件"、type other、颜色 50% 透明、`isTemp`）；
  - **单击空白格** → `dateClick`（842-871 行）创建默认 1 小时的幽灵事件；
  - **点击幽灵块** → 打开编辑弹窗（预填该时间范围）；
  - 点击幽灵以外任意处销毁幽灵（全局 click 监听，1518-1536 行）；编辑弹窗打开时也销毁幽灵（379-384 行）。
- **迁移现状**：`client.weekgrid.js:150-154,169-174` 只有 `onDoubleClick` 直接开编辑器。无拖选、无幽灵块。
- **修复要求**：
  1. 网格空白处 pointer-down → 拖动出橡皮筋选区（15 分钟吸附，范围限制在 04:00–28:00）→
     松开后**保留**一个幽灵块（不直接开编辑器）；
  2. 单击空白格 → 该格起 1 小时幽灵块；
  3. 点击幽灵块 → 打开 `EventEditor` 并预填 start/end；
  4. 点击网格其他区域 / 打开编辑器 → 幽灵销毁。
- **验收**：拖 2.5 小时区间 → 出幽灵块 → 点它 → 编辑器预填该区间；单击格 → 1 小时幽灵；点空白处幽灵消失。

### P3 · 时间轴范围错误（现 6:00–24:00，应为 4:00–次日 4:00）

- **原版意图**：`slotMinTime:'04:00:00'`、`slotMaxTime:'28:00:00'`、`slotDuration 1h`、`nowIndicator`
  （CalendarView.vue 508-515）。视觉约定：**23:00 行底部 2px 深色粗线**（日界，样式 1809-1814），
  **24:00 标签行隐藏**（1816-1822）。
- **迁移现状**：`client.weekgrid.js:14-15` `DAY_START_MIN=360 / DAY_END_MIN=1440`。
- **修复要求**：
  1. `DAY_START_MIN=240`、`DAY_END_MIN=1680`，小时标签 04:00…23:00 后继续（24:00 标签行隐藏、
     23:00 行带日界粗线）；
  2. **分桶规则变更（关键）**：凌晨 00:00–03:59 开始的条目属于**前一格里日**的列、纵向偏移 +1440 分钟。
     现在按 `isoDay(entry.start)` 直接分桶（weekgrid 80-90 行）且被裁剪（117-119 行）——需要一个
     `gridDay(iso)` 辅助（`localMinutes < 240 ? 前一天 : 当天`）统一用于 entries 与 occurrences；
  3. **宿主窗口边界**：`host/service.js` snapshot 的条目窗口是 `weekStart T00:00 → +7d`（366-370 行），
     应把终点延到 `+7d T04:00`（最后一列要显示次日 0–4 点的条目）。
- **验收**：网格从 04:00 到次日 04:00；建一个 01:00–02:00 的条目，出现在**前一天**的列底部。

### P4 · 条目渲染占满整页宽 / 纵向错位

- **根因（已定位）**：`client.style.js:36` 的 `.bsch-daycell` **没有 `position: relative`**，
  绝对定位的 `.bsch-block`（`left:2px; right:2px`，style.js 42 行）回退到 `.bsch-grid`
  （`position: relative`，style.js 32 行）作包含块 → 横向铺满整个 8 列网格；now-line 同理。
- **次因**：同日重叠的条目全部绝对定位直接叠放——原版 FullCalendar 会给重叠事件**分道并列**
  （各占 1/n 宽）。另外纵向要核对 hourlabel `top:-9px`（标签压在线上方）的坐标系。
- **修复要求**：daycell 加 `position: relative`；实现重叠分道（按天分组求交集簇 → 簇内分 lane，
  宽度 = 1/lane 数、左偏移按 lane）；修完后逐像素核对块的上下边缘与小时线对齐。
- **验收**：条目只占自己那一列；两个重叠条目左右并列显示；时间线与刻度对齐。

### P5 · 撤销/重做：无 UI 反馈、缺重做、缺按钮态

- **原版意图**：undo/redo 双栈、各封顶 5 步；入栈点 = 拖动 / 调整大小 / 编辑保存 / 删除
  （CalendarView.vue 681-839、1131-1258 行）；撤销删除会**重建**条目（1376-1388 行）；
  键盘 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（1538-1555 行）。
- **迁移现状**：`client.core.js:218-238` `useUndo` 只有 undo 无 redo；`client.calendar.js:87`
  按钮仅在 `canUndo` 时**条件渲染**（不是禁用置灰）；只有 move 入栈（calendar.js 57-67），
  编辑器的新建/更新/删除不入栈。
- **用户明确要求**：配套**向后（撤销）/向前（重做）两个按钮**，栈顶/栈底时呈**禁用灰色态**，
  点击有可见 UI 变化。
- **修复要求**：
  1. `useUndo` 扩成 `{ undo, redo, canUndo, canRedo }`，双栈各封顶 5；
  2. 两个按钮**常驻**工具栏，`disabled={!canUndo}` / `disabled={!canRedo}`（`.bsch-btn:disabled`
     样式已存在，style.js 22 行）；
  3. 入栈点补齐：EventEditor 的新建/更新/删除（undo-delete 走重建）；
  4. 键盘快捷键（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）按原版补上。
- **验收**：拖动一个条目 → "向后"亮、"向前"灰；撤销后 "向前"亮；连续操作栈深不超 5。

### P6 · 任务筛选没做

- **原版意图**（TaskSidebar.vue 31-49、217-244 行）：状态下拉筛选（全部/待完成/已完成）+
  **按截止时间升序**（无截止的排最后）+ 顶部统计（总数/待办/已完成/百分比）+ 即将到期区。
- **迁移现状**：`client.tasks.js` TasksTab 只有固定分组（overdue/today/week/later/done），无筛选无排序。
- **修复要求**：任务页加状态下拉（全部/待完成/已完成）；组内按截止升序、无截止排尾。
  分组结构保留（窄面板下比分组比原版平铺更合适，这是有意的偏差，可在文档记一笔）。
  进度环/即将到期条迁移版已有，对齐原版语义即可。
- **验收**：切"已完成"只显示 done 组内容；组内顺序按截止时间。

### P7 · 表头日期显示 aN-NaN

- **根因（已定位，链路完整）**：
  1. `client.calendar.js:134` 根面板 `useScheduleData(env.api, env.timer)` **不传 weekStart**；
  2. `client.core.js:171-172` `snapshot(weekStart)` 不判空 → URL 变成 `?weekStart=undefined`
     （`encodeURIComponent(undefined) === 'undefined'`）；
  3. `host/api.js:73` `searchParams.get('weekStart') ?? undefined` 拿到**字符串** `'undefined'`；
  4. `host/service.js:354` `weekStart || mondayToday()` —— `'undefined'` 是真值 → 快照回传
     `weekStart: 'undefined'`；
  5. 切到任务页再切回（ScheduleTab 被卸载重挂）→ `useState(data?.weekStart ?? …)`（calendar.js:38）
     吃进 `'undefined'` → `addDays('undefined')` → `dateKey(Invalid Date)` = `'NaN-NaN-NaN'` →
     表头 `${day.slice(5)}` 恰好显示 **`aN-NaN`**。
- **修复要求（三处都设防，任一即可止血，建议全做）**：
  - client：`snapshot(weekStart)` 在 nullish 时**省略**查询参数；
  - host：`api.js` 对 weekStart 做 `/^\d{4}-\d{2}-\d{2}$/` 校验，不合法回退 undefined；
  - ScheduleTab：初始态对 `data.weekStart` 做格式校验再采用。
- **验收**：反复切换 日程/任务 标签，表头始终是合法日期；URL 里不出现 `weekStart=undefined`。

### P8 · 周窗口起点：应为"当前天起 7 天"，不是周一

- **原版意图**（"这一块的意图设计比较诡异需要好好抄一下复现一下"）：
  - 视图 = `duration:{days:7}` 的 timeGridWeek，**初始锚点是今天**；`adjustInitialDate()`：
    **当前时刻 < 4:00 时锚点取昨天**（CalendarView.vue 906-919 行）——因为一天的定义是
    4:00→次日 4:00，凌晨 2 点的"今天"在显示上还属于昨天那格里；
  - "回到今天"按钮同样走 `adjustInitialDate`（466-488 行 + onMounted 里的按钮修补 1497-1515 行）；
  - prev/next 按窗口宽度（7 天）平移；标题显示 `起始日 - 结束日` 范围（532-555 行）；
  - `datesSet` 在窗口变化时按新窗口重拉数据（586-598 行）。
- **迁移现状**：处处 `mondayOf`（calendar.js 38、82；weekgrid WEEKDAYS 按下标 18、164-167 行）。
- **修复要求**：
  1. 锚点 = `dateKey(adjustInitialDate())`（新增 helper，<4 点取昨天）；窗口 = 锚点..锚点+6；
  2. 星期标签**按实际日期的 getDay 计算**，不能用数组下标；
  3. "回今天" → `adjustInitialDate`；prev/next ±7 天；工具栏显示日期范围（P8 与 P3 的标签一起改）；
  4. **宿主侧连锁**：`host/semester.js:94-111` `deriveWeekOccurrences` 把课程摊到
     `mondayOf(weekStart)` 那一周——周三锚点的窗口会**缺下周一/二的课**。改为按窗口内 7 个
     实际日期逐日推导（每天算自己的教学周 + dayOfWeek）；`termWeek` 徽章取窗口锚点所在教学周。
- **验收**：今天周三时窗口 = 周三→下周二，七天表头星期正确；凌晨 1 点打开显示从昨天开始；
  课程在下周一/二正常出现。

## 2. 原版意图逐条清单（用户元要求："大部分意图都要逐条考虑是否迁移"）

| # | 原版意图（出处） | 决策 |
|---|---|---|
| 1 | 拖选新建 + 单击 1h 幽灵块 + 点幽灵开编辑 + 点外部销毁 | **迁移**（P2） |
| 2 | 4:00–28:00 时间轴、23:00 日界粗线、24:00 标签隐藏、<4 点归前一天 | **迁移**（P3/P8） |
| 3 | today 锚点 7 天窗口、回今天、±7 天平移、标题日期范围 | **迁移**（P8） |
| 4 | 当前时间线 nowIndicator | 已迁移，随 P3 保持 |
| 5 | 拖动黑名单 course/lecture/exam 不可拖/不可缩 | 拖动已迁移；**缺 resize**（底边拖拽改时长），建议本轮补上（原版 eventResize 763-839 行） |
| 6 | undo/redo ×5 + 键盘 + 撤销删除重建 | **迁移**（P5） |
| 7 | 点条目开编辑弹窗 | 已迁移 ✓ |
| 8 | 标题截断（中文 2 单位、20 单位封顶）+ 小字号 + 时长自适应 padding | CSS ellipsis 方案等价，保留现状（有意偏差，无需照抄 padding 逻辑） |
| 9 | 周末列浅色底 | 已迁移（is-weekend + token）✓ |
| 10 | 快速跳转月历 + 重要度色点（CalendarView 5-42 行） | **P2 顺带/可延后**：至少支持点表头改锚点日期；月历+色点记为后续项 |
| 11 | "+ 创建日常任务"批量添加（BatchAddModal） | **延后**（涉及 host 批量语义，已有 batchCreateEntries API 可用） |
| 12 | 任务状态筛选 + 截止排序 + 统计 + 即将到期 | **迁移**（P6；进度环/到期条已有） |
| 13 | 编辑器字段（标题/类型/起止/备注；颜色按类别 token） | 已迁移 ✓（颜色走 CATEGORY_TOKEN 是 §4.3 既定决策，不回退到自由选色） |
| 14 | 视图变化重拉数据 + 20s 轮询 | 已迁移 ✓ |
| 15 | 加载角标 spinner | 迁移版有 loading/error 态即可，不照抄 |
| 16 | 全天槽隐藏 / LLM 条目注入 / AbortController 竞态处理 | 不适用或已由宿主/tooling 覆盖，跳过 |

## 3. 实施顺序建议与工作量

预估总量：**中大型**（客户端 5 个文件 + 宿主 2 个文件 + 回归），按依赖排序：

1. **P7（aN-NaN）+ P1（设置页）**——两处一行级修复，先做先止血；
2. **P3 + P8（时间轴 + 窗口锚点）**——同一次改造：DAY_START/END、gridDay 分桶、锚点与表头、
   宿主 deriveWeekOccurrences 逐日化 + 条目窗口终点；这两个互相纠缠，拆开做会返工；
3. **P4（定位/分道渲染）**——依赖 P3 的坐标体系定稿；
4. **P2（拖选新建）**——依赖 P4 的选区几何；
5. **P5（undo/redo）+ P6（筛选）**——独立，任意顺序；
6. 全量回归：scratch web 宿主过一遍 §1 各验收项 + 原 8 个 M0 检查项不回退。

## 4. 平台陷阱备忘（前两轮踩过的坑，勿重蹈）

- **client 半**：apply 里读到的每个 `ctx.*` 服务必须在 client 顶部的 `inject` 数组里声明
  （guard 直接拒绝未声明访问，报 `cannot get property "X" without inject`）。
- **host 半**：消费的服务必须在 `index.js` 的 `inject` 里声明（`ctx.get` 是即时查找，不声明就有激活竞态）。
- **分块加载顺序**：入口 `client.js` 的 `require.async` 顺序 = 依赖序（core 先物化）；
  新增分块遵守 `client.<name>.js` 命名并在入口登记。
- **槽位注册**：组件要用 `env` 的注册**必须**带 `inject: share`（P1 正是漏了这个）。
- **CSS**：只用 `--dsw-*` 主题 token，不写颜色字面量；圆角/阴影走 token 刻度。
- **locale**：zh/en 两份字典都要补新 key。
- **命令**：无参命令不要写 `input: { hint: '' }`（会抛 "input hint must not be empty"），整个省略 `input`。
- **API**：查询参数禁止拼 `undefined`/`null` 字符串（P7 根因）；host 侧对入参做格式校验兜底。
- 每个改动 JS 文件过 `node --check`；不引入新依赖（宿主共享包只能走 peerDependencies）。
- **客户端分块缓存三重坑（二轮实测，比上轮认知更完整）**：① rev 与文件内容**无关**
  （bump package.json 版本也不变），URL 永远是 `?rev=<启动时算好的串>`；② chunk 响应带
  `cache-control: max-age=31536000, immutable`——浏览器**磁盘缓存**在 rev 不变时永不回源；
  ③ 服务端在**启动时快照** client 文件，改源码后不重启 host，原 rev URL 返回旧内容。
  因此改 client 后必须：重启 host **并** `fetch(url,{cache:'reload'})` 每个 buaaer 分块再
  reload 页面。用户侧"改了没生效/半新半旧混渲染"（如小日历无样式平铺）基本都是这个机制。

## 5. 完成与验证记录(2026-10-19)

实现要点(超出原文档的补充):

- **新分块 `client.gridmath.js`**:04:00–28:00 网格的全部纯数学(网格分钟、gridDay 分桶、
  anchorToday、星期/周末判定、24 行小时标签表、重叠分道 laneLayout)。weekgrid 只管渲染与
  交互,单文件不再膨胀;加载顺序 core → gridmath → weekgrid。
- **宿主侧**:`semester.js` 新增 `anchorToday()`;`deriveWeekOccurrences` 改为对窗口 7 个
  实际日期逐日推导(每天算自己的教学周 + dayOfWeek,窗口可跨教学周、可任意星期锚点);
  `service.snapshot` 锚点化,条目窗口终点延至 `锚点+7d T04:00`;`api.js` 对 weekStart 做
  `YYYY-MM-DD` 校验;`conflicts.js` 的本地 mondayOfWeekOf 收敛到 semester 助手。
- **undo/redo**:双栈各封顶 5,入栈点 = 拖动 / resize / 编辑器新建 / 更新 / 删除(撤销删除走
  重建,id 会换新,与原版一致接受);键盘 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y;两按钮常驻工具栏
  禁用态置灰。窗口锚点提升到 CalendarPanel(切 tab 不丢导航位置)。
- **任务页**:状态下拉(全部/待完成/已完成)+ 组内截止升序 + 统计提示「全部 N · 待办 M」。
  分组结构保留是**有意偏差**(窄面板分组优于原版平铺)。
- **意图表第 5 项 resize 已补**(底边手柄 15 分钟吸附);第 10 项做了「点表头跳锚点」,
  月历+色点仍为后续项;第 11 项批量添加仍延后。

scratch web 宿主(`DSH_HOME=<tmp> dsh web`,浏览器自动化)验证结果:

| 项 | 结果 |
|---|---|
| P2 | ✅ 单击→1h 幽灵;点幽灵→编辑器预填起止;点他处幽灵销毁 |
| P3 | ✅ 轴 04:00–28:00;24:00 标签隐藏;01:00–02:00 条目落**前一列底部**(top 1260px) |
| P4 | ✅ 条目限于本列;两个重叠条目各占 50% 并列分道 |
| P5 | ✅ 拖动→撤销→重做链路(top 240↔180);resize +30min→撤销还原;编辑器新建→撤销消失→重做恢复;按钮禁用态正确翻转 |
| P6 | ✅ 筛选下拉三态正确;「全部 2 · 待办 1」统计正确 |
| P7 | ✅ URL 不再出现 `weekStart=undefined`;宿主对非法值回退锚点 |
| P8 | ✅ 凌晨 00:2x 打开窗口 = 10-18~10-24(自动归昨日);表头星期按实际日期;±7 平移;日期范围徽章 |
| P1 | ⚠️ `inject: share` 已修复,share 机制经两个 main 面板验证;设置面板视觉验证被 scratch 宿主的未登录入门流程遮挡,留待桌面端真机验收 |

坑位备忘(下轮省时间):scratch 宿主改完源码要重启**并**绕过浏览器 HTTP 缓存
(分块 URL 带 rev 哈希,`fetch(url, {cache:'reload'})` 后 reload 生效)。

**真机补充（2026-10-19 深夜）**：重启真实桌面宿主后 P1 视觉验证通过——应用内「设置 → BUAAer 日程」
三张卡（账号/学期、教务同步、数据）与学号/日期/密码表单全部渲染；日程面板同步确认为新代码。

---

## 6. 二轮修订（2026-10-19 深夜）：真机实测 8+3 问题

用户实测又报 8 个问题（问题 1–8），随后再报 3 个 UI 设计问题（问题 9–11）。逐条根因与
处置：

| # | 问题 | 根因 | 处置 |
|---|---|---|---|
| 1 | 教务导入 401「入口未按预期重定向」 | `schoolHeaders` 带 `X-Requested-With: XMLHttpRequest`，教务对 XHR 直接 401、对导航 302（curl 实证；旧版 `requests.Session` 从不发该头） | 去掉 XHR/Referer/sec-ch-ua* 头；`apiGet` 把 401 与 302 同样按 `need_login` 处理 |
| 2 | 日程块与时间轴少量偏移 | `.bsch-hour` 默认 content-box，24 行各多 0.5px 边框 → 累计 ~11px | `box-sizing: border-box` + 实测 blockTop 与分钟→像素格子 0px 差 |
| 3 | 不能跨列拖动 | 旧 startDrag 只算纵向 delta | 列矩形冻结 + `dayAt(clientX)`，commit = `±24h×列数 + 纵向`，时钟时间不变 |
| 4 | 拖完抬手被当点击打开编辑页 | 拖动 commit 后浏览器补发 click | commit 置 `suppressClick`，下一 tick 清除 |
| 5 | 幽灵块过小且即逝 | 空白 press 落在幽灵上时被 startBand 清掉，后续 click 落空 | 幽灵上按下早退；单击空白建 1h 幽灵（二轮起改右键，见问题 9） |
| 6 | 跳转小日历漏迁 | — | 补 QuickJump + MiniCalendar（月网格、日/任重要度三档色点、+3 条升档、点日期跳锚点） |
| 7 | 剪贴板不应独占侧栏块 | — | 并入日/任/剪三 tab；移除侧栏 clipboardIcon 入口 |
| 8 | 批量新建没迁 | — | BatchEditor（标题/重复/星期几/起止日/起止时/类别；周重复按 dayOfWeek 过滤；整批一个 undo 步；`allowConflicts: true` 沿袭旧版静默越过冲突） |
| 9 | 「其他」灰没入背景 | idle 灰 token 过暗 | `NEUTRAL_TOKEN = color-mix(idle 45%, label-primary)`（无裸色值，白字对比不受影响；实测边框 srgb≈0.685，旧 ≈0.33） |
| 10 | 操作逻辑不合 Windows 习惯 | — | weekgrid 交互模型整体重写（见下） |
| 11 | 跳转小日历"渲染坏了" | 代码无 bug——用户实例命中 §4 客户端缓存三重坑，serve 的 style 分块是旧的 | 代码不动；用户侧重启 host + 强刷即愈（scratch 上复现正常浮层） |

### Windows 风格交互模型（问题 10，weekgrid 重写）

- 左键：单击已有条目=**选中**（空白=清空选中）；**双击=编辑**；长按拖动=移动**所有选中项**
  （按-拖-抬按"按下 +【拖/抬】"解耦，点击永不误触拖动、拖动永不误触点击）；空白长按=**框选**
  （橡皮筋矩形，视口坐标与块矩形求交）。
- 右键：空白**单击=1h 幽灵 / 拖拽=带状幽灵**，右键手势必先清场所有幽灵；右键已有条目
  （选中并）打开编辑页；右键幽灵=打开幽灵编辑页；网格内原生右键菜单一律 `preventDefault`。
- 幽灵生命周期：与幽灵无关的操作一律销毁；**单击幽灵不立即销毁**——350ms 内无第二次按下
  （双击）才销毁；双击幽灵=编辑页（React 事件名是 `onDoubleClick`，写 `onDblClick` 不挂！
  ——本轮第三个真 bug）。
- 键盘：`Delete` 删除全部选中（整批一个 undo 步，撤销=整行重建）；`Escape` 清幽灵+选中；
  Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 沿旧。
- 多选规则：拖未选中块=只拖它；拖已选中块=整批移动。Shift/Ctrl 点选按用户许可暂缓。
- **move/delete 原生多态收敛（R9-3）**：`service.moveEntry(moves)`/`deleteEntry(ids)` 单个
  走旧契约（返回行/抛错）、数组走批契约（逐条 `{ok, id, conflicts?}` 结果、不抛），消灭
  `moveMany`/`removeMany` 副本；client 只剩 `applyMoves`/`deleteEntries` 两条路径，resize
  与拖拽共用前者，冲突只剩一个裁决弹窗（原单条 conflictMove 弹窗删除）。
- 实现备注：`ghost.day` 存列下标，回 `onCreateAt` 必须转 `days[i]`（直接传下标会在
  `zonedAt` 里 `dayKey.split` 崩——本轮第二个真 bug）；框选命中测试必须全程视口坐标
  （网格本地坐标与 `getBoundingClientRect` 混用会 0 命中——本轮第四个真 bug）。

### 二轮 scratch 验证记录（全部通过）

弹层 absolute+7 列网格、点 28 跳 `10-28~11-03` 并关弹层；右键空白建 1h 幽灵（top 480px 精确
12:00）、右键拖 180px 带状幽灵（06:00–09:00）；右键/双击幽灵开编辑页且预填起止（10-22T12:00）、
单击幽灵 150ms 存活 600ms 销毁；左键选中、Del 删除、Ctrl+Z 恢复；同列 +60px=+1h、跨列 -1 天、
拖后无编辑弹窗；框选两项、整批 -75min、一步撤销全恢复；Esc 清空；右键条目开编辑页并销毁幽灵；
中性色边框 srgb 0.685；批量周重复 10-19~10-30 一/五 → 4 条（19/23/26/30）；任务页进度环百分比、
任务描述行、新建默认截止今日 23:59；剪贴板两条入队→清空确认弹窗→空态。

## 三轮（R11，用户实测推翻二轮结论）

用户实测：右键课程块建出幽灵而非编辑页、左键按在课程块上出框选、幽灵宽度远小于列宽。
**二轮验证方法的系统性盲区**：上一轮用 `dispatchEvent` 合成指针事件直发到块元素——合成事件
不做真实命中测试（hit-testing），`e.target` 永远是派发目标本身；真实鼠标点击的 target 由
浏览器按顶层元素算。凡是"点在块上却落入空白分支"类 bug，合成事件永远测不出来。

### 根因（三件套，全部系统性修复）

1. **R11-1 命中判定按 kind 分层导致固定块落空分支**：`isEntry = kind === 'entry'` 为
   false 的课程块（occurrence）既非 entry 也非 ghost，直接掉进"空白网格"分支——右键建
   幽灵、左键起框选、单击清选中，与用户三个症状逐一对应。修复：**任何 `.bsch-block` 上的
   按压都必须被块分支吞掉**，entry/ghost 之外的一律按"固定块"处理——只清幽灵、不选不拖
   不编辑（occurrence 由同步的课程规则派生，数据模型不支持改）。规则改为：判定"是不是
   空白"之前，先判定"是不是任何块"。
2. **R11-2 幽灵/带状预览没有宽度**：GhostBlock/`is-band` 只设 top/height，绝对定位块
   无宽度即收缩到内容宽（"新建事件"四字）。修复：`.bsch-block.is-ghost, .is-band` 补
   `left:2px; width:calc(100% - 4px)`（EventBlock 有内联宽度，不受影响）。
3. **R11-3 教务类别词汇直通落库**：旧系统 `entry_type` 有插件没有的值（lecture、
   individual_homework、group_report、exam_prep、work_delivery…），import 原样透传 →
   `CATEGORY_TOKEN[?] ?? other` 全渲染灰色"其他"；且 service 不枚举校验，非法值一旦落库，
   重启时存储层 z.enum 失败直接炸掉插件激活。修复三处：import 建立旧词→七类归一化映射
   （lecture 归 course，*homework/*report/*delivery 归 homework，exam_prep 归 exam）；
   service `entryInput` 落库前枚举校验（fail fast，防存储中毒）；`buaaer_entry_create`
   与批量工具描述里写明"课程类务必传 category:course"，堵住剪贴板→Agent 落库这条路径
   的默认灰色。
4. **R11-4 课程色从未显形**：宿主主题把 `--dsw-alias-brand-primary` 解析成 label 白
   （#f9fafb），course 借 brand 色等于没色。改映射：course=`state-business`（#7aaaff 蓝）、
   sports=`state-success`（#22c55e 绿）、exam 红/homework 琥珀不变、meeting/study/other
   维持中性灰——五色可辨（截图验证）。

### 三轮验证记录（真实 CDP 输入，全部通过）

验证改用浏览器真实输入管线（locator click 走 CDP Input 域、cua.drag 真实按下-拖-抬），
并遵守缓存舞步：**每次改文件 → 重启 host → 逐 chunk `fetch(url,{cache:'reload'})` →
reload**（本轮两次栽在同 rev 磁盘缓存与服务端启动快照上）。结果：右键课程块=无幽灵无
弹窗无选中 ✓；课程块上起手拖拽不产生框选（终点覆盖到的 entry 也不被误选）✓；空白框选
3 条全中 ✓；Del 批删一步 Ctrl+Z 全恢复 ✓；右键空白建幽灵且幽灵宽==条目块宽（content-box
含内边距边框，两者一致）✓；单击幽灵 200ms 存活、800ms 销毁 ✓；双击幽灵开「新建条目」
预填 12:15–13:15 且幽灵被消费 ✓；右键条目开「编辑条目」✓；左键选中/点空白清空 ✓；拖动
+1h 无弹窗尾随、Ctrl+Z 还原 ✓；跨列拖 = 精确 ±24h（周二 16:00 → 周一 16:00）可撤销 ✓；
Esc 清选中、无关手势（框选起手）销毁幽灵 ✓；点课程块不误伤已有选中 ✓。
**未能真实输入驱动**：右键拖拽带状预览（cua.drag 只有左键），与幽灵共用同一条 CSS 宽度
规则，代码级覆盖。旧词归一化实测：`individual_homework→homework`、`exam_prep→exam`、
`lecture→course`（import 返回 + 快照 + 块颜色三重确认）。
