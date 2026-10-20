# 09 · vivarium 桥插件(`@lidozs55/dsh-schedule-bridge`)

> **状态:已立项并落地 v1(2026-10-19)**,位于 `dsh-plugin/dsh-schedule-bridge/`(本仓库,
> host-only bundle,无 client 半、无 UI)。v1 交付两条联动:提醒气泡 + 状态信号。
> 拖拽收纳(文本拖给桌宠→Agent 落库)待 vivarium 基座提供外部拖放目标 API 后立项——
> 契约 v1(clause §2 interactions.drag)只有宠物自身的 move/throw,无内容拖入面。

---

## 1. 职责边界:策略在核心,表面在桥(不变)

| 插件 | 拥有 | 不拥有 |
|---|---|---|
| 核心 `@lidozs55/dsh-schedule` | 数据(domain)、领域服务、通用 Agent 工具、UI 面板、提醒子系统(提前量 Config、`ctx.schedule` 镜像与撤销、投递会话、`upcomingReminders()` 派生集) | 投递表面;桌宠概念;任何学校/导入来源 |
| 来源适配器 `@buaaer/dsh-schedule-buaa` | 北航 SSO、整学期教务导入、`sourceState.buaa` | 日程数据副本;提醒策略;UI 面板 |
| 桥 `@lidozs55/dsh-schedule-bridge` | 跨插件 UX:提醒→桌宠 notice 气泡(含「已完成」快捷动作)、任务状态信号广播 | 数据副本;提醒策略与时序真相;UI |

时序真相只有一个(`ctx.schedule`,归核心插件);投递表面可以有多个(会话消息兜底,桌宠气泡增强)。
桌宠关闭、桥卸载、vivarium 整个不存在——提醒仍完整可用。桥 `inject: ['scheduleCore', 'vivarium']`,
任一缺席则 cordis 把桥 park 掉,核心插件无感。来源适配器同理:`inject: ['scheduleCore', ...]`,
卸载北航插件不影响已有课程/任务/条目与提醒。

## 2. v1 两条联动(已实现)

### 2.1 提醒气泡(notice)

核心插件把截止镜像进 `ctx.schedule`(会话投递兜底);桥每 60s 读 `service.upcomingReminders()`
(派生集已含各自提前量——**提前量策略只存核心 Config 一处,桥不自配**)。提醒时刻进入
`[at−60s, at+60s]` 窗口即 `ctx.vivarium.notices.post`:

- `id = sched-rem-<taskId>-<due>`(确定性 id:重复 post 被 broker 以 duplicate-id 拒绝,天然去重);
- `actions`:「知道了」(ack) + 「已完成」(complete)——**点已完成直接把任务置 completed**
  (`service.setTaskCompleted`,这是 v1 最有价值的 UX);ack 只是收下气泡,确认 ≠ 完成;
- `ttlMs = 30min`,过期不重弹,由会话投递兜底;
- 用户点了哪个动作,broker 的 `settled(id)` Promise 就以该 action id 结算。

窗口语义说明:派生集只含未来时刻,一旦过点即从集合消失;60s 提前量 = 至多早一分钟弹出、
绝不漏发。核心 Config 关闭提醒子系统时派生集为空,气泡同步静默(策略一致性)。

### 2.2 状态信号(喂源语义,host 侧 emit)

- `sched.tasks.updated`:`{ pending, overdue, dueToday, next: {title, due}|null }`
  ——物种包可据此戴徽标/变担心/庆祝清零;每次 `service.subscribe` 变更 + 每 5 分钟重发;
- `sched.data.changed`:`{ tables }` ——课程/条目/任务写入后的轻量通知(如"课表更新了")。

信号名用桥自己的 `sched.` 前缀(vivarium 契约 §4:喂源必须用包名前缀,保留前缀不可占)。
桥不注册 client 喂源描述符——host 侧 `ctx.vivarium.emit` 直达信号枢纽,无需页面侧登记。

## 3. 接口契约(实现遵守)

- 桥读核心插件:`inject: ['scheduleCore']`,只用 `upcomingReminders()` / `listTasks` /
  `setTaskCompleted` / `subscribe`——读为主,唯一写面是气泡上的「已完成」。
- 桥对 vivarium:只用稳定面 `notices.post/settled`、`emit`、`every`(契约 §1 VivariumHostApi)。
- 桥不落任何业务数据;去重靠 notice id,计数每次现算。
- Config 只有两个开关:`noticeOnReminder`(默认真)、`statusSignals`(默认真)。

## 4. 延后项

- **拖拽收纳**(v1 §2.1 设想):等 vivarium 外部拖放目标 API;语义沿用剪贴板页(暂存→交给
  Agent 调 `sched_*` 落库),`source: 'agent'` 不变。
- **课程上课提醒**:核心提醒子系统目前只覆盖任务截止;occurrence 推导型提醒(上课前
  X 分钟,含教室)可在此立项——需要桥或核心对 `weekOccurrences` 做时刻监视,且去重键
  要含日期。核对照录见 `00` §7 延后项。
- **徽标常驻**:物种包消费 `sched.tasks.updated` 即可实现,桥无需改动。
