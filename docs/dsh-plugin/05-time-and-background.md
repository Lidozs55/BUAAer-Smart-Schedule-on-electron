# 05 · 时间、提醒与后台作业

> 本项目的核心需求之一就是"到点提醒"和"跑一会儿的同步"。DSH 侧有三层机制，别用错：
> **进程内定时器**（`ctx.timer`）→ **可观察的后台作业**（`ctx.jobs`）→ **平台自动化任务**（`ctx.schedule`）。
> 日程提醒**不使用** `ctx.schedule`：它绑定 Session、会唤醒 Agent，是自动化任务而非通知；
> 本项目改为无状态派生 + 页面轮询 + Web Notification（§4）。
> 签名实测于本机 `0.2.0-rc.2`；`ScheduleRecord` 等类型来自官方文档与包 README。

---

## 1. 选型表

| 需求 | 用什么 | 为什么 |
|---|---|---|
| 防抖搜索、节流刷新、界面倒计时、"5 分钟后重试一次" | `ctx.timer` | 进程内、随插件卸载自动清理 |
| 跑几十秒的活儿：抓 7 天课表、批量导出、OCR | `ctx.jobs` | 有 id、有状态、有输出环、可取消、能让 UI 流式看 |
| 页面内提醒（任务/上课/条目） | 核心 `host/reminders.js` 派生 + `client.notify.js` 30s 轮询 + Web Notification | 纯通知、不建会话、不耗 token；页面打开时有效 |
| 让 Agent 按周期主动干活（如二游周检） | `ctx.schedule` | 真正需要 Agent 的任务；绑定 Session、会耗 token |
| 让 Agent 因为定时事件主动干活 | `agent.followup()` | 会唤醒 agent；`agent.inject()` **不会** |

---

## 2. `ctx.timer`：可释放的定时器助手

```ts
timeout(callback: () => void, delay: number): () => void
timeout(delay: number): Promise<void>
interval(callback: () => void, delay: number): () => void
interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>
throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): F & { dispose: () => void }
debounce<F extends (...args: any[]) => void>(callback: F, delay: number): F & { dispose: () => void }
```

这些助手混入 Cordis context，返回值就是清理函数——**放进 `ctx.effect` 里**，插件卸载时定时器自动消失：

```js
export function apply(ctx) {
  ctx.effect(() => ctx.timer.interval(() => {
    const agent = ctx.get('agents')?.roots()[0];
    // 定时器里要 agent 干活必须用 followup()：inject() 不会唤醒它
    agent?.followup();
  }, 60_000));
}
```

不要用裸 `setInterval`：它不属于任何 effect，卸载后仍在跑。

---

## 3. `ctx.jobs`：后台作业（可观察、可取消）

`ctx.jobs` 是抽象 seam（实现为 `@deepseek-ai/dsh-jobs-local`，进程本地注册表）。方法：

```ts
abstract readonly events: JobEvents
abstract start(spec: JobSpec): JobId
abstract list(caller?: SessionId): JobView[]
abstract get(id: JobId, caller?: SessionId): JobView
abstract read(id: JobId, caller?: SessionId): JobRead
abstract readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead
abstract kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished'
abstract wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView>
abstract remove(id: JobId, caller?: SessionId): void
abstract attachController(name: string): () => void
```

生产方约定（官方原文要点）：运行时完成预检后，带着该 job 的 `JobHandle` 调用 `run()`，随后提交注册，**不再执行可能失败的步骤**。生产方拥有执行资源；运行时拥有身份、访问、生命周期状态与输出环。

```ts
interface JobSpec {
  kind: JobKind          // 生产方种类，同时是 id 前缀
  label: string
  owner?: SessionId      // 省略即"无主作业"，对任何 caller 开放，直到服务释放
  outputLimitBytes?: number
  output?: readonly JobOutputSource[]
  run(job: JobHandle): JobHooks
}

interface JobHandle {
  readonly id: JobId
  append(text: string, options?: JobAppendOptions): void
  updateProgress(line: string): void
}

interface JobHooks {
  cancel(reason?: string): void
  done: Promise<JobOutcome>
}

interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  result?: string
}
```

`JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'`。生成方在 `packages/jobs/jobs` 里通过 declaration merging 扩展 `JobKindMap`（如 `bash`、`subagent`）。

要点与坑：

- **`start` 在"没有已挂载的 job controller 服务于该 owner"时拒绝开工**——也就是说作业的 owner 必须是某个 Session，或该 job 明确无主。
- 输出是**按绝对字节偏移**读取的：`read(id)` 用游标消费，`readAt(id, from)` 让任意多个观察者各自读，互不干扰。`JobChannel` 区分 `stdout` / `stderr` / `log`。生产方的 `JobOutcome.result` 只在**结算后的第一次 read** 交出。
- **结算先到先得**；已结算的记录会一直留在列表里，直到 owner 释放、服务释放或显式 `remove`。
- **作业不是持久化的**：文档只承诺"活得比生产方与 controller 的 fiber 更久"，**没有任何地方承诺跨 Host 重启存活**。跨重启要用存储 domain；`ctx.schedule` 只用于需要 Agent 的定时任务。
- 本地实现的默认限制：`maxConcurrentJobsPerOwner` 10（按精确 owner 计 `running` + `stopping`，无主作业共用一个桶）、`retainBytes` 256 KiB、`settledRetainBytes` 16 KiB、`pumpPollMs` 150。
- 浏览器侧有一个现成的作业列表面板（`@deepseek-ai/dsh-client-ui-jobs`）；`ctx.jobController` 提供 `@Remote({ mode: 'stream' }) list/follow` 与 `@Remote('kill') kill`。**不要**自己再写一套轮询。

