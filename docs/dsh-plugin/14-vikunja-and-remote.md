# 14 · Vikunja 借鉴分析与多端访问（remote-web-ui 适配）

> 状态：研究结论存档（2026-10-21 三路调研：本仓现状盘点 / Vikunja 官方文档与源码 /
> dsh-web `packages/dsh-remote-web-ui` 源码）。本文只记录事实与决策，落地进度见文末日志。

## 0. 背景与问题

- 用户反馈 Vikunja（github.com/go-vikunja/vikunja）好用，值得学习其操作逻辑与原子功能。
- Vikunja 的多端同步是它的优势；我们的形态是 DSH 宿主内插件（无独立后端），多端访问
  需要另找出路——候选是 dsh-web 生态的 `@linxin666/dsh-remote-web-ui`（手机浏览器远程
  使用本机 Web GUI），由我们做移动端适配。

## 1. Vikunja 是什么（操作逻辑）

对象模型（v2.7.1，2026-10）：`User ─ Team → Project（可嵌套）→ Task`，Task 周边有
子任务、Label、Assignee、附件、评论、**多个 Reminder**、时间记录、11 种关联；
每个 Project 可建多个 **View**（List/Table/Kanban/Gantt，各带独立筛选器，任务排序
位置按视图分别保存）；Saved Filter 是跨项目的个人虚拟项目；每用户一个 Inbox 收集箱。
老的 namespace→list 两层模型 2023 年已移除；**没有 Calendar 视图**——日历能力走
CalDAV 外接（它本质是待办工具）。

任务生命周期：创建（Quick Add Magic 内联解析）→ 排期（start/end/due 三日期）→
提醒（多个，绝对或相对 due/start/end 的偏移秒数）→ 完成（记录 done_at）→
重复任务在完成时**原地重算下一实例并重开**（不是复制副本）。

Quick Add Magic 语法（vikunja.io/help/quick-add-magic）：自然语言日期
（`tomorrow at 5pm` / `in 5 days` / `next monday`）、重复（`every week monday at 10am`）、
`!1`–`!5` 优先级、`*label`（不存在自动建）、`+"项目名"`、`@user`、整句引号跳过解析、
缩进行=子任务。纯前端解析，无 LLM。

## 2. 多端同步的真相

Vikunja 没有同步算法：自托管 Go 服务端 + REST API + 瘦客户端（web=Vue3+PWA、
desktop=Electron 壳、移动端=Flutter）。客户端**无本地数据库、基本无离线能力**，
冲突处理未文档化。它的多端优势完全来自「有一个常驻中心服务端」，各端实时拉取收敛。

**对应到我们：DSH 宿主本身就是常驻服务端。** 不需要自建任何同步层，让手机连上宿主
即可——这正是 remote-web-ui 干的事。

## 3. remote-web-ui 适配评估（已核对它的源码）

它是一个跑在 dsh web 宿主进程内的 Cordis 插件：手机扫码配对（限时 QR + 一次性
grant + 365 天设备 cookie），浏览器里加载的就是官方原版 Web GUI，插件只做配对门控的
HTTP/WS 回环反代 + 防火墙管理 + 可选 cloudflared/relay 隧道。配对设备是宿主的
完整客户端，宿主数据是唯一权威，双端同时在线是常态。

对本插件的兼容性核对：

| 项目 | 结论 |
| --- | --- |
| `/api/schedule-core` 通道 | ✅ 在它的 `/api/*` 代理白名单内，client 用 `fetch`（会被重写），零改动 |
| 提醒轮询 | ✅ 纯 HTTP 轮询照常工作；LAN 直连非安全上下文时 Web Notification 不可用，落进现成 in-page toast 退路（走 HTTPS 隧道则可用） |
| 面板注册（main/panellist/settings） | ✅ 不在它的移动端隐藏名单里，正常渲染到手机中列 |
| 右键建幽灵块/右键开编辑、双击、hover | ❌ 触屏无右键无 hover → 需长按替代 |
| 拖拽/缩放 | ⚠️ Pointer Events 可用，但缺 `pointercancel` 清理（触屏滚动接管时监听器泄漏），需触控热区与滚动调和 |
| 固定 7 列网格 | ⚠️ 手机竖屏过挤 → 需日视图 |
| 剪贴板队列 | ⚠️ 远程端读到手机自己的剪贴板（iOS Safari 基本不可用）；现容错会优雅退化 |
| 提醒去重 | 双端 origin 不同，去重各自独立——双端同时在线各弹一次，属预期语义 |

安全须知：**配对设备 = 完全控制凭据**（能访问宿主全部 API，含会话/设置/凭据），
不是「只读日程」；默认开启的 relay 固定子域流量过作者的 Cloudflare Worker，介意
课表等个人数据过第三方的话优先 LAN 直连或自建命名隧道。

替代路线：同仓库 `dsh-remote-bridge`（`/ios/v1` WebSocket，面向原生客户端）+
`dsh-task-board-remote`（参考实现：`registerMethods` + `broadcast('board.changed',
{revision})`）——将来要做原生手机小组件/锁屏提醒时是现成协议缝；「手机浏览器能操作
日程」走 remote-web-ui 即可，不必碰 bridge。

## 4. 借鉴决策（对照本仓现状）

本仓现状：条目/任务有 `id`/`updatedAt`/`sourceKey`；任务是纯截止待办（无开始时间/
重复）；提醒是全局四档固定提前量（作业 30min/考试 1440min/其他 30min/条目 15min，
index.js Config）；任务页固定分组；只有周网格一种视图。

按性价比排序，采纳：

1. **按条目/任务定制提醒提前量**（Vikunja 的相对提醒思想，单值子集）：`remindLead`
   可空分钟数，null=跟随全局四档，0=准时；schema/派生/编辑器/Agent 工具全链路。
   ——采纳，本批实现。
2. **触屏长按替代右键** + `pointercancel` 清理 + 触控热区/字号 + 窄屏日视图：
   remote-web-ui 适配的四件套。——采纳，本批实现。
3. 重复任务原地重生语义（适合「每周作业」类）：**延后**，等按条目提醒验证后再议。
4. Quick Add 子集语法：**暂不做**。我们的「自然语言建日程 = Agent 调 `sched_*` 工具」
   已是 quick add 的 LLM 增强版（剪贴板队列→发新会话即 Inbox 思路变体），UI 内再放
   一套正则语法收益有限。
5. 保存筛选器/视图抽象/软删除/稳定引用：延后。

不学（天然依赖服务端，我们的形态已免掉）：团队/链接分享、@提及订阅、webhook、
API token、OAuth、CalDAV 服务端、邮件通知。

## 5. 落地日志

- 2026-10-22：本文建档。同批实现 §4 的 1–2（`remindLead` 全链路 + 触屏四件套），
  见后续 git 提交与 README/SKILL 更新。

## 6. 参考来源

- Vikunja：vikunja.io/help/{quick-add-magic, dates-and-reminders, views, tasks,
  filters, saved-filters, caldav, sharing-and-teams, webhooks, import-and-export}；
  源码 go-vikunja/vikunja `pkg/models/{tasks.go, task_reminder.go}`。
- dsh-web：github.com/zhu1090093659/dsh-web `packages/dsh-remote-web-ui`
  （`src/remote-channel-rules.ts` 白名单、`src/loopback-proxy.ts` 回环代理、
  `src/client/mobile-adapt.ts` 移动适配层）、`packages/dsh-remote-bridge`、
  `packages/dsh-task-board-remote`。
