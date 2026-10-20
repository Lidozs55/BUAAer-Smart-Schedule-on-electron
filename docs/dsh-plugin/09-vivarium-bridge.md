# 09 · vivarium 桥插件(`@lidozs55/dsh-schedule-bridge`)

> **状态:已立项并落地 v1(2026-10-19)**,位于 `dsh-plugin/dsh-schedule-bridge/`(本仓库,
> host-only bundle,无 client 半、无 UI)。v1 交付两条联动:提醒气泡(任务截止/上课/日程
> 条目) + 任务状态上报。
> 拖拽收纳(文本拖给桌宠→Agent 落库)待 vivarium 基座提供外部拖放目标 API 后立项——
> 契约 v1(clause §2 interactions.drag)只有宠物自身的 move/throw,无内容拖入面。

---

## 1. 职责边界:策略在核心,表面在桥(不变)

| 插件 | 拥有 | 不拥有 |
|---|---|---|
| 核心 `@lidozs55/dsh-schedule` | 数据(domain)、领域服务、通用 Agent 工具、UI 面板、提醒子系统(提前量 Config、`ctx.schedule` 镜像与撤销、投递会话、`upcomingReminders()` 派生集) | 投递表面;桌宠概念;任何学校/导入来源 |
| 来源适配器 `@buaaer/dsh-schedule-buaa` | 北航 SSO、整学期教务导入、`sourceState.buaa` | 日程数据副本;提醒策略;UI 面板 |
| 桥 `@lidozs55/dsh-schedule-bridge` | 跨插件 UX:提醒→桌宠 notice 气泡(含「已完成」快捷动作)、任务状态上报(基座 `tasks` 状态面) | 数据副本;提醒策略与时序真相;宠物语义(逾期担忧/清空庆祝的推导归基座);UI |

时序真相只有一个(`ctx.schedule`,归核心插件);投递表面可以有多个(会话消息兜底,桌宠气泡增强)。
桌宠关闭、桥卸载、vivarium 整个不存在——提醒仍完整可用。桥 `inject: ['scheduleCore', 'vivarium']`,
任一缺席则 cordis 把桥 park 掉,核心插件无感。来源适配器同理:`inject: ['scheduleCore', ...]`,
卸载北航插件不影响已有课程/任务/条目与提醒。

## 2. v1 两条联动(已实现)

### 2.1 提醒气泡(notice)

核心插件派生「提醒时刻」集合,**覆盖三类来源**(2026-10-21 起):任务截止、上课(周课表
occurrence 投影,停课不提醒)、日程条目(教务导入的考试/会议在这里,不在任务表;考试类
条目走考试提前量)。**提前量策略只存核心 Config 一处,桥不自配**;上课/条目不镜像
`ctx.schedule`——一节课一条 agent 提醒是骚扰,桌宠气泡就是恰当表面(会话兜底仅任务享有)。
桥每 60s 读 `service.upcomingReminders()`(条目带 `kind: 'task'|'class'|'entry'` 与
确定性 `key`),提醒时刻进入 `[at−60s, at+60s]` 窗口即 `ctx.vivarium.notices.post`:

- `id = sched-rem-<key>`(key 由核心给出:任务 `<taskId>`、上课 `class-<courseId>@<日期>`
  ——去重键含日期、条目 `entry-<id>`;重复 post 被 broker 以 duplicate-id 拒绝,天然去重);
- `kind` 决定文案与动作:**任务**——「知道了」+「已完成」,点已完成直接把任务置 completed
  (`service.setTaskCompleted`,这是 v1 最有价值的 UX);**上课**——教室随文案,「知道了」;
  **条目**——类别标签(考试/会议/…;全天条目显示日期+「全天」),「知道了」;
- `ttlMs = 30min`,过期不重弹(任务由会话投递兜底);
- 用户点了哪个动作,broker 的 `settled(id)` Promise 就以该 action id 结算。

窗口语义说明:派生集只含未来时刻,一旦过点即从集合消失;60s 提前量 = 至多早一分钟弹出、
绝不漏发。核心 Config 关闭提醒时派生集为空,气泡同步静默(策略一致性);「自动化任务」
bundle 缺席只停会话镜像,派生集照常流动(桌宠气泡从不依赖它)。

### 2.2 任务状态上报(基座 §4c `tasks.report`,2026-10-21 重构)

解耦链路(vivarium ADR-013):**桥只报事实,基座推宠物语义,物种只做表现**。

- 桥每次 `service.subscribe` 变更 + 每 5 分钟,调 `ctx.vivarium.tasks.report({ pending, overdue, dueToday, next })`
  ——计数与下一截止的事实翻译,桥不记忆任何状态(旧 `prevPending`/`cleared` 跟踪已删,那是基座的状态记忆);
- 基座派生边缘信号:`tasks.overdue {count }`(逾期数**上升沿**,首报有逾期亦算)、`tasks.clear {}`
  (`pending > 0 → 0` 真转换,天生空板不庆祝);事实镜像进 `/vivarium/state` 快照 `tasks` 字段;
- 任何物种绑这两个基座信号即得「逾期担忧/清空庆祝」,无需知道本桥存在——旧方案(物种直绑
  `sched.tasks.updated` 解析载荷)每只新宠物都要重写一遍解读,已废止;
- `sched.data.changed`(`{ tables }`)保留为原始观测信号,无宠物语义,物种不应绑定。

桥对旧版 vivarium(无 `tasks.report` 面)自动降级:一次性 warn,状态上报关闭,提醒气泡不受影响。

## 3. 接口契约(实现遵守)

- 桥读核心插件:`inject: ['scheduleCore']`,只用 `upcomingReminders()` / `listTasks` /
  `setTaskCompleted` / `subscribe`——读为主,唯一写面是气泡上的「已完成」。
- 桥对 vivarium:只用稳定面 `notices.post/settled`、`tasks.report`、`emit`、`every`(契约 §1 VivariumHostApi)。
- 桥不落任何业务数据;去重靠 notice id,计数每次现算。
- Config 只有两个开关:`noticeOnReminder`(默认真)、`statusSignals`(默认真)。

## 4. 延后项

- **拖拽收纳**(v1 §2.1 设想):等 vivarium 外部拖放目标 API;语义沿用剪贴板页(暂存→交给
  Agent 调 `sched_*` 落库),`source: 'agent'` 不变。
- **徽标常驻**:任务事实已入 vivarium `/vivarium/state` 快照 `tasks` 字段;物种要常驻「下一截止」
  徽标时,由基座把事实追加上信号线(additive)即可,桥无需改动。
- ~~课程上课提醒~~(2026-10-21 落地):核心提醒子系统派生集已覆盖上课与条目(§2.1),
  `00` §4.4 / `host/schedule-reminders.js`。
