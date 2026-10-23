# 05 · 时间、提醒与后台作业

> 本项目的核心需求之一就是"到点提醒"和"跑一会儿的同步"。DSH 侧有三层机制，别用错：
> **进程内定时器**（`ctx.timer`）→ **可观察的后台作业**（`ctx.jobs`）→ **平台自动化任务**（按需；提醒见 §4）。
> 签名实测于本机 `0.2.0-rc.2`；`ScheduleRecord` 等类型来自官方文档与包 README。

---

## 1. 选型表

| 需求 | 用什么 | 为什么 |
|---|---|---|
| 防抖搜索、节流刷新、界面倒计时、"5 分钟后重试一次" | `ctx.timer` | 进程内、随插件卸载自动清理 |
| 页面存活期间刷新 SPOC 作业截止时间 | `ctx.timer` + 北航来源插件的内存会话 | 每 30 分钟一次；关闭开关、无会话或无学期起点时直接跳过，不接触密码 |
| 跑几十秒的活儿：抓取远端数据、批量导出、OCR | `ctx.jobs` | 有 id、有状态、有输出环、可取消、能让 UI 流式看 |
| 页面内提醒（任务/条目） | 核心 `host/reminders.js` 派生 + `client.notify.js` 30s 轮询 + Web Notification | 页面打开时每 30s 检查，Web Notification/页面内 toast 呈现 |
| 让 Agent 按周期主动干活（如二游周检） | 平台「自动化任务」能力 | 绑定 Session、消耗 Agent 轮次 |
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

> **Host 侧必须先声明 `inject`**：`ctx.timer` 是注入的服务，宿主插件只写
> `ctx.timer` 而不在 `export const inject` 里列 `'timer'`，激活时会报
> `cannot get property "timer" without inject`（本仓库 gacha 插件曾踩过）。
> 客户端 bundle 的 `dsh.client.inject` 同理要列 `timer`。

**北航 SPOC 作业轮询**（`dsh-schedule-buaa/index.js`）：`inject` 已含 `'timer'`，
每 30 分钟调用一次 `runSpocPoll()`：

```js
ctx.effect(() => ctx.timer.interval(() => {
  void runSpocPoll({ service, spoc })
}, 30 * 60_000), 'buaa-schedule: SPOC poll')
```

它只在「开关未关闭 + 内存里已有会话 + 已配置学期起点」时发请求；没有密码，也没有
`ctx.jobs`。会话过期时 `spoc.js` 清掉内存会话并记录 `spocError`，轮询自然停止，
设置卡提示用户再手动同步一次。这样既满足作业截止时间会变的需求，又不把密码或
token 写进磁盘。

iclass 远程签到的 `userId`/`sessionId` 也只在手动同步时建立，存 `host/signin.js` 的进程内存，
不做周期轮询。用户点击条目上的「远程签到」时才读当天 iclass 课表并提交；宿主重启后同样
需要再手动同步一次。

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
- **作业不是持久化的**：文档只承诺"活得比生产方与 controller 的 fiber 更久"，**没有任何地方承诺跨 Host 重启存活**。跨重启要用存储 domain；需要 Agent 定时干活时用平台「自动化任务」能力。
- 本地实现的默认限制：`maxConcurrentJobsPerOwner` 10（按精确 owner 计 `running` + `stopping`，无主作业共用一个桶）、`retainBytes` 256 KiB、`settledRetainBytes` 16 KiB、`pumpPollMs` 150。
- 浏览器侧有一个现成的作业列表面板（`@deepseek-ai/dsh-client-ui-jobs`）；`ctx.jobController` 提供 `@Remote({ mode: 'stream' }) list/follow` 与 `@Remote('kill') kill`。**不要**自己再写一套轮询。

本项目**不使用 jobs**：教务同步是"一次登录 + 两个整学期请求 + SPOC 作业分页"，秒级完成，同步跑在 CLI 命令里
（`schedule buaa sync` 的 `timeoutMs` 180 s）比给用户维护一个作业列表更合适；SPOC 的 30 分钟增量刷新
用 `ctx.timer` 即可，不需要可观察作业。需要多步进度时再考虑 `ctx.jobs`（它不跨重启，
长期任务仍应落存储 domain；需要 Agent 定时干活时用平台「自动化任务」能力）。

---

## 4. 提醒：无状态派生 + 页面轮询

核心 `host/reminders.js` 按 Config 提前量现算 `service.upcomingReminders()`：任务按截止时间派生，
条目按开始时间派生并携带 `location`，两类都带 `kind: 'task'|'entry'` 与确定性 `key`。
`client.notify.js` 在页面打开时每 30s 轮询 `GET /api/schedule-core?view=reminders`，在 `at−60s`
窗口内显示 Web Notification（未授权或前台时用页面内 toast），按 `key@at` 去重；桌宠桥读同一
派生集做气泡。提醒无持久状态，`remindersEnabled: false` 时派生集为空。

> 踩坑：`ctx.schedule` 是定时 Agent 任务——到点唤醒绑定会话的 Agent 执行 prompt、消耗 token；
> 通知需求不要走它。真正需要 Agent 定时干活时（如 gacha 周检）再用平台「自动化任务」能力。

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

本插件**不注册任何 DSH Session 命令**。教务导入带密码，而命令输入会被记进会话日志；且整学期
课表一学期只拉一次，没有值得做成快捷键的重复动作——导入走设置卡或 `schedule buaa sync` 命令。

---

## 6. 不要做的事

- ❌ 用裸 `setInterval` / `setTimeout`（不随卸载清理）。
- ❌ 用 `agent.inject()` 期待 agent 自己醒（它只进收件箱）；要唤醒用 `agent.followup()`。
- ❌ 轮询 `agent/status` 判断是否忙；等持久事件（`turn/end`、`assistant/message`、`tool/result`），实时 token 用 `agent/assistant-stream`。
- ❌ 把"跨重启仍然有效"寄托在 `ctx.jobs` 上。
- ❌ 在客户端直接轮询数据库里的到期时间并复制一套提前量；页面通知只轮询宿主派生集（`GET /api/schedule-core?view=reminders`），策略仍在核心 Config 一处。
