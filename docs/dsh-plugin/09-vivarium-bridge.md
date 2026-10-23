# 09 · vivarium 桥插件(`@lidozs55/dsh-schedule-bridge`)

> **状态:已立项并落地设计 v2(2026-10-21;包版本 0.1.0)**,位于 `dsh-plugin/dsh-schedule-bridge/`(本仓库,
> host-only bundle,无 client 半、无 UI)。v2 在 v1 的两条联动上扩展:提醒气泡统一覆盖任务截止/
> 日程条目两类,任务状态改走基座 `tasks.report`(vivarium §4c/ADR-013);**2026-10-22 新增第三条:
> 文本/图片拖给桌宠 → 核心待确认暂存 → 点「确认」直接新建 Agent 会话**(vivarium §4d/ADR-015/ADR-016,
> 不解析、不 OCR、不调 LLM;写入前由 Agent 再请用户确认)。v1 的边界
> (时序策略归核心、桥只做表面、读派生集为主且唯一写面是气泡「已完成」)不变。

---

## 1. 职责边界:策略在核心,表面在桥(不变)

| 插件 | 拥有 | 不拥有 |
|---|---|---|
| 核心 `@lidozs55/dsh-schedule` | 数据(domain)、领域服务、`schedule` CLI、UI 面板、提醒子系统(提前量 Config、无状态 `upcomingReminders()` 派生集、页面 30s 轮询 + Web Notification/toast) | 桌宠概念;任何学校/导入来源 |
| 来源适配器 `@buaaer/dsh-schedule-buaa` | 北航 SSO、整学期教务导入、`sourceState.buaa` | 日程数据副本;提醒策略;UI 面板 |
| 桥 `@lidozs55/dsh-schedule-bridge` | 跨插件 UX:提醒→桌宠 notice 气泡(任务含「已完成」快捷动作,条目仅「知道了」)、任务状态上报(基座 `tasks` 状态面)、外部文本/图片→核心待确认暂存→点「确认」新建会话 | 数据副本;提醒策略与时序真相;宠物语义(逾期担忧/清空庆祝的推导归基座);自然语言解析/OCR/LLM;UI |

提醒的时序真相只有一个:核心 `service.upcomingReminders()` 纯派生,任务/条目两类同权。
投递表面可以有多个,都读同一派生集:**页面通知**(核心 `client.notify.js`,30s 轮询 + Web
Notification/页面内 toast)和**桌宠气泡**(桥,可选增强)。桥
`inject: ['scheduleCore', 'vivarium']`,任一缺席则 cordis 把桥 park 掉,核心插件无感;来源适配器同理:`inject: ['scheduleCore', ...]`,卸载北航插件不影响
已有任务/条目与提醒。

## 2. v2 三条联动(已实现)

### 2.1 提醒气泡(notice)

核心插件派生「提醒时刻」集合，只有任务与条目两类；教学安排、考试、会议都由普通条目路径派生，地点统一 `location`。考试条目走考试提前量，其他条目走 `eventLeadMinutes`；提前量只存核心 Config 一处。
桥每 60s 读 `service.upcomingReminders()`（`kind: 'task'|'entry'` 与确定性 `key`），提醒时刻进入投递窗口即 `ctx.vivarium.notices.post`：

- `id = sched-rem-<key>`（任务键 `<taskId>`，条目键 `entry-<id>`）；重复 post 由 broker 去重。
- 任务文案配「知道了」+「已完成」，后者调用 `service.setTaskCompleted`；条目文案显示类别/起始时间/`location`，全天条目显示日期与「全天」，配「知道了」。
- `ttlMs = 30min`,过期不重弹;
- 用户点了哪个动作,broker 的 `settled(id)` Promise 就以该 action id 结算。

窗口语义说明:派生集只含未来时刻,一旦过点即从集合消失;60s 提前量 = 至多早一分钟弹出、
绝不漏发。核心 Config 关闭提醒时派生集为空,气泡与页面通知同步静默(策略一致性)。

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

### 2.3 拖拽收纳(基座 §4d `drops.onDrop`,2026-10-22;图片与确认即会话 2026-10-23)

用户把浏览器/编辑器里的文本,或截图/图片文件拖到桌宠轮廓上,期望「收下」;点「确认」后
直接新建 Agent 会话,不再经过剪贴板页。链路仍保持两头分离:

