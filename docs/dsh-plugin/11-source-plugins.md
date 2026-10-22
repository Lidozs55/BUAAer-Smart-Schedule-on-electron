# 11 · 来源适配器契约（新增学校/导入格式）

> 一句话：**核心 `@lidozs55/dsh-schedule` 拥有日程真相，来源插件只拥有"怎么把外部数据变成核心写调用"。**
> 本仓库有两个实现：北航教务 `@buaaer/dsh-schedule-buaa`（课程/考试条目与考试任务）与二游前瞻
> `@lidozs55/dsh-schedule-gacha`（条目，见 `12-gacha-preview.md`）；前者适合当模板。

---

## 1. 依赖方向

```
@lidozs55/dsh-schedule          （核心：数据/服务/UI/提醒/通用命令）
        ▲              ▲
        │              │
@buaaer/dsh-schedule-buaa   @lidozs55/dsh-schedule-gacha
（北航来源适配器）           （二游前瞻，定时刷新）
```

桌宠桥 `@lidozs55/dsh-schedule-bridge` 只读核心派生集，不参与这条写入链。

硬规则：

- 来源插件 `inject: ['scheduleCore', 'scheduleCommands', ...]`，核心未激活时 cordis 把来源插件 park 住。
- 来源插件**不 import 核心包的内部文件**（`host/service.js`、`host/domain.js` 等），也不打开
  `schedule_core` storage domain。核心也不 import 来源包。
- 卸载来源插件后，已写入的任务/条目与提醒必须原样存在；来源插件只影响"下一次导入"。
- 一个操作只有一个实现：来源插件的 UI 与 CLI 命令都调核心服务方法。

---

## 2. 核心公开面

注入后通过 `ctx.scheduleCore` 使用：

| 分组 | 方法 |
|---|---|
| 条目 | `listEntries(from?, to?)`、`createEntry`、`updateEntry`、`moveEntry`、`deleteEntry`、`batchCreateEntries` |
| 任务 | `listTasks({ scope, includeCompleted })`、`createTask`、`updateTask`、`setTaskCompleted`、`deleteTask` |
| 来源快照 | `replaceSourceEntries(source, inputs)` |
| 元数据 | `getMeta()`（`termStart/categories`）、`setMeta()`、`setCategories(categories)`、`getSourceState(source)`、`setSourceState(source, value)` |
| 订阅 | `subscribe(listener)`、`upcomingReminders()` |

写方法抛 `ServiceError`：`invalid_input` / `not_found` / `conflict`（带 `details.conflicts`）。
`createEntry`/`updateEntry`/`moveEntry`/`batchCreateEntries` 支持 `{ allowConflicts: true }`。

条目写入使用同一模型：

```js
{
  title, start, end, category: 'study',
  location: null, // 可选可空字符串
  lock: false,    // 默认 false；只禁止左键快捷移动/缩放
  source: 'example', sourceKey: 'stable-external-id' // 可选归属
}
```

类别来自 `getMeta().categories` 的有序 `{ id, name, color: "#RRGGBB" }` 定义，id 稳定；默认七项 `course/homework/exam/meeting/study/sports/other`，名称与颜色见 `00` §3.3。`other` 固定名“其它”、不可删除但可改色；其余预设均可删除，现有条目重归 `other`。手工未知 id 报错，来源快照未知 id 归 `other`，来源不得恢复用户删除的预设。地点不另设来源专用字段。锁定不限制编辑、删除、右键菜单或 CLI 更新。

`replaceSourceEntries(source, inputs)` 是**该来源完整条目快照**：

- `source` 必填且匹配来源 ID 文法；每个输入必须有非空、在本次快照内唯一的 `sourceKey`。
- 先归一化并校验全部输入，再按 `(source, sourceKey)` 增改与删除；输入校验失败时不开始写入。
- 稳定键匹配既有条目时保留 ID；缺席条目只从该来源删除；空快照清空该来源，不影响手建或其他来源。
- 这是完整性声明，不能拿局部抓取结果冒充完整快照；普通增量使用条目 CRUD，不另设类型或周期接口。
- 来源设置自己写 `setSourceState`，快照接口不解释学期码、教师、游戏或公告。

