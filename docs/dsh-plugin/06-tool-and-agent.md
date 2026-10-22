# 06 · 工具与 Agent 交互规范

> 适用场景：把"来源导入、任务增删改查、日程生成、提醒设置"这类操作交给 Agent 调用。
> **本项目当前的 Agent 入口是 `schedule` CLI，不再注册常驻 tool schema。** 下面的平台
> `defineTool` / `ToolDefinition` 契约保留给其它 DSH 插件参考；本项目的命令定义见 §1。

---

## 0. 工作 Agent 的知识边界

本篇是**插件开发者参考**，不是日常日程 Agent 的操作手册。工作 Agent 只需 `schedule` CLI
的分层帮助/指南、主插件 skill 与已启用插件各自的提示；不应为了建日程加载架构、存储、路由或宿主开发资料。

| 入口 | 唯一职责 | 不应承载 |
|---|---|---|
| 核心 `systemPrompt` 段 | 当前教学周/学期起点、`schedule` CLI 入口、文件旁路与冲突确认底线 | 参数全集、类别预设清单、来源插件规则 |
| `schedule` CLI 命令树/分层帮助 | 当前可调用子命令、参数、必填/默认、查询语义和关键副作用 | 未暴露的 service/API 方法；把 UI 能力说成 CLI 能力 |
| `schedule guide <topic>` | 较长教程：工作流、时间/全天、批量、图片/剪贴板、冲突确认 | 学校登录、游戏推算、桥接展示、凭据与存储布局 |
| `.dsh/skills/schedule/SKILL.md` | 极简发现入口：先 `schedule --help`，再进命令帮助/guide；只保留跨命令行为底线 | 复制参数全集、回执/冲突重试细节、学校导入、游戏刷新、桥接规则 |
| 来源插件自身的 prompt + CLI 命名空间 | 该插件启用时才提供的命令、输入前提、快照/对账和特有回执语义 | 要求主 skill 兜底；假定其他插件或检索工具一定存在 |
| 剪贴板会话入口 | 说明待解析材料、引用主 skill，提醒缺项与部分失败 | 另写一套按标题关键词分流的操作规范 |
| 本目录开发文档 | 维护实现、诊断、能力契约与设计理由 | 让日常 Agent 走文件、HTTP 或配置旁路执行用户任务 |

边界按**CLI 命令树实际暴露面**，不是 `scheduleCore` service 的全集：核心仅提供
`schedule entry` 与 `schedule task`。类别/颜色、学期、提醒配置、备份与全量清除只有设置入口；
没有持续周期规则、任务批量写或条目批量更新/删除命令。工作 Agent 应解释限制并指向设置，
而非发明参数或调用内部 API。

主 skill 不提来源插件的名字、命令或业务规则；来源知识由所属 bundle 自己注入。只有通用条目
语义（例如 lock 仅防快捷拖动）留在核心，不讲其来源如何生成。移出的北航导入规则归北航
`index.js` 的提示与 `schedule buaa` 指南，二游刷新/官方校正规则归二游 `index.js` 的提示与
`schedule gacha` 指南，桌宠投递与来源身份字段只留开发文档；**无必须保留在主 skill 的子插件例外**。

验收需要两层：知识边界检查防止重新混入来源与内部资料；运行测试验证文案描述的查询、关联、
全天和批量恢复语义。文本检查不能证明模型一定遵循，也不能替代权限隔离或 CLI 回执测试。
主 skill 改动无需假定子插件也会提供完整条目 JSON；每个插件必须按自己的实际模型可见回执编写规则。

---

## 1. 本项目的 Agent 入口：`schedule` CLI

命令是**数据 + 一个 handler**，定义在 `host/command-registry.js` 的注册表中。同一份定义驱动
校验、分发、catalog、分层帮助与 `guide`，来源插件只贡献自己的根命名空间和教程。

