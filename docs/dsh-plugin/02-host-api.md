# 02 · Host 侧接口速查（服务 · 事件 · 配置）

> 本文抄录的是**本机运行时实测**的签名（`@deepseek-ai/dsh-root@0.2.0-rc.2`）。DSH 处于 developer preview，升级后必须重新核对。
> **运行时是权威**：拿不准就去问它，不要靠猜、也不要靠本文（本文只是帮你少问几次）。

---

## 0. 先学会查证（三分钟）

```
# 1) 服务目录（省略 service 时返回紧凑目录）
cordis_inspect_query { platform: "host", provider: "Service", method: "listService" }
# 2) 某个服务的精确契约（含被引用的类型声明）
cordis_inspect_query { platform: "host", provider: "Service", method: "listService",
                       input: { service: "storageDomain" } }
# 3) 事件目录 / 单个事件契约
cordis_inspect_query { platform: "host", provider: "Event", method: "listEvents",
                       input: { event: "tools/pre-execute" } }
# 4) 已安装插件的 Config schema → 先拿 entry id，再取 schema（会给出 packageDir）
cordis_inspect_query { platform: "host", provider: "Config", method: "listConfigs",
                       input: { name: "@deepseek-ai/dsh-storage-domain" } }
# 5) 某个包到底怎么写：用上面的 packageDir 读 <packageDir>/README.md 与 lib/types/**/*.d.ts
```

`Config.listConfigs` 返回的每个 entry 带 `id` / `patchId` / `name` / `status` / `packageDir` / `acceptsMissing` / `schema`。**只有 `status: "schema"` 的 entry 才有 `schema`**；`status: "absent"` 的 entry 没有 schema，也不代表运行时一定没挂载（`schema`/`tree`/`inactive`/`absent` 这套状态词的语义没有任何 inspect 输出解释过，别过度解读）。

---

## 1. 取用模式：`inject` 还是 `ctx.get`

每个服务都提供两种取用方式：

| 方式 | 写法 | 语义 |
|---|---|---|
| 硬依赖 | `export const inject = ['storage']`，正文 `ctx.storage` | 依赖齐备前插件**不加载**（fiber 停在 `PENDING`）；运行中提供方消失时依赖方被自动卸载，服务恢复后自动重新加载 |
| 可选 | `const s = ctx.get('storage')` + 判空 | 该 profile 没有这个能力时安静降级 |

**规则**：插件"机会性读取"但没写进 `inject` 的服务，一律用 `ctx.get(name)`，**绝不要**用 `ctx.<name>` 属性代理——属性代理只沿祖先方向解析 fiber，穿过外层 shadow 会失败；`ctx.get` 是拓扑无关查找（默认 strict：非活跃后端读作 `undefined`）。

自己的服务要给别人用：`export default class X extends Service`（`super(ctx, 'myService')`）+ `declare module '@deepseek-ai/cordis' { interface Context { myService: X } }`，或用 `ctx.provide(name, value)`（返回卸载函数）。`ctx.set` 只能覆盖**已提供**的服务，否则抛错。

---

## 2. 本项目会用到的服务

### 2.1 `ctx.tools` — 工具注册（详见 `06`）

```ts
register(definition: ToolDefinition): () => void
restrict(filter: ToolRestriction): () => void      // { allow?, deny? }，只能移除
guard(guard: ToolGuard): () => void                // 同步；返回字符串即拒绝
get(name: string, scope?: ScopeKey): ToolDefinition | undefined
schemas(scope?: ScopeKey): ToolSchema[]
executionMode(exec: ToolExecutionInput): ToolExecutionMode
async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
```

### 2.2 `ctx.storage` / `ctx.storageDomain` — 持久化（详见 `04`）

```ts
// ctx.storage
readonly backend: BackendRegistry            // register(name, backend) / get(name) / names()
mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void
form<K extends keyof StorageForms>(form: K): StorageForms[K]

// ctx.storageDomain
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
get(name: string): DomainImpl | undefined
async closeAll(): Promise<void>
```

### 2.3 `ctx.timer` / `ctx.jobs` / `ctx.commands` — 时间与人工入口（详见 `05`）