1. 基座壳页捕获 `text/plain` 或 `Files`(仅命中宠物轮廓),校验文本与图片后 `POST
   /vivarium/drop`,发布 `drop.text` / `drop.images`,再调统一面
   `vivarium.drops.onDrop({ text?, images? })` 分发给桥;只有旧基座才回退到
   `drops.onText(text)`。
2. 桥调核心的独立暂存服务 `service.dropbox.stage(drop)`(host 内存队列,上限 10 条、单条
   8000 字符、最多 4 张图片、单张解码后 20 MiB、不入库、不 bump revision),行初始为
   `pending`;空载荷/非法图片返回 null,不弹气泡。暂存队列刻意不是 `scheduleCore` 的业务
   方法:它是桥(host)与日程客户端(client)之间的传输信箱,不是日历/任务数据,隔离在
   `host/dropbox.js`。
3. 桥发一条 30s TTL 的 notice,动作为「确认 / 取消」。`confirm` 把行标为 `confirmed`;
   `deny`、过期、撤回或 post 失败都丢弃该行。气泡失败不回滚——本来就被丢弃。
4. 日程客户端监听器每 1s 调 `POST /api/schedule-core { op: 'listConfirmedDrops' }`,只取
   `confirmed` 行;每行新建会话(失败重试时复用已建会话)并把文本 + 图片附件作为首个提示,
   成功后 `openSession` 并 `ackDrops([id])`。失败保留 confirmed 行,30s 后重试;已交付集合
   防止同页重复提示。待确认行对剪贴板队列不可见。
5. 提示词要求 Agent:先列出拟新增/修改/删除/完成的条目,等用户明确确认后再用 `schedule`
   CLI 落库。图片由 Agent 的多模态输入读取;桥与基座都不解析文本/图片、不判断日程/待办、
   不做 OCR、不调用 LLM。
6. 剪贴板页的原路径不变:系统剪贴板文本每 5s 捕获、图片用「添加图片」或拖到面板加入
   `queue`,点「发送到新会话」走同一套提示;它和桌宠拖放的 pending/confirmed 状态互不混用。

边界:暂存是 scratch 语义,插件/宿主重启即失;confirmed 行在客户端不可用时保留到下次启动,
ack 后才删除。图片限制为 PNG / JPEG / WebP / GIF、单张 20 MiB(与 DSH 默认图片准入一致),
与基座校验一致。旧基座无 `drops.onDrop`/`onText`,或旧核心无 `dropbox.stage` 时桥一次性
warn 并忽略拖放,提醒/任务上报不受影响;Config `dropToAgent: false` 可关闭。

## 3. 接口契约(实现遵守)

- 桥读核心插件:`inject: ['scheduleCore']`,只用 `upcomingReminders()` / `listTasks` /
  `setTaskCompleted` / `subscribe` / `service.dropbox`——读为主,写面只有气泡「已完成」与
  拖放暂存/确认/丢弃;`dropbox` 是 additive 可选项(旧核心缺它时只关拖放)。
- 桥对 vivarium:只用稳定面 `notices.post/settled`、`tasks.report`、`drops.onDrop`(旧基座
  回退 `drops.onText`)、`emit`、`every`(契约 §1 VivariumHostApi);`drops` 为 additive 可选项。
- 核心客户端对 vivarium 的拖放面只调 `service.dropbox.listConfirmedDrops` /
  `ackDrops`,不直接订阅基座信号;确认由桥在 host 侧完成。
- 桥不落任何业务数据;去重靠 notice id,计数每次现算,拖放只入内存队列。
- Config 三个开关:`noticeOnReminder`(默认真)、`statusSignals`(默认真)、`dropToAgent`(默认真)。

## 4. 延后项

- **拖拽收纳**:已实现(见 §2.3);后续只做真实桌面壳的 OS 级拖放抽查与体验打磨。
- **徽标常驻**:任务事实已入 vivarium `/vivarium/state` 快照 `tasks` 字段;物种要常驻「下一截止」
  徽标时,由基座把事实追加上信号线(additive)即可,桥无需改动。
- 提醒模型与提前量的事实基线见 `00` §4.4；桥不新增提醒种类或来源专用地点字段。
