# 04 · 数据与状态：放哪里、怎么放

> 一句话规则：**会话日志是唯一真相，插件内存只是派生缓存**。凡是模型能看到的东西，都必须能从已提交的会话事件重建（fork / resume / replay 都从日志派生）。插件自己拥有的业务数据则放进受 schema 校验的持久 domain。

---

## 1. 五种"放数据的地方"，按用途选

| 放在哪 | 生命周期 | 适合什么 | 不适合什么 |
|---|---|---|---|
| **Session 日志**（`ctx.sessionProjections` 派生） | 随 Session，可 fork/replay | 模型可见、与某次对话绑定的状态（"本会话的来源导入进度"） | 大对象、跨会话共享的业务数据 |
| **存储 domain**（`ctx.storageDomain`） | 跨会话、跨重启 | 任务、日历条目、用户设置——本项目 95% 的数据 | 模型需要逐步推理的过程状态 |
| **凭据**（`ctx.credentials`） | 跨重启 | 长期第三方 token | 一次性密码、业务数据 |
| **插件配置**（`Config`） | 随 profile，升级保留 | 可调参数（提前提醒几分钟、是否自动同步） | 用户业务数据 |
| **文件**（`ctx.fs`） | 视后端 | 导入/导出、备份 | 结构化查询（domain 更合适） |

**绝对不要**：自己 `require('node:sqlite')` 开库、写 `localStorage` 存业务数据、给 Session 日志追加**新的事件类型**（`Session.append()` 设不了 `ignorable: true`，Session 会拒绝重开）。

---

## 2. 派生状态：`ctx.sessionProjections`

```ts
register<K extends keyof SessionProjectionMap, S extends SessionProjectionStateMap[K]>(
  definition: Omit<ProjectionDefinition<K, S>, 'wire'> & { wire: NonNullable<ProjectionDefinition<K, S>['wire']> },
): () => void                                     // 客户端可见的单元
register<K extends Exclude<keyof SessionProjectionStateMap, keyof SessionProjectionMap>, S>(
  definition: Omit<ProjectionDefinition<K, S>, 'wire'>,
): () => void                                     // host-only 单元（不进客户端快照）
onChanged(listener: ProjectionChangeListener): () => void
stateOf<K>(session: Session, key: K): SessionProjectionStateMap[K] | undefined
snapshot(session: Session, keys?: readonly string[]): ProjectionSnapshot
cachedSnapshot(session: Session, keys?: readonly string[]): ProjectionSnapshot | undefined
```

```ts
export interface ProjectionDefinition<K, S> {
  key: K
  stateSchema: ZodType<S>
  init(header: SessionHeader, inheritedEventCount: SessionLogOffset): S
  apply(state: S, event: SessionEvent): S
  wire?: {
    viewSchema: ZodType<SessionProjectionMap[K]>
    view(state: S): SessionProjectionMap[K]
  }
  stateVersion: number
}
```

要点：

- 服务**只订阅一次 `session/event`**，每个已提交事件都会过每个单元的 `apply`（eager drive）。
- `apply(state, event)` 必须是**纯的、同步的**，并且**对它忽略的事件返回同一个引用**——引用没变，下游就零成本；`view()` 返回同一引用时也就不会发布。
- 注册是 effect：卸载插件的 key 会从快照里消失，客户端读到的是"能力缺失"。
- key 共享：同一个 key 被注册 N 次就计数 N 次，直到最后一个卸载才消失。
- 保持投影状态是**纯 JSON**；字段或折叠语义变了就 bump `stateVersion`（缓存检查点据此判断是否可用，陈旧检查点会被丢弃）。
- 客户端需要的派生值声明成 `wire.view`，值在到达 Client 前就算好——**Client 不要自己折叠会话事件**。
- host reader 要么在 `inject` 里声明 `sessionProjections`，要么在缺失时显式失败。

**本项目的落点**：如果将来做"本周教学周次""今日未完成任务数"这类**会话内**展示，用投影；但条目/任务本身是跨会话业务数据，属于 domain。

---

## 3. 持久业务数据：`ctx.storageDomain`

`ctx.storage` 是枢纽（`mount(form, facility)` / `form(name)`），`ctx.storageDomain` 是已挂载的 **domain 形态**。**业务包只应该用 domain，不要直接碰 backend。**

### 3.1 声明一个 domain

```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  due: z.string(),                     // RFC 3339 带时区；任务必须有截止时间
  priority: z.enum(['high', 'medium', 'low']),
  completed: z.boolean(),
  updatedAt: z.string(),
})

export const scheduleSpec = defineDomain({
  name: 'schedule_core',             // 必须匹配 UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
  version: 1,
  tables: {
    tasks: domainTable(taskSchema),
    entries: domainTable(entrySchema),
  },
  global: {
    // categorySchema validates stable ids, nonempty names and #RRGGBB colors;
    // cloneCategories() returns the ordered seven defaults (00 §3.3).
    schema: z.object({ termStart: z.string(), sourceState: z.record(z.string(), z.string()),
      entryModelVersion: z.literal(2), categoryModelVersion: z.literal(1),
      categories: categorySchema.default(cloneCategories) }),
    initial: { termStart: '', sourceState: {}, entryModelVersion: 2,
      categoryModelVersion: 1, categories: cloneCategories() },
  },
})
```