```js
registry.register({
  name: 'entry',
  summary: '查询或修改占用时间的日历条目',
  usage: 'schedule entry <list|create|update|delete|batch-create> [选项]',
  commands: [
    {
      name: 'create',
      summary: '新建一个条目',
      options: {
        title: { type: 'string', required: true, description: '活动/事项标题' },
        start: { type: 'string', required: true, description: '带时区 ISO 8601' },
        'allow-conflicts': { type: 'boolean', description: '用户确认允许重叠后才用' },
      },
      examples: ['schedule entry create --title "编译原理" --start 2026-10-24T14:00:00+08:00'],
      notes: ['默认拒绝时间重叠；成功回执就是写入确认。'],
      async run(args) {
        return service.createEntry(/* … */)
      },
    },
  ],
}, { owner: 'core' })
```

约束：

- **唯一写入口**：handler 调 `scheduleCore` 的服务方法；CLI server 只做参数校验、命令分发和
  JSON envelope，不提供任意 service/route 透传。UI `/api` 与 CLI 走同一业务实现。
- **命名空间**：根命令 `^[a-z][a-z0-9-]*$`，重复注册直接失败。来源插件在 `apply` 里
  `ctx.scheduleCommands.register(...)` 并返回 disposer；核心卸载前它们随 `ctx.effect` 注销。
- **选项**：`string|boolean|number|integer|json|array`，可 `required`/`repeated`/`enum`/`default`/`hidden`。
  `hidden` 只用于密码这类由全局 flag 注入、不能作为普通参数出现的字段。
- **分层帮助**：根帮助只列命令和指南；`schedule <命令> --help` 列子命令；叶子帮助列参数、示例、
  注意事项与通用选项。叶子命令必须提供 `run`；有子命令的组不能再提供 `run`。
- **长教程**：用 `registry.registerGuide({ name, title, summary, body })`，正文是 Markdown。
  `schedule guide` 只列主题，`schedule guide <topic>` 才输出全文，避免把知识塞进每轮上下文。
- **回执**：成功 `{ ok: true, command, value }`；失败 `{ ok: false, command, error: { code, message, details? } }`。
  退出码 0 成功、1 业务错误、2 用法/连接/认证错误。模型应读 JSON，不解析人类帮助文本当数据。
- **密码**：不能用普通命令行参数传递。CLI 支持 `--password-stdin` 与 `--password-env NAME`，
  服务端只把密码放进本次命令的 input，不落盘、不写日志。
- **批量输入**：`--input <file|->` 从文件或 stdin 读 JSON；根为数组且命令是
  `entry batch-create` 时自动作为 `entries`，避免在 argv 里拼长 JSON。
- **传输**：`127.0.0.1` 随机端口 + 256-bit bearer token，discovery 文件在
  `$DSH_HOME/schedule-cli`（`SCHEDULE_CLI_HOME` 覆盖）；Host 头校验、无 CORS、只暴露注册命令树。
  身份边界是能读到 0600 discovery 文件的同一 OS 用户；服务端不提供用户/角色切换。
  宿主把该目录前置到 `PATH`；多实例时 `--instance <id>` 选择；`current.json` 由最后启动的实例写入，
  dispose 时只删自己的。
- **超时**：命令可声明 `timeoutMs`（北航/二游 180 s），CLI 取 `--timeout` 或
  `max(30 s, 命令 timeoutMs)`；超时结果未知，先查询再决定是否重试。

来源插件示例见 `dsh-plugin/dsh-schedule-buaa/host/commands.js` 与
`dsh-plugin/dsh-schedule-gacha/host/commands.js`。

---

## 2. 平台工具 API（其它插件的可选参考）

本项目不再使用下列 API 暴露日程能力；保留本节是因为来源之外的 DSH 插件仍可能需要工具。
**不要**为了日程操作重新注册 `sched_*` 工具。

---

## 3. 两种写法：`defineTool`（推荐）与原始 `ToolDefinition`