核心 `clearAllData()` 清空 `entries` / `tasks`，`global` 与来源状态保留。导出/导入主体为 `global`、`entries`、`tasks`，接受 UI 的 `exportedAt`；完整保留类别定义，不接受旧模型 JSON。空白目标采用导入定义，已有数据目标遇 id 语义冲突会改映射，重试复用同名同色等价定义。启动时的隔离存量转换不属于来源公开契约（见 `13-entry-model.md`）。

---

## 3. `sourceState`：来源私有状态

核心 domain 的 `global.sourceState` 是 `source id → JSON 字符串`。核心只保证持久化与往返，
不解释内容。来源插件自己决定字段。

北航适配器：

```js
sourceState.buaa = { buaaId: '25371416', termCode: '2026-2027-1' }   // 仅供显示
```

规则：

- source id 必须匹配 `^[a-z][a-z0-9_-]*$`。任务的 `source` 标记使用同一文法（不再限定固定枚举），
  新的来源插件可以用自己的 id 标记它创建的任务，例如 `createTask({ ..., source: 'jwxt' })`。
- 不要往 `sourceState` 放日程业务数据；任务/条目一律走核心服务。
- 不要放密码。SSO 密码只作当次 CLI/设置调用入参。
- **不要缓存会话**：一学期只导一次的来源，用密码换一次登录就够了；进程内 jar 缓存、cookie
  落盘、会话 jar 都会让"下次还能免密"变成需要维护的状态。北航适配器因此没有会话缓存。

---

## 4. 职责切分表

| 能力 | 核心 | 来源插件 |
|---|---|---|
| domain / schema / 冲突检测 / 撤销 | ✅ | ❌ |
| 日历面板、任务页、剪贴板、通用设置 | ✅ | ❌ |
| 通用条目/任务 CLI（`schedule entry/task`） | ✅ | ❌ |
| 提醒子系统（提前量、无状态派生、页面轮询通知） | ✅ | ❌ |
| `/api/schedule-core`、本格式 export/import | ✅ | ❌ |
| SSO / 抓取 / 解析 | ❌ | ✅ |
| 来源自己的 CLI 命名空间（如 `schedule buaa sync`） | 只提供注册表/传输 | ✅ |
| 来源设置卡与 `/api/<source>` 通道 | ❌ | ✅ |
| 来源私有状态（学号/学期码） | 只提供 `sourceState` 容器 | ✅ |

---

## 5. 新增一个来源插件（清单）

1. **建包**：`dsh-plugin/dsh-schedule-<source>/`（北航适配器即 `dsh-plugin/dsh-schedule-buaa/`），
   `name: "@lidozs55/dsh-schedule-<source>"`，
   `exports: { ".": "./index.js", "./client": "./client.js" }`，`dsh.bundle.patch` 插入自己的 row。
2. **Host 入口**：

   ```js
   export const inject = ['scheduleCore', 'connection', 'scheduleCommands']
   export async function apply(ctx) {
     const service = ctx.scheduleCore
     ctx.effect(() => registerCommands(ctx.scheduleCommands, { service }), 'source: commands')
     // 再注册自己的 api / systemPrompt（后者用 ctx.get 可选读取）
   }
   ```

   命令定义包含命名空间、子命令、选项、示例、notes 和长教程 guide；核心注册表负责校验、
   分层帮助、catalog 与分发。命令 handler 只调用 `scheduleCore` 或本来源 service，不复制业务实现。
   需要后台定时（`ctx.timer`）时把 `'timer'` 也加进 `inject`：访问未声明的服务属性会在激活时
   直接抛 `cannot get property "timer" without inject`（见 `05-time-and-background.md`）。

3. **写入**：解析外部数据 → 调用 `replaceSourceEntries(source, inputs)`（完整来源条目快照），或普通条目 CRUD / `createTask`。为每条来源条目生成稳定 `sourceKey`，不要复制冲突检测或存储实现。
4. **状态**：学号、学期码等放 `sourceState.<source>`；密码/一次性 token/会话 jar 不入库。
5. **UI**：往核心的 `schedule.settings.blocks` 子槽位注册设置卡（`ctx.slots.inject('schedule.settings.blocks', …)`），
   不要另开 `settings.section`，也不要复制日历面板。样式复用核心的 `bsch-*` 类（继承 `--dsw-*` token）。
   学期起点这类**核心已拥有的设置不要在来源卡里重复一份**。