本项目**不使用 jobs**：教务同步是"一次登录 + 两个整学期请求"，秒级完成，同步跑在工具调用里
（`buaa_course_sync` 的 `timeoutMs` 180 s）比给用户维护一个作业列表更合适。需要多步进度时再考虑
`ctx.jobs`（它不跨重启，长期任务仍应落存储 domain；只有确实需要 Agent 定时干活时才用 `ctx.schedule`）。

---

## 4. `ctx.schedule`：平台自动化任务（日程提醒不使用）

```ts
async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord>
@Remote('list')    async list(request: ScheduleListRequest): Promise<ScheduleRecord[]>
@Remote('catalog') async catalog(): Promise<ScheduleCatalogEntry[]>
@Remote('history') async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>
@Remote('delete')  async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult>
@Remote('update')  async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult>
```

- **语义**：`create(sessionId, …)` 绑定一个 Session；到点由宿主 `sessionController.resolveAgent`
  恢复该会话，把 `prompt` 追加进收件箱并让 Agent 跑一轮。它是“定时 Agent 任务”，不是通知服务。
- 记录持久在 `schedule` 存储 domain，带 `status` / `lastDelivery`，跨重启补投；同一 Session 的
  到期重复任务可合并成一条消息。
- 官方 Web profile 默认不含「自动化任务」bundle；要启用需在插件管理页打开它。该能力也不能
  挂在 headless / 仅 SDK 的部署里。

### 本项目为什么不用它做提醒（2026-10-21 决策）

日程提醒曾把任务截止镜像成 `ctx.schedule` 记录，投递到一个专用会话。这个做法混淆了两个
同名的 “task”：

| 概念 | 业务任务 | `ctx.schedule` 的 task |
|---|---|---|
| 含义 | 作业/考试/待办，有截止时间 | 定时执行的 Agent 作业 |
| 到点后 | 应该通知用户 | 唤醒 Agent 跑 prompt |
| 成本 | 一条通知 | 一次 Agent 轮次 |
| 可见性 | 通知/角标/气泡 | 用户要打开那个会话 |

结果就是：每条提醒花 token、用户不打开会话就查收不到、还要维护专用会话并受归档限制。

**现在的实现**（`00` §4.4、`09` §2.1）：

- `host/reminders.js` 无状态派生 `service.upcomingReminders()`（任务/上课/条目三类）；
- 页面打开时 `client.notify.js` 每 30s 轮询 `GET /api/schedule-core?view=reminders`，在
  `at−60s` 窗口内用 Web Notification 呈现；未授权或前台时用页面内 toast；
- 桌宠桥读同一派生集做气泡，是可选增强；
- 不写 `ctx.schedule`、不建 Session、不触发 LLM 轮次、无“是否已提醒”持久状态。

`ctx.schedule` 仍保留给**真正需要 Agent** 的定时任务（例如 gacha 的每周核对 `watch`）。使用它时
必须 `ctx.get('schedule')` 判空，并按“会消耗一次 Agent 轮次”来评估。归档含活跃 schedule 的
会话会被拒绝（`schedule.archiveAdmission()`）。

---

## 5. 人类命令（"我不需要模型也知道"的操作）

`ctx.commands.register(definition)`，返回精确的卸载函数。定义形状：

```ts
interface CommandDefinition {
  readonly definitionId?: CommandDefinitionId
  readonly name: string              // 小写、不带前导斜杠
  readonly description: string
  readonly input?: CommandInputDescriptor   // { hint, attachments? }
  readonly recordInput?: boolean
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

interface CommandInvocation {
  readonly commandId: CommandId
  readonly agent: Agent
  readonly rawInput: string
  readonly attachments: readonly (ImageBlock | FileBlock)[]
  readonly signal: AbortSignal
}

type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: SessionSeq }
  | { readonly kind: 'error'; readonly text: string }
```

- 普通 context 上注册的定义是**全局**的；通过注入了 command 的 agent 子 context 注册的定义对该 agent 遮蔽全局。
- 调用前追加 `command/run`、结算后追加 `command/done`（handler 抛错或被中断都记成 `kind: 'error'`），两者都是直接的"只写日志"追加，**不包在 turn 里**。
- 事件 `'commands/change'()`：命令注册/注销后发出。
- 客户端用 `ctx.remote.commands.execute(agent, line, submittedAttachments, signal)` 执行；`ctx.remote.commands.list()` 拿目录。**这是手写插件让 UI 触发 Host 操作的最省事路径**（见 `03-client-ui.md`）。

本插件**不注册任何命令**。教务导入带密码，而命令输入会被记进会话日志；且整学期课表一学期只拉
一次，没有值得做成快捷键的重复动作——导入走设置卡或 `buaa_course_sync` 工具。

---

## 6. 不要做的事

- ❌ 用裸 `setInterval` / `setTimeout`（不随卸载清理）。
- ❌ 用 `agent.inject()` 期待 agent 自己醒（它只进收件箱）；要唤醒用 `agent.followup()`。
- ❌ 轮询 `agent/status` 判断是否忙；等持久事件（`turn/end`、`assistant/message`、`tool/result`），实时 token 用 `agent/assistant-stream`。
- ❌ 把"跨重启仍然有效"寄托在 `ctx.jobs` 上。
- ❌ 把 `ctx.schedule` 当必然存在的能力（它是可选 bundle）；日程提醒更不要用它——它会唤醒 Agent、消耗 token。
- ❌ 在客户端直接轮询数据库里的到期时间并复制一套提前量；页面通知只轮询宿主派生集（`GET /api/schedule-core?view=reminders`），策略仍在核心 Config 一处。
