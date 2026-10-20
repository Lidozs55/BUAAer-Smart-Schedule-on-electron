# 11 · 来源适配器契约（新增学校/导入格式）

> 一句话：**核心 `@lidozs55/dsh-schedule` 拥有日程真相，来源插件只拥有"怎么把外部数据变成核心写调用"。**
> 本仓库的北航适配器 `@buaaer/dsh-schedule-buaa` 是第一个实现，可当作模板。

---

## 1. 依赖方向

```
@lidozs55/dsh-schedule          （核心：数据/服务/UI/提醒/通用工具）
        ▲              ▲
        │              │
@buaaer/dsh-schedule-buaa   @lidozs55/dsh-schedule-bridge
（北航来源适配器）           （桌宠表面，只读派生集）
```

硬规则：

- 来源插件 `inject: ['scheduleCore', ...]`，核心未激活时 cordis 把来源插件 park 住。
- 来源插件**不 import 核心包的内部文件**（`host/service.js`、`host/domain.js` 等），也不打开
  `schedule_core` storage domain。核心也不 import 来源包。
- 卸载来源插件后，已写入的课程/任务/条目与提醒必须原样存在；来源插件只影响"下一次导入"。
- 一个操作只有一个实现：来源插件的 UI、工具、命令都调核心服务方法。

---

## 2. 核心公开面

注入后通过 `ctx.scheduleCore` 使用：

| 分组 | 方法 |
|---|---|
| 条目 | `listEntries(from?, to?)`、`createEntry`、`updateEntry`、`moveEntry`、`deleteEntry`、`batchCreateEntries` |
| 任务 | `listTasks({ scope, includeCompleted })`、`createTask`、`updateTask`、`setTaskCompleted`、`deleteTask` |
| 课程 | `listCourses()`、`weekOccurrences(windowStart)`、`listCourseOverrides()`、`saveCourseOccurrence()`、`resetCourseOccurrence()`、`upsertCourses(rules)`、`replaceCourses(rules, { source, termCode })` |
| 元数据 | `getMeta()`（`termStart`）、`setMeta()`、`getSourceState(source)`、`setSourceState(source, value)` |
| 订阅 | `subscribe(listener)`、`upcomingReminders()` |

写方法抛 `ServiceError`：`invalid_input` / `not_found` / `conflict`（带 `details.conflicts`）。
`createEntry`/`updateEntry`/`moveEntry`/`batchCreateEntries` 支持 `{ allowConflicts: true }`。

课程规则对象（**没有 teacher 字段以外的展示用途，能省则省**）：

```js
{ courseName, teacher, classroom, dayOfWeek /*1-7*/,
  weekRange /* "1-16" 文法 */, startTime /*HH:mm*/, endTime /*HH:mm*/ }
```

身份键是 `(courseName, dayOfWeek, startTime, weekRange)`。两个写入入口的区别：

| 方法 | 语义 | 何时用 |
|---|---|---|
| `upsertCourses(rules)` | 只增改，**不删**缺席规则。课程行没有 source 列，因此不接收来源参数 | 只能观测到部分数据（增量、部分 JSON 导入） |
| `replaceCourses(rules, { source, termCode })` | **整份替换**：缺席的规则连同其 per-occurrence 例外一并删除，存活规则保留 id；同时把 `termCode` 记到 `sourceState[source]` | 一次拿到完整集合（整学期课表、完整导出） |

`replaceCourses` 是"这份快照就是全部事实"的声明，只在来源真的拉全时才用——用错会删掉用户
没被同步覆盖的课程。`source`/`termCode` 都可省略，省略时不写 `sourceState`（用于无来源的整份
覆盖）。核心另提供 `clearAllData()`（清空条目/任务/课程规则/例外四张表，`global` 与
`sourceState` 保留），供设置页的「清除全部日程数据」使用。

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
- 不要往 `sourceState` 放日程业务数据；课程/任务/条目一律走核心服务。
- 不要放密码。SSO 密码只作当次工具/设置调用入参。
- **不要缓存会话**：一学期只导一次的来源，用密码换一次登录就够了；进程内 jar 缓存、cookie
  落盘、会话 jar 都会让"下次还能免密"变成需要维护的状态。北航适配器因此没有会话缓存。

---

## 4. 职责切分表

| 能力 | 核心 | 来源插件 |
|---|---|---|
| domain / schema / 冲突检测 / 撤销 | ✅ | ❌ |
| 日历面板、任务页、剪贴板、通用设置 | ✅ | ❌ |
| 通用条目/任务 Agent 工具 | ✅ | ❌ |
| 提醒子系统（提前量、`ctx.schedule` 镜像） | ✅ | ❌ |
| `/api/schedule-core`、本格式 export/import | ✅ | ❌ |
| SSO / 抓取 / 解析 | ❌ | ✅ |
| 来源自己的 Agent 工具（如 `buaa_course_sync`） | ❌ | ✅ |
| 来源设置卡与 `/api/<source>` 通道 | ❌ | ✅ |
| 来源私有状态（学号/学期码） | 只提供 `sourceState` 容器 | ✅ |