```ts
// ctx.timer（混入 context 的助手，返回值即清理函数）
timeout(callback: () => void, delay: number): () => void
timeout(delay: number): Promise<void>
interval(callback: () => void, delay: number): () => void
interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>
throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): F & { dispose: () => void }
debounce<F extends (...args: any[]) => void>(callback: F, delay: number): F & { dispose: () => void }

// ctx.jobs（抽象 seam；实现 @deepseek-ai/dsh-jobs-local）
readonly events: JobEvents
start(spec: JobSpec): JobId
list(caller?: SessionId): JobView[]
get(id: JobId, caller?: SessionId): JobView
read(id: JobId, caller?: SessionId): JobRead
readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead
kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished'
wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView>
remove(id: JobId, caller?: SessionId): void
attachController(name: string): () => void

// ctx.commands
register(definition: CommandDefinition): () => void
registerFileReceiptResolver(resolver: CommandFileReceiptResolver): () => void
@Remote list(agent: Agent): readonly CommandDescriptor[]
find(agent: Agent, name: string): CommandDefinition | undefined
@Remote async execute(agent: Agent, line: string, submittedAttachments: readonly CommandSubmitAttachment[], signal: AbortSignal): Promise<CommandExecution | undefined>
```

### 2.4 `ctx.systemPrompt` — 提示词贡献

```ts
section(section: PromptSection): () => void
getSectionOrder(name: PromptSectionOrderName): number
getContextOrder(name: PromptContextOrderName): number
context(context: PromptContext): () => void
suppressRuntimeContext(): () => void
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void
async assemble(context: AssembleContext = {}): Promise<PromptAssembly>
```

加"领域说明"用 `section()`；加每个 agent 的临时上下文用 `agent.inject()`。`tools(provider)` 会参与工具 schema 组装——**不要**用它增删工具（用 `ctx.tools.restrict()` 才能保持展示/查找/执行三者一致）。`system-prompt/assemble` 是**专家级整体装配瀑布**，返回的装配结果具有权威性，用它的人有责任保留 PTC 模式与结构化输出协议的贡献。

### 2.5 `ctx.settings` + `Config` — 配置与设置表单

```ts
configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void
prepareDocument(): Promise<string>
describe(options?: SettingsDescribeOptions): SettingsDescriptor[]
async update(ns: string, patch: object, expectedRevision?: number): Promise<void>
async replace(ns: string, section: object, expectedRevision?: number): Promise<void>
async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
```

插件的 `Config` 会被投影成设置表单（字段语义见 §4）。`ctx.settingsController` 是对应的 Remote 面（`describe` / `update` / `replace` / `mutate` / `openSettingsDocument`），**每次远端读取都 `redactSecrets: true`**。事件：`'settings/document-updated'(ns: SettingsNamespace, revision: number)`。

### 2.6 `ctx.credentials` — 凭据

```ts
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
abstract describe(ref: CredentialRef): Promise<CredentialInfo>
abstract set(ref: CredentialRef, value: string): Promise<void>
abstract unset(ref: CredentialRef): Promise<void>
abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>
abstract listRecords(): Promise<readonly CredentialRecordEntry[]>
abstract modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>
abstract deleteRecord(key: CredentialKey): Promise<void>
```

两套键空间：`CredentialRef` 回答"这个环境变量名背后是什么"（按调用解析，**不要跨操作缓存**——这正是轮换后下一次操作就生效的原因；空值一律视作未配置）；`CredentialKey` 回答"这个插件为这个 id 持有什么凭据"（只能靠 `modifyRecord` 写：token 刷新是"读—决定—替换"在一次锁内完成）。

本项目：BUAA 密码**不该**进这里（它是一次性使用的交互凭据）；LLM key 应由宿主模型配置管理；确实需要长期保存的第三方 token 才用 `modifyRecord`。

### 2.7 `ctx.fs` — 文件读写（不要用 Node 的 `fs`）

```ts
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
abstract processPath(target: FsTarget): string
processPathFromHostPath(hostPath: string): string | undefined
abstract fileUrl(target: FsTarget): string
abstract contains(parent: FsTarget, child: FsTarget): boolean
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
```