规则：

- `defineDomain` 是**身份助手**，在**模块加载时**就大声失败：名字不符合 `UNIT_NAME_RE`、`version` 不是非负整数、global schema 接受 `null`（`null` 是后端"从未写入"的哨兵，可空 global 会与"缺失"混淆）——这几种都会抛。表名同样要匹配 `UNIT_NAME_RE`。
  - **`UNIT_NAME_RE` 是 `/^[a-z][a-z0-9_]*$/`，即 snake_case；表名写 camelCase 会在 import 阶段直接抛**（2026-10-20 实测：`changeLog` → `table name 'changeLog' must match …`）。后果比"报错"更隐蔽：loader 的 `_init` 捕获 import 异常后**不再创建 fiber**，于是该行既没有 host 插件、也不会进入 `clientModules` 的 `dsh.client` 扫描——**客户端条目整条消失**（`__DSH_BOOT__.entries` 里没有它，样式/面板/settings 卡全不出现），但启动不报错、宿主看起来正常。排查手段：`loader.entries()` 里该行 `fiber === undefined`，或 `clientModules.pkgMeta` 里根本没有该包名的键。表名一律用 snake_case（`change_log`），JS 内部变量仍可用 camelCase。
- schema 用 **zod**（DSH 侧 `@deepseek-ai/dsh-storage-domain` 依赖 `zod@^4.4.3`）。本仓库的 bundle 需要自己声明 `zod` 依赖；版本要与 dsh 使用的大版本一致（结构兼容），落地前后用 `Config.listConfigs` 拿到的 `packageDir` 核对 dsh 实际装的版本。
  - **声明位置是 `peerDependencies`，不是 `dependencies`**（2026-10-17 M0 验收踩坑修正）：`install_bundle` 以本地目录安装的 bundle 是 pnpm 链接包，宿主按 `routeLinked` 解析其裸导入——只有在插件自身 `package.json` 的 `peerDependencies` 里声明的包名，才会被运行时解析映射到宿主安装侧的共享实例（`readPeerNames` 只读 `peerDependencies`）。写进 `dependencies` 的宿主包（`@deepseek-ai/*`、`zod`）既不会被 pnpm 装进链接目录，也命中不了 peer 拦截，激活即 `ERR_MODULE_NOT_FOUND`。依据：DSH `docs/user/develop/basic/publish.zh.md`（"需要与宿主共享实例的 dsh 包同时声明在 `peerDependencies` 与 `devDependencies` 中"）与 `packages/boot/app-boot/src/profile-resolution/resolver.ts` 的 `routeLinked`。手写 bundle 无类型检查链，`devDependencies` 副本可省。
- `Spec` 可选字段：`layout?: 'single' | 'per-record'`、`compatibleVersions?: readonly number[]`、`invalidRecords?: 'backup-and-skip'`。
- 每个 domain/表的名字同时是后端里的 unit 名与表名，**改名 = 数据迁移**，一开始就要定好。

### 3.2 打开、使用、关闭

```ts
export const inject = ['storageDomain']

export function apply(ctx) {
  const opening = ctx.storageDomain.open(scheduleSpec)
  let domain
  ctx.effect(() => {
    let closed = false
    opening.then(d => {
      if (closed) return d.close()
      domain = d
    })
    return async () => { closed = true; await domain?.close() }
  }, 'schedule: domain close')
}
```

- `open(spec)` 会：拒绝已打开的名字（`already-open`）→ 解析 backend 路由（`backend-not-found`）→ 要求该 backend 有 `kv` facet（`facet-unsupported`）→ 打开 unit（后端 `version-mismatch` / `malformed-medium` 原样透出）→ **对每条已存记录按 spec 的 zod schema 校验**（`invalid-record` 会指出出错的表和 key；除非 spec 声明了 `invalidRecords: 'backup-and-skip'` 且 unit 能把坏文档挪走，此时坏记录被备份、记日志、跳过）→ 构造 domain。
- **调用方拥有 handle**，要自己 `domain.close()`（通常就是自己的 `ctx.effect` disposer）；facility 卸载时会关掉仍开着的 domain，`closeAll()` 也是幂等的。
- 读取**同步、从内存**：`domain.table('tasks').get(key)`。
- 写入**异步且已持久**（后端确认后才 resolve），并按写序各发一次 `domain/changed`。

`KvTable<K, V>`：

```ts
get(key: K): V | undefined
entries(): IterableIterator<[K, V]>
keys(): IterableIterator<K>
readonly size: number
put(key: K, value: V): Promise<void>
delete(key: K): Promise<boolean>
update(key: K, fn: (current: V) => V): Promise<V>
```

`Domain` 还有 `global: { get(): G; set(value: G): Promise<void> }`（用 `global` 存单例事实，例如 `termStart`）。

错误码：`already-open` / `facet-unsupported` / `invalid-record` / `missing-key`（对不存在的记录 `update`）/ `closed`（关闭后的任何使用），后端错误如 `version-mismatch` 原样透出。**不要吞掉它们**——它们全都代表"代码和已存数据不一致"。