---

## 5. 新增一个来源插件（清单）

1. **建包**：`dsh-plugin/dsh-schedule-<source>/`（北航适配器即 `dsh-plugin/dsh-schedule-buaa/`），
   `name: "@lidozs55/dsh-schedule-<source>"`，
   `exports: { ".": "./index.js", "./client": "./client.js" }`，`dsh.bundle.patch` 插入自己的 row。
2. **Host 入口**：

   ```js
   export const inject = ['scheduleCore', 'connection', 'tools']
   export async function apply(ctx) {
     const service = ctx.scheduleCore
     // 注册自己的 tools / api / systemPrompt（后两者用 ctx.get）
   }
   ```

3. **写入**：解析外部数据 → 调用 `replaceCourses`（拉全时）/ `upsertCourses`（增量时）/
   `createTask` / `createEntry`。不要复制一套冲突检测或存储实现。
4. **状态**：学号、学期码等放 `sourceState.<source>`；密码/一次性 token/会话 jar 不入库。
5. **UI**：往核心的 `schedule.settings.blocks` 子槽位注册设置卡（`ctx.slots.inject('schedule.settings.blocks', …)`），
   不要另开 `settings.section`，也不要复制日历面板。样式复用核心的 `bsch-*` 类（继承 `--dsw-*` token）。
   学期起点这类**核心已拥有的设置不要在来源卡里重复一份**。
6. **路由**：用 `ctx.connection.fetch.register` 注册 `/api/<source>-schedule`（北航即
   `/api/buaa-schedule`），沿用 `{ ok, value } | { ok, error }` wire shape；不要占用核心路由。
7. **提示词**：用 `systemPrompt.section` 加一小段来源说明，不覆盖核心段。
8. **验收**：核心卸载时来源插件必须 park；来源卸载时核心数据/提醒不受影响；重启后
   `sourceState` 仍在。

---

## 6. 反模式

- ❌ 在来源插件里再 `defineDomain` 一份 `courses/tasks/entries`。
- ❌ 直接 `import '../schedule-core/host/service.js'` 或复制 service 代码。
- ❌ 让核心知道"北航"（核心只出现通用概念）。
- ❌ 把来源学号写进核心 `getMeta()/setMeta()` 的公开契约。
- ❌ 在来源插件里重做提醒、冲突检测、撤销栈。
- ❌ 把密码写进 `sourceState`、Config、日志或会话命令输入。
- ❌ 为"一学期一次"的导入维护会话缓存、cookie jar 或后台作业队列——它们是长期状态，
  换来的只是省一次输密码。
- ❌ 把日历用不到的字段（教师姓名、学分、课程号、教务配色）解析进存储。

---

## 7. 北航适配器作为示例

- `host/state.js`：`sourceState.buaa`（学号/学期码，仅供显示）。
- `host/jw.js`：SSO 登录 + 两个整学期端点（`getMyScheduleDetail.do?type=term`、`exams.do`）；
  登录 jar 只在本次调用内存活，不落盘、不跨调用复用。
- `host/parse.js`：整学期课表 → 课程规则；`exams.do` → 考试任务草稿。周次从 `cellDetail` 的
  `教师[3-12周]` 行取（一个格可能有多组），退化为 `weeksAndTeachers`；单双周展开成具体周次；
  教师姓名/学分/课程号/教务配色等日历不消费的字段就地丢弃。考试只留课程名、开始时刻、地点、
  座位、结束时刻（任务模型没有结束字段，结束时间进备注）。
- `host/sync.js`：一次登录 → 课表 `replaceCourses`（整份替换）+ 考试 task 对账。学期码由
  `termStart` 推导（见下），`-3` 为暑期学期。考试同样按整学期快照对账，身份键是
  **（课程名 + 考试日期）而不是课程名**——同一门课一学期可能有两场（期中 + 期末），只按名字
  去重会把它们合成一条。删除范围限定在「本源创建、且日期不早于本学期起点」的任务，上学期
  的历史不会被清掉；用户手工建的同名考试任务只校正 `due`，标题/优先级/备注归用户。
- `host/tools.js`：`buaa_course_sync`（Agent 调）。
- `host/api.js`：`/api/buaa-schedule`（设置卡调；只写学号，学期起点归核心设置页）。
- `client.settings.js`：一张设置卡（学号、密码、导入），注册进核心的 `schedule.settings.blocks`。

**学期码推导**（`host/time.js` `termCodeFor(termStart)`，按学期起点所在月份）：

| 起点月份 | 学期码 | 说明 |
|---|---|---|
| 9 月 – 次年 2 月 | `{Y}-{Y+1}-1` | 秋季学期 |
| 3 月 – 6 月 | `{Y-1}-{Y}-2` | 春季学期 |
| 7 月 – 8 月上旬 | `{Y-1}-{Y}-3` | 暑期学期 |
| 8 月下旬 | `{Y}-{Y+1}-1` | 开学周落在 8 月的秋季学期 |