- `FsTarget.targetKey` 与 `FsVersion` 都是**不透明标识**：显示 `displayPath` 可以，解析 `targetKey` 不行，解释 `FsVersion` 也不行。
- 写入守卫：`FsWriteIntent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }`。省略 `expected` 就是无条件覆盖；`createIfAbsent` 在目标已存在时报 `FS_NOT_OBSERVED`；`replaceIfVersion` 版本不匹配报 `FS_STALE_VERSION`。
- 默认姿态是"先读后写/编辑"（`@deepseek-ai/dsh-fs-observation-policy` 通过 `fs/write-intent`、`fs/edit-intent` 单槽瀑布给意图）：**没观测过就写**会被映射成 `createIfAbsent`，**没观测过就编辑**直接 `FS_NOT_OBSERVED`。
- 沙箱：`@deepseek-ai/dsh-fs-sandbox` 按每次调用的 `sandboxPolicy` 限制变更；策略拒绝是 `FS_SANDBOX_DENIED`，宿主内核拒绝是 `FS_PERMISSION_DENIED`。
- 读/写/编辑**没有 `timeoutMs`**，取消只通过工具 signal 传播。
- 错误码全集：`FS_NOT_FOUND | FS_NOT_DIRECTORY | FS_NOT_TEXT | FS_NOT_REGULAR_FILE | FS_TOO_LARGE | FS_PERMISSION_DENIED | FS_SANDBOX_DENIED | FS_IO_ERROR | FS_STALE_VERSION | FS_NOT_OBSERVED | FS_AMBIGUOUS_EDIT | FS_EDIT_NOT_FOUND | FS_ABORTED`。

本项目用处：如果第一期先把日历数据落成插件自己管理的 JSON/CSV，用 `ctx.fs` 而不是 `node:fs`（这样沙箱与观测策略仍然生效）；读写要在工作区允许范围内。

### 2.8 `ctx.subprocess` — 起子进程（保留 Python 侧的路径）

