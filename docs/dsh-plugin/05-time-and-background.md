# 05 · 时间、提醒与后台作业

> 本项目的核心需求之一就是"到点提醒"和"跑一会儿的同步"。DSH 侧有三层机制，别用错：
> **进程内定时器**（`ctx.timer`）→ **可观察的后台作业**（`ctx.jobs`）→ **持久提醒**（`ctx.schedule`）。
> 签名实测于本机 `0.2.0-rc.2`；`ScheduleRecord` 等类型来自官方文档与包 README。

---

## 1. 选型表

| 需求 | 用什么 | 为什么 |
|---|---|---|
| 防抖搜索、节流刷新、界面倒计时、"5 分钟后重试一次" | `ctx.timer` | 进程内、随插件卸载自动清理 |
| 跑几十秒的活儿：抓 7 天课表、批量导出、OCR | `ctx.jobs` | 有 id、有状态、有输出环、可取消、能让 UI 流式看 |
| "明天 8:00 提醒我交作业"、"每周一晚提醒" | `ctx.schedule` | 持久化、跨重启、到点投递**回原 Session** |
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
- **作业不是持久化的**：文档只承诺"活得比生产方与 controller 的 fiber 更久"，**没有任何地方承诺跨 Host 重启存活**。跨重启要用 `ctx.schedule` 或存储 domain。
- 本地实现的默认限制：`maxConcurrentJobsPerOwner` 10（按精确 owner 计 `running` + `stopping`，无主作业共用一个桶）、`retainBytes` 256 KiB、`settledRetainBytes` 16 KiB、`pumpPollMs` 150。
- 浏览器侧有一个现成的作业列表面板（`@deepseek-ai/dsh-client-ui-jobs`）；`ctx.jobController` 提供 `@Remote({ mode: 'stream' }) list/follow` 与 `@Remote('kill') kill`。**不要**自己再写一套轮询。

本项目**不使用 jobs**：教务同步是"一次登录 + 两个整学期请求"，秒级完成，同步跑在工具调用里
（`buaa_course_sync` 的 `timeoutMs` 180 s）比给用户维护一个作业列表更合适。需要多步进度时再考虑
`ctx.jobs`（它不跨重启，长期任务仍应落 `ctx.schedule` 或存储 domain）。

---

## 4. `ctx.schedule`：持久提醒（本项目的"提醒服务"）

```ts
async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord>
@Remote('list')    async list(request: ScheduleListRequest): Promise<ScheduleRecord[]>
@Remote('catalog') async catalog(): Promise<ScheduleCatalogEntry[]>
@Remote('history') async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>
@Remote('delete')  async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult>
@Remote('update')  async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult>
```

- 服务描述："Shared management service; reads, deletion, and timing edits never activate a Session."
- 事件：`'schedule/changed'()` —— 持久任务集变化，客户端重新拉取全局与 Session 活跃目录。
- 记录持久在 `schedule` 存储 domain 的 `tasks` 表（version 1），**绑定原 `sessionId`**，带 `status: 'active' | 'inactive'` 与可选 `lastDelivery`；`title` 去除首尾空白后必须非空且 ≤ 120 字符；缺状态的记录规范化为 `active`；创建时把目标时间规范化为 **RFC 3339 UTC**。
- 六选一的创建选择器（`ScheduleCreateRequest` 里恰好给一个）：`after_seconds` / `at` / `every_seconds` / `daily` / `weekly` / `cron`，外加必填 `prompt` 与 `title`。
  - `every_seconds` 最小 **60**；`daily`/`weekly` 必须显式给 IANA `time_zone`；`cron` 是 5 段 Vixie 表达式 + `time_zone`。
- 投递：通过 `sessionController.resolveAgent` 解析原会话；插件来源的 `followup()` 同步把消息追加到会话收件箱，会话 flush 成功后确认持久投递；随后更新 `lastDelivery` 并把回执与提示文本快照追加进 `deliveryHistory.records`。宿主启动时读取持久任务并把定时器设为最早的活动目标；重启后会补投"逾期的一次性提醒"或"每条重复任务最近错过的一次"；同一 Session 的到期重复任务可以合并成一条消息。消息带 `[SCHEDULE REMINDER]` / `[SCHEDULE REMINDER BATCH]` 框架。

### ⚠️ 重要前提：Schedule 是可选的

实测本机 profile 的 Config 目录里**没有任何 `@deepseek-ai/dsh-schedule` 条目**（193 个 entry 里 0 命中），即当前部署确实没有挂载它——所以判空分支不是形式主义，是必要条件。

官方发布版 Web profile **不含 Schedule**。要启用：在插件管理页的"官方"分组里启用**「自动化任务」**，它会把可选实验性 bundle `@deepseek-ai/dsh-experimental-schedule-bundle` 连同时钟上下文加入组合。另外：Schedule **不能**挂在 headless / 仅 SDK 的部署里——投递需要 Host 的 Web Session controller 与 Session 持久化后端。

因此插件里取用 `ctx.schedule` 时要显式决定形态：

```js
const schedule = ctx.get('schedule');
if (!schedule) return;   // 可选形态：该 profile 没启用自动化任务，安静降级
```

> **本插件的实际选择**（2026-10-17 权衡，见 `00-architecture.md` §4.3）：`schedule`/`sessionController`
> 声明为**必需 inject**（确定性优先），代价是缺这些提供者的精简 profile 上整个插件不激活；
> web/desktop 部署恒提供，当前可接受。上面的可选形态是通用写法，不是本项目现状。

用户侧用法：启用后直接对模型说"每天 Asia/Shanghai 时区 23:00 提醒我查看天气"，或在「自动化任务」页面点「新建」（会开一个新会话，composer 里已写好该请求）。模型工具是 `schedule_create` / `schedule_list` / `schedule_delete` / `schedule_update`（Schedule 加载期间注册在活动根 Agent 的作用域中）。

### 本项目怎么接

- 课程/作业/考试的"提前 X 分钟"提醒：X 来自插件 `Config`；到点前用 `every_seconds`/`daily`/`cron` 排程，或在同步数据时就为每条截止时间登记 `at` 提醒。
- 现有 Flask 侧其实**没有**后台调度（`/api/reminders/upcoming` 只是个 getter，前端 60 s 轮询 + Web Notification）。迁移后由 `ctx.schedule` 真正承担"到点提醒"，交付方式是投递回原 Session（用户在会话里被提醒），而不是系统托盘弹窗——插件的 UI 只能出现在 Web 页面里。
- 归档含活跃提醒的会话会被拒绝（`schedule.archiveAdmission()` 给 Workspace 注册表回答归档准入）；设计交互时要把这条讲给用户。

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
- ❌ 把 `ctx.schedule` 当必然存在的能力（它是可选 bundle）。
- ❌ 自己实现一套"轮询数据库里的到期时间再弹 Web Notification"（这正是现在前端的做法，也是要淘汰的东西）。