6. **路由**：用 `ctx.connection.fetch.register` 注册 `/api/<source>-schedule`（北航即
   `/api/buaa-schedule`），沿用 `{ ok, value } | { ok, error }` wire shape；不要占用核心路由。
7. **提示词**：用 `systemPrompt.section` 加一小段来源说明，指向自己的 `schedule <命名空间> --help`，不覆盖核心段。
8. **验收**：核心卸载时来源插件必须 park；来源卸载时核心数据/提醒不受影响；重启后
   `sourceState` 仍在。

---

## 6. 反模式

- ❌ 在来源插件里再 `defineDomain` 一份 `tasks/entries`。
- ❌ 直接 `import '../schedule-core/host/service.js'` 或复制 service 代码。
- ❌ 让核心知道"北航"（核心只出现通用概念）。
- ❌ 把来源学号写进核心 `getMeta()/setMeta()` 的公开契约。
- ❌ 在来源插件里重做提醒、冲突检测、撤销栈。
- ❌ 让来源插件直接打开核心数据库、另起 CLI server 或绕过 `scheduleCommands` 暴露命令。
- ❌ 把密码写进 `sourceState`、Config、日志或命令输入。
- ❌ 为"一学期一次"的导入维护会话缓存、cookie jar 或后台作业队列——它们是长期状态，
  换来的只是省一次输密码。
- ❌ 把日历用不到的字段（教师姓名、学分、课程号、教务配色）解析进存储。

---

## 7. 北航适配器作为示例

- `host/state.js`：`sourceState.buaa`（学号/学期码，仅供显示）。
- `host/jw.js`：SSO 登录 + 两个整学期端点（`getMyScheduleDetail.do?type=term`、`exams.do`）；
  登录 jar 只在本次调用内存活，不落盘、不跨调用复用。
- `host/parse.js`：整学期课表按学期起点与教务实际周次生成带日期的普通课程条目；`exams.do` 生成考试条目与考试任务草稿。周次从 `cellDetail` 的周次行取（一个格可能有多组），退化为 `weeksAndTeachers`；单双周展开后只生成实际日期，不外推空周。教学安排使用 `category: 'course'`，考试使用 `exam`，均为 `lock: true`；地点统一为 `location`。教师姓名/学分/课程号/教务配色等日历不消费字段就地丢弃。
- 类别升级独立标记 `categoryModelVersion: 1`：只把旧 BUAA `sourceKey` 以 `teaching:` 开头、类别为 `study` 的教学条目迁为 `course`，手建学习不变；若目标类别已删则归 `other`，不复活预设。
- `host/sync.js`：一次登录 → `replaceSourceEntries('buaa', [...teachingEntries, ...examEntries])` 完整来源快照 + 考试任务对账；重复导入用稳定键保留条目 ID，缺席条目从本来源移除。学期码由 `termStart` 推导（见下），`-3` 为暑期学期。考试任务仍独立保留，身份键是**名称 + 考试日期**，同名期中/期末不能合并。任务删除范围限于本源且日期不早于学期起点；用户手建的同名考试任务只校正 `due`，标题/优先级/备注归用户。
- `host/commands.js`：`schedule buaa sync` 与导入 guide（Agent 调）。
- `host/api.js`：`/api/buaa-schedule`（设置卡调；只写学号，学期起点归核心设置页）。
- `client.settings.js`：一张设置卡（学号、密码、导入），注册进核心的 `schedule.settings.blocks`。

**学期码推导**（`host/time.js` `termCodeFor(termStart)`，按学期起点所在月份）：

| 起点月份 | 学期码 | 说明 |
|---|---|---|
| 9 月 – 次年 2 月 | `{Y}-{Y+1}-1` | 秋季学期 |
| 3 月 – 6 月 | `{Y-1}-{Y}-2` | 春季学期 |
| 7 月 – 8 月上旬 | `{Y-1}-{Y}-3` | 暑期学期 |
| 8 月下旬 | `{Y}-{Y+1}-1` | 开学周落在 8 月的秋季学期 |