```ts
abstract resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
abstract terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

`SubprocessSpawnSpec = { argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number; signal?; env? }`；`SubprocessHandle` 有 `stdin/stdout/stderr/control/collected/done/terminate()/waitForExit(signal?)`。

要点：**可执行文件路径属于与当前挂载文件系统共享的同一个"执行世界"**；`spawn` 同步返回活句柄；收集模式的读取是**按偏移、非消费**的，多个观察者互不干扰，被截断时 `lossy` 为真并可能给出 `spillPath`；服务释放时会终止所有仍在运行的受管子进程并等它们退出。**不要**用 `child_process` 自己起进程。

> 若最终决定保留 Python 侧的 EasyOCR 或 BUAA SSO 抓取，就走 `ctx.subprocess.spawn`，并在 `ctx.effect` 的清理里释放它。

### 2.9 `ctx.webServer` — 自己加 HTTP 路由（少数场景才需要）

```ts
register(route: WebRoute): () => void            // { kind: 'exact' | 'prefix', path, handler(req, res) }
registerUpgrade(route: WebUpgradeRoute): () => void
registerFallback(handler: WebRoute['handler']): () => void
tapIndex(transform: (html: string) => string): () => void
applyIndexTaps(html: string): string
collectIndexInjections(): IndexInjection[]
renderIndex(html: string): string
```

`kind: 'exact' | 'prefix'`，`path` 是绝对路径且**不留尾斜杠**；`handler(req: IncomingMessage, res: ServerResponse)` 自己负责整个响应生命周期（可以长挂，例如 SSE）。重复的 `(kind, path)` 会抛——路由模式属于组合级契约。

本项目建议：**默认不要**自己开 HTTP 端点。只有"必须让浏览器直接拉取二进制/大文件"或"对接外部回调"时才用，且要自己想清楚鉴权。

### 2.10 `ctx.userQuestions` — 让界面问用户

```ts
@Remote answer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswer): boolean
@Remote({ mode: 'stream' }) attachWait(agent: Agent, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>
async askTimed(request: AskUserQuestionRequest & { agent: Agent }, callId: ToolCallId, timeoutMs: number): Promise<TimedUserQuestionResult>
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
```

只有当调用方提供的 agent 是注册表里**确切的活动运行时根**时，人机交互才成立（被拥有的子 agent 没有人类应答者，会永久阻塞）。

### 2.11 `ctx.llm` — 模型调用 seam

```ts
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
@Remote listProviders(): LlmProviderInfo[]
registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle
@Remote listConfigurableProviders(): LlmConfigurableProvider[]
registerModelDiscovery(settingsNs: string, discover: (request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<readonly LlmDiscoveredModel[]>): () => void
async discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest, signal?: AbortSignal): Promise<LlmDiscoveredModel[]>
providerRetryPolicy(provider: string): ResolvedRetryPolicy
async listModels(provider: string): Promise<LlmModelInfo[]>
async resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

**优先让 Agent 自己去理解自然语言**（你的工具只需提供确定性的读写能力）。只有当你要做"离线/批量、不经过模型对话"的解析时，才用 `resolveCallConfig` → `prepareCall` → `stream` 这条链路；`llm/stream` 是可拦截的瀑布（重试/路由/回放都挂在这）。

### 2.12 其它可能用得上的

| 服务 | 用途 | 关键签名 |
|---|---|---|
| `ctx.agents` | 找到当前/根 agent，驱动一轮输入 | `currentInitiator()`、`requireInitiator()`、`get(id)`、`list()`、`roots()`、`async create(options)`、`async resume(options)` |
| `ctx.sessionProjections` | 会话日志派生状态（见 `04`） | `register(definition)`、`onChanged(listener)`、`stateOf(session, key)`、`snapshot(session, keys?)` |
| `ctx.sessionController` | 由 sessionId 解析出 Agent | `resolveAgent(sessionId)`、`inspect(sessionId, signal?)` |
| `ctx.approval` | 审批策略与请求 | `setPolicy(agent, policy)`、`async request(req)` |
| `ctx.web` | 出网搜索/抓取能力 | `async search(request, signal?)`、`async fetch(request, signal?)` |
| `ctx.jobController` | 作业的浏览器侧 Remote 面 | `@Remote({mode:'stream'}) list/follow`、`@Remote('kill') kill` |

---

## 3. 事件

### 3.1 五种分发模式

| 模式 | 是否 await | 顺序 | 有返回值 | 说明 |
|---|---|---|---|---|
| `emit` | 否 | 按注册顺序观察 | 否 | 广播；监听器失败被记录并隔离 |
| `waterfall` | 否 | 按注册顺序包住下游 | 是 | **必须调用 `next()`**，不调用就短路整条流水线；不拥有该决策的监听器一律 `return next()` |
| `parallel` | 是 | 全部并行 | 否 | 等待全部完成 |
| `serial` | 是 | 按注册顺序 | 是 | 首个非 `null`/`false`/`undefined` 的返回终止后续 |
| `bail` | 否 | 按注册顺序 | 是 | 首个"bail 值"即结果（宿主事件目录里未出现该模式） |

事件名用 `namespace/action` 命名（`agent/pre-step`、`tools/result`、`session/event`……）。

> ⚠️ **`turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是持久化的"会话事件类型"，不是同名的 Cordis 事件。** 要观察它们就监听 `session/event` 并检查 `event.type`。

### 3.2 值得监听的事件（本项目相关）

| 事件 | 模式 | 签名 | 什么时候用 |
|---|---|---|---|
| `session/event` | emit | `(this: Scoped<Session>, session, event: SessionEvent): void` | 提交后的追加订阅（fire-and-forget）。**派生状态优先用 `ctx.sessionProjections`**，不要在这里全量重扫 |
| `session/flush` | parallel | `(this: Scoped<Session>, session): Promise<void> \| void` | 需要"持久性检查点"时；投递确认依赖它 |
| `agent/created` | serial | `({ agent, source, signal? }): undefined \| Promise<undefined>` | **注册 per-agent 行为的唯一正确位置**：在 `agent.ctx` 上注册，并把这个 disposer 也登记进自己的 effect。**不要**在这里 await `agent.whenIdle()` 或自己 owner 的释放 |
| `agent/disposed` | emit | `({ agent }): void` | 清理按 agent 的资源 |
| `agent/turn-stopping` | serial | `({ agent, turn, signal }): Promise<void> \| void` | 轮次要关闭前想插话：`agent.steer(...)` 会让它再跑一步 |
| `tools/result` | emit | `(this: Scoped<ToolRuntime>, exec, result): undefined` | 观察工具的**最终不可变结果**（审计、统计） |
| `tools/pre-execute` | waterfall | `(this: Scoped<ToolRuntime>, exec, next): Promise<PreToolDecision>` | 允许/拒绝/取消/询问。异步门必须观察 `exec.signal` |
| `tools/execute` | waterfall | `(this, exec, next)` | 包裹分派：超时、重试、指标。**只能替换 `exec.signal`**，且必须还原 |
| `tools/post-execute` | waterfall | `(this, exec, result, next)` | 显式变换结果；不要在这里做授权判断 |
| `tools/change` | emit | `(): void` | 工具集合变化（**故意不做 scope 过滤**） |
| `settings/document-updated` | emit | `(ns, revision): void` | 某 profile 条目的表单值/可用性/页面策略变化 |
| `plugin-manager/changed` | emit | `(change: PluginChange): void` | 插件/组合包/组合变化。**注意**：CLI 或手工改文件后由 HMR 应用的补丁不会在这里宣告 |
| `system-prompt/assemble` | waterfall | `(this: Scoped<SystemPrompt>, assembly, context, next)` | 专家级整体装配，返回结果权威。**不要用它增删工具/提示** |

`PreToolDecision = { kind:'allow' } | { kind:'deny', reason, info? } | { kind:'cancel' } | { kind:'ask', reason?, displayReason? }`；`PostToolDecision = { kind:'accept', content? | value?, additionalContexts? } | { kind:'block', feedback, additionalContexts? }`。

---

## 4. 配置（`export const Config`）

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting)   // 用户值或 schema 默认值
}
```

规则：

- schema 库是 `@deepseek-ai/schemastery`（Cordis 本身接受任意 Standard Schema 验证器）。**不要导出普通对象当 `Config`**——它不满足 Standard Schema 接口，加载会失败。
- 默认值写在 schema 里；`apply` 永远拿到**完整且已校验**的配置。
- 校验失败会**让插件加载失败并停在 `FAILED`**（`ValidationError: invalid config: ...`），启动器打印错误并非零退出。
- 改 profile 里某条目的 `config` 会**卸载旧实例、装载新实例**（注册都是 effect，所以不会残留）。
- 凡是"不同部署可能需要不同值"的量都必须进 schema；判断标准是"能不能只改 `cordis.patch.yml` 而不动代码"。
- profile 里的写法：

```yaml
- insert:
    - id: schedule-core
      name: '@lidozs55/dsh-schedule'
      config:
        greeting: 'Hi there'
        maxRetries: 5
```

### 4.1 `volatile` 字段：读的时候才取值

```ts
export const Config = Schema.object({
  greeting: Schema.string().default('Hello').volatile(),
})

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
  ctx.on('loader/volatile-update', () => {
    console.log(config.greeting.get())
  })
}
```

- 每次操作都读的字段用 `.volatile()`，读法是 `.get()`；改动只更新稳定引用并发出**一次** `loader/volatile-update`（带 key 路径数组），**不会重挂载插件**。
- 值可以跨一次操作（含 `await`）使用，但**不要**留给后续操作。
- 对象/数组值是与输入解耦的冻结纯数据快照；函数、类实例、循环引用会被拒绝。

### 4.2 `!!js` 计算值

```yaml
- name: './my-plugin.ts'
  config:
    greeting: !!js process.env.DEMO_GREETING ?? 'Hello'
```

`!!js` **只在一行的 `config` 与 `disabled` 字段内有效**，其它元数据（`name`、`id`、`inject`…）保持静态；`disabled: !!js ...` 在每次挂载决策时基于 loader 上下文求值。

---

## 5. 与本项目最相关的两个"别忘了"

1. **`ctx.jobs` 不跨重启**（进程本地注册表；包 README 原话："Jobs end when their owner or the harness shuts down."）。要持久就用 storage domain。
2. **派生状态用 `ctx.sessionProjections`**，不要在 `session/event` 里重扫日志（见 `04`）。