**推荐**用第一方类型化助手 `defineTool`（来自 `@deepseek-ai/dsh-tools`）：参数用 `ValueSchemaSpec` DSL 写，`execute` 的 `args` 会按 schema 推导出类型，注册前 `defineTool` 会校验模型给的 `arguments`（类型、必填键、字面量约束、恰好命中一个分支的联合、嵌套值）。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
      limit: { type: 'number' },              // 不加 required 就是可选
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      return `Hello, ${args.name}!`           // 只返回 canonical value
    },
  }))
}
```

DSL 规则（官方）：`ValueSchemaSpec` 支持 `string` / `number` / `integer` / `boolean` / `null` / `array` / `object`，外加**只在作者侧存在**的 `json` 与 `oneOf`（必须恰好命中一个分支）；标量的 `enum`/`const` 值必须与节点类型相符；**显式对象节点必须声明 `additionalProperties: true | false`**，而每个工具隐式的参数根对象是开放属性映射，必填属性写 `required: true`。DSL 表达不了的约束（非空字符串、正数、跨字段规则）仍要自己检查。

**另一种**是直接注册原始 JSON Schema 的 `ToolDefinition`（MCP 来源的工具就是这样到达的），此时输入校验由你自己负责。

## 4. ToolDefinition：精确契约

```ts
export interface ToolSchema {          // 暴露给模型的部分
  deferLoading?: true;
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode;
  render(args: unknown, value: JsonValue): ContentBlock[];
  presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}

