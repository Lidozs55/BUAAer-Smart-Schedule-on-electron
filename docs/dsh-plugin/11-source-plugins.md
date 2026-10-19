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
| 课程 | `listCourses()`、`weekOccurrences(windowStart)`、`listCourseOverrides()`、`saveCourseOccurrence()`、`resetCourseOccurrence()`、`upsertCourses(rules, { source, termCode })` |
| 元数据 | `getMeta()`（`termStart`）、`setMeta()`、`getSourceState(source)`、`setSourceState(source, value)` |
| 订阅 | `subscribe(listener)`、`upcomingReminders()` |

写方法抛 `ServiceError`：`invalid_input` / `not_found` / `conflict`（带 `details.conflicts`）。
`createEntry`/`updateEntry`/`moveEntry`/`batchCreateEntries` 支持 `{ allowConflicts: true }`。

`upsertCourses` 的规则对象：

```js
{ courseName, teacher, classroom, dayOfWeek /*1-7*/,
  weekRange /* "1-16" 文法 */, startTime /*HH:mm*/, endTime /*HH:mm*/ }
```

身份键是 `(courseName, dayOfWeek, startTime, weekRange)`；不会清表。只有同一来源上次报告的
`termCode` 与本次不同时，才清空旧课程规则与 per-occurrence 例外（学期边界）。

---

## 3. `sourceState`：来源私有状态

核心 domain 的 `global.sourceState` 是 `source id → JSON 字符串`。核心只保证持久化与往返，
不解释内容。来源插件自己决定字段。

北航适配器：

```js
sourceState.buaa = { buaaId: '25371416', termCode: '2026-2027-1' }
```

规则：

- source id 必须匹配 `^[a-z][a-z0-9_-]*$`。任务的 `source` 标记使用同一文法（不再限定固定枚举），
  新的来源插件可以用自己的 id 标记它创建的任务，例如 `createTask({ ..., source: 'jwxt' })`。
- 不要往 `sourceState` 放日程业务数据；课程/任务/条目一律走核心服务。
- 不要放密码。SSO 密码只作当次工具/设置调用入参。

---

## 4. 职责切分表

| 能力 | 核心 | 来源插件 |
|---|---|---|
| domain / schema / 冲突检测 / 撤销 | ✅ | ❌ |
| 日历面板、任务页、剪贴板、通用设置 | ✅ | ❌ |
| 通用条目/任务 Agent 工具 | ✅ | ❌ |
| 提醒子系统（提前量、`ctx.schedule` 镜像） | ✅ | ❌ |
| `/api/schedule-core`、本格式 export/import | ✅ | ❌ |
| SSO / 目标网站抓取 / 解析 | ❌ | ✅ |
| 来源自己的 Agent 工具（如 `buaa_course_sync`） | ❌ | ✅ |
| 来源设置卡与 `/api/<source>` 通道 | ❌ | ✅ |
| 来源命令（如 `/buaa-sync`、`/buaa-import`） | ❌ | ✅ |
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
     // 注册自己的 tools / api / commands / systemPrompt（后三者用 ctx.get）
   }
   ```

3. **写入**：解析外部数据 → 调用 `upsertCourses` / `createTask` / `createEntry`。不要复制一套
   冲突检测或存储实现。
4. **状态**：学号、token 引用、学期码等放 `sourceState.<source>`；密码/一次性 token 不入库。
5. **UI**：往核心的 `schedule.settings.blocks` 子槽位注册设置卡（`ctx.slots.inject('schedule.settings.blocks', …)`），
   不要另开 `settings.section`，也不要复制日历面板。样式复用核心的 `bsch-*` 类（继承 `--dsw-*` token）。
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

---

## 7. 北航适配器作为示例

- `host/state.js`：`sourceState.buaa`（学号/学期码）。
- `host/sso.js` / `host/sync.js`：SSO 登录、7 天抓取、考试任务、`ctx.jobs` 作业。
- `host/tools.js`：`buaa_course_sync`（Agent 调）。
- `host/api.js`：`/api/buaa-schedule`（设置卡调）。
- `host/commands.js`：`/buaa-sync`（缓存会话免密）与 `/buaa-import`（旧库）。
- `client.settings.js`：三张设置卡（学号、同步、旧库导入），注册进核心的 `schedule.settings.blocks`。