路由（哪个 backend 服务哪个 domain）由 **`@deepseek-ai/dsh-storage-domain` 自己的 Config** 决定，不由插件决定：`backend`（必填，默认后端名）、`routes`（domain 名 → backend 名）。当前可用的 backend 形态只有 `domain` 一个；后端实例有 `@deepseek-ai/dsh-storage-json` 与 `@deepseek-ai/dsh-storage-sqlite`。

---

## 4. 本项目的数据设计

业务数据只存 `entries` 与 `tasks` 两表，完整字段以 `00-architecture.md` §3 与 `host/domain.js` 为准：

| 事实 | 落点 | 规则 |
|---|---|---|
| 日历占时事项 | `entries` | 所有来源共用标题/起止/类别/地点/锁；导入教学安排用 `course`（课程），已删类别由来源快照归 `other` |
| 截止与完成状态 | `tasks` | 任务不占日历时间；`entryId` 可关联条目 |
| 类别定义与顺序 | `global.categories` | `{id,name,color}` 数组；稳定 id、`#RRGGBB`；默认七项见 `00` §3.3，已有配置不补回预设 |
| 类别迁移版本 | `global.categoryModelVersion` | 当前为 `1`，与 `entryModelVersion: 2` 独立 |
| 学期第一周周一 | `global.termStart` | 用于教学周标签与导入时日期换算，不在读取时扩展安排 |
| 学号、公告版本等来源私有状态 | `global.sourceState.<source>` | 核心只存 JSON；密码、Cookie jar 不持久化 |
| 提醒提前量 | 插件 `Config` + `entries/tasks.remindLead` | 全局四档默认；`remindLead` 为可空分钟覆盖（0–10080，null 跟随默认）；不保存“是否提醒”业务字段 |

设计要点：

1. **时区只有一种语义**：带偏移 ISO 8601，schema 明确校验。
2. **归属不是类型**：`source` / `sourceKey` 是可选来源身份。完整快照使用 `replaceSourceEntries`，稳定键保留 ID，预校验失败不开始写入（见 `11` §2）。
3. **锁仅限制快捷拖动**：`location` 是可空字符串，`lock` 默认 `false`；锁定不拒绝普通编辑、删除或 CLI 更新。
4. **启动时一次转换**：按存量实际周次生成带日期的条目，保留改期、跳过取消项；缺学期起点就明确失败且不删除原始数据。完成标记为 `entryModelVersion: 2`。这不是旧 API/旧 JSON 的持续兼容面，备份与切换见 `13-entry-model.md`。
5. **导出/导入只认当前格式**：主体 `global`、`entries`、`tasks`，接受 UI 的 `exportedAt`；类别列表往返保留。空白目标采用导入定义；已有数据目标保留原定义，同 id 同名同色复用，冲突新建 id 并重映射导入条目，重试复用已生成的等价定义；原 `other` 在已有数据目标保留为兜底。清空仅删两张业务表并保留设置。
6. **类别专用写面**：`setCategories` 验证完整有序列表，`other` 名称固定“其它”、不可删但可改色；删除任意其它预设/自定义类别时仅重归现有条目，来源快照不会恢复预设。`setMeta` 不写类别，手工未知 id 拒绝、来源未知 id 归 `other`。
7. **独立类别迁移**：旧 BUAA `teaching:` 条目仅在 `study` 时改 `course`，手工学习不变；旧周规则直接生成 `course`。过渡 schema 显式保留 `categories/categoryModelVersion`，标记最后持久化，失败重试安全。
8. **提醒无持久业务状态**：`upcomingReminders()` 现算，页面通知与可选桌宠桥读取同一集合。浏览器去重只存 localStorage，不是另一份业务数据。

---

## 5. 凭据

- `CredentialRef`（环境变量名那一套）：**按操作解析，不要跨操作缓存**——这正是"轮换后下一次操作就生效"的机制；空值一律等于未配置。
- `CredentialKey`（插件持有的凭据）：`modifyRecord(key, mutate)` 是**唯一**写路径，`mutate` 在写独占的那一刻看到当前值，返回 `undefined` 表示不动；跨进程互斥由后端提供，token 刷新才安全。
- 本项目：BUAA 密码**不要**存（它是一次性交互凭据，现在也没存，保持住）；确实需要长期保存的第三方 token 才用 record。

---

## 6. 检查清单

- [ ] 重启 Host 后数据仍在，且能通过同一套 domain 读回来。
- [ ] `open()` 失败路径（backend 未配置、facet 不支持、记录不合 schema）都被显式处理或大声失败，而不是静默降级成"没有数据"。
- [ ] 写操作 resolve 之后立刻读能读到新值（`put` 已持久）。
- [ ] 没有把模型可见状态只放在插件内存里。
- [ ] 没有给 Session 日志加新事件 `type`。
- [ ] Client 半没有把业务数据持久化在浏览器里（只允许纯 UI 偏好）。
- [ ] 时间字段只有一种时区语义，并有注释说明。