export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
  timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): ToolCallView | undefined;
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
```

`execute` 拿到的 `ToolRunContext` 在 `ToolExecution` 之上多两个方法：

```ts
export interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void;  // 把上下文推迟到之后注入
  concludeTurn(): void;                      // 本步之后结束本轮
}
```

其中 `ToolExecution` 至少带有 `callId`、`name`、`arguments`、可选的 `agent`、以及 **`signal: AbortSignal`**。

要点：

- **`output` 是必填的**。`execute` 的返回值会按 `output.schema` 校验并冻结，再由 `output.render(args, value)` 变成模型实际看到的内容块（`ContentBlock[]`）。canonical value **不会自动发给模型**：需要模型读取的 id、完整字段、冲突与逐项结果必须显式渲染。平台工具输出简短摘要 + 独立 JSON 文本块；不要只给摘要后让 Agent 读存储补明细，也不要把私有配置顺带序列化。**不要**从 `execute` 返回内容块。
- 出错：**抛出异常或返回不符合 schema 的值都算 `isError`**。基础设施故障用抛；域内的"不受欢迎但正常"的结果（例如命令非零退出）应当放进 canonical value。参数不匹配抛 `ToolArgsError`（`INVALID_ARGS`），主体/后处理产出的非法值抛 `ToolOutputError`（`INVALID_TOOL_OUTPUT`）。
- 定义注册后按只读借用：**不要**再改它的 schema 或替换回调；要热替换就先 dispose 拥有它的 effect，再注册新的。
- 名字：保留名 `run_code` 不可用；同一层内重名失败；**scoped 注册会遮蔽全局同名工具**。
- `deferLoading?: true` 表示把该工具定义推迟加载进模型上下文。
- 注册：在 `ctx.effect` 中调用 `ctx.tools.register(defineTool(...))` 并返回 disposer。本项目不再用工具暴露日程能力；真实命令注册范例见 `dsh-plugin/dsh-schedule/host/commands.js`。不要复制历史单动词工具名、缺截止时间的任务示例或只渲染 id 的回执。原始 `ToolDefinition` 的 `parameters` 使用 JSON Schema 根对象，与上面 `defineTool` 的参数 DSL 不同。

> `ContentBlock` 的具体变体请以安装包的 `lib/types/**/*.d.ts` 为准（`Config.listConfigs` 拿到 `packageDir` 后读取）。

---

## 5. 描述与 schema 的写法要求（这些字是给模型看的）

工具名、描述、参数 schema 会被投影成模型可见的 schema（`ctx.tools.schemas()` 只保留白名单字段，执行与展示回调不会外泄）。因此：

- **名字**：平台工具用 `snake_case` 并带产品前缀避免与宿主工具撞名；`schedule` CLI 命令用 `kebab-case`。同族操作可以合并成一个命令 + 子命令（例如 `schedule entry create`），减少顶层入口。
- **描述**：写清"做什么 + 什么时候用 + 什么时候不要用"。不要只重复名字。若工具有副作用（写库、改日程、发通知），明确说出来。
- **参数**：
  - 每个字段都要有 `description`；枚举值用 `enum` 而不是让模型猜字符串。
  - 必填项放 `required`，可选参数给出省略时的行为。
  - 嵌套结构越浅越好；能用扁平参数就不要用对象套对象。
  - `additionalProperties: false` 让你的意图明确（若该版本校验器不支持，也仍建议写）。
- **返回值**：返回结构化 JSON（id、受影响条数、冲突信息……），并在 `output.render` 中显式提供模型完成下一步所需的字段，而不是一句自然语言。失败时给出**可据以行动的原因**（例如"与条目「编译原理」周三 10:00–11:30 冲突"），而不是 `Error: failed`。
- **超时与取消**：长任务设置 `timeoutMs`；在耗时循环里检查 `exec.signal.aborted`。
- **要做到"后台跑"**：用 `ctx.jobs.start({ kind, label, owner: exec.agent, run })` 起一个作业，并让成功的分支返回结构化的句柄（例如 `{ kind: 'background', jobId }`）；**`ctx.jobs.start()` 发布 id 之后，用该 job 自己的取消信号，而不是 `exec.signal`**。PTC 模式（`run_code`）下绝不能让模型从人类可读文本里解析 jobId。
- **要给 agent 留异步通知**：`agent.inject({ content, source: { kind: 'plugin', plugin: '<你的插件名>' } })` 追加持久上下文，**它不是唤醒**；`agent` 可能已被释放，记得 try/catch。
- **并发**：`isConcurrencySafe` 只有返回**确切 `true`** 才会并行；其它情况（未声明、抛错、隐藏、非法）一律按独占调度。写同一个数据源的工具有意让它独占。

---

## 6. 一个操作，两个调用者

用户既会点 UI，也会让 Agent 干活。**同一件事只实现一次**：

1. 在 **Host service** 上实现一次操作，返回结果或明确的失败状态与原因。
2. UI 通过客户端可调用的 Host 入口（例如一条 Session 命令，客户端用 `ctx.remote.commands.execute()` 执行）调用它，并把失败显示出来。
3. 用**参数与语义一致**的 Agent 入口（本项目的 `schedule` CLI 命令）暴露同一个操作；命令调用同一个方法并把结果作为 JSON 回执返回。

授权类动作 —— 批准工具调用、回答 Agent 提出的问题、放宽权限 —— **只属于用户**，不要给 Agent 开一个能自动批准自己的入口。UI 与 CLI 路径也不允许各写一套业务逻辑。

验收方式：对两个调用者都开放的操作，**只用 CLI**执行一次，比对状态变化、返回值与失败信息是否与 UI 动作一致；纯用户动作则验证 Agent 无法执行或授权。

---

## 7. 扩展点的强弱顺序（用最弱的那个）

由弱到强：

1. `ctx.tools.restrict(filter)` —— 只能**移除**工具（对调用方 agent 的 scope 生效；`allow`/`deny` 求交集）。
2. `ctx.tools.guard(execution => string | undefined)` —— 只能**拒绝**（同步；返回字符串即拒绝）。需要"无论顺序如何都必须拒绝"时用它。
3. 瀑布（waterfall）监听者 —— 能改写决策，但**依赖注册顺序**；不拥有该决策的监听者必须 `return next()`。需要 `await`（例如问用户）的决策点用 `tools/pre-execute` 返回 `ask`。
4. `system-prompt/assemble` —— 替换整个组装结果，最强，**不要**用它增删工具或文字。

对应到本项目的常见需求：

| 需求 | 正确做法 |
|---|---|
| 给模型加一段领域说明（"本周为北航第 N 教学周"） | `ctx.systemPrompt.section()` |
| 给**某一个** agent 注入临时上下文 | `agent.inject()`（记为 `agent/inbox/spliced`，进入下一个被接纳的 step）；它**不会唤醒** agent |
| 让 agent 因为定时器/提醒而主动干活 | 定时器里调用 `agent.followup()`（会唤醒），不要用 `inject()` 等它自己醒 |
| 观察工具最终结果 | 监听 `tools/result` |
| 只要变换工具结果 | `tools/post-execute`（不要在这里做授权判断） |
| 只看/改某次调用的展示卡片 | `presentCall` / `presentResult` |

**不要**为了加/删工具而监听 `system-prompt/assemble`；**不要**用 `session/event` + 全量重扫来实现派生状态（用 `ctx.sessionProjections`）。

---

## 8. 会话日志铁律

**Session 日志是唯一真相**：模型看到的一切都必须能从已提交的会话事件重建（fork / resume / replay 都从日志派生）。插件内存只是派生缓存。

因此：

- 不要给日志追加**新的** `type`（`Session.append()` 无法设置 `ignorable: true`，Session 会拒绝重开）。
- 插件自己拥有的数据放到能通过 inspect 找到的存储服务里（见 `04-data-and-state.md`）。
- 面向某个 Session 的派生值，声明为 Host projection 上的 `wire.view`，让值在到达 Client 前就算好；Client 不要自己折叠会话事件。

---

## 9. 工具卡片的渲染（可选）

Client 有一个按"线上工具名"分派的 keyed 槽位 `tool.call.toolview`：注册键就是工具名，用于给该工具的调用/结果画专门的卡片。**内建 Web Client 不消费 `presentCall` / `presentResult`**——它只认这个槽位；没注册就退化成通用行。若要做，先在已连接的页面上 inspect 该槽位的注册字段与 props，再来实现。

`presentCall(args)` → `ToolCallView`、`presentResult(args, { content, isError, meta? })` → `ToolResultView` 供其它呈现面使用，二者必须是**纯函数**：不许 IO、不许读会话状态、不许用时钟或随机数。呈现在卡片里的格式**不得**进入 canonical value 或 Native 内容。`defineTool` 对展示路径只做**软校验**：参数非法或旧版本参数会让它返回 `undefined`（退回通用展示），而不是抛错。

## 10. 反模式清单

- ❌ 工具描述里写"处理各种事情"，参数全 `type: string`。
- ❌ 一个工具里塞入互不相关的多个操作（可以合并同族操作，但不要合并无关操作）。
- ❌ 把 UI 逻辑复制到工具里（或反之），两处逻辑漂移。
- ❌ 让工具返回原始异常堆栈给模型（既有信息泄漏风险，也不可行动）。
- ❌ 忽略 `exec.signal`，导致用户取消后仍在写库。
- ❌ 声明 `isConcurrencySafe: () => true` 却写共享状态。
- ❌ 为日程操作重新注册 `sched_*` 常驻工具 schema，而不是扩展 `schedule` CLI 命令树。
- ❌ CLI server 提供通用 service/route 透传，或让 CLI 直接打开同一份数据库。
- ❌ 把密码写成 `--password ***` 普通参数（会进入 shell 历史/进程列表）。
- ❌ 把长教程塞进顶层 `--help` 或系统提示，而不是 `schedule guide` 按需加载。
- ❌ 命令回执只给人类摘要，不返回模型下一步需要的完整 JSON（id、冲突、逐项结果）。
