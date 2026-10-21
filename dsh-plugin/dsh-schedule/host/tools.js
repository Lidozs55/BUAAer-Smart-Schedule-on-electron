/**
 * Agent tool surface (§5.2 of the ledger). Every tool delegates to the one
 * service — the same methods the client panel calls — and returns a
 * canonical structured value; prose lives only in `render`. Conflict
 * rejections come back as a structured value (not an error) so the model
 * can read the reasons and retry with `allow_conflicts`.
 *
 * Compact surface (2026-10-20): the ten original one-verb tools were
 * folded into the core's two family tools. Tool
 * schemas are sent with every request, so the verbs are an `action` enum
 * instead of separate declarations; per-action formats and category rules
 * live in the `schedule` skill and are loaded only when needed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PRIORITIES, TASK_TYPES } from './model.js'
import { dayOfWeek, termWeek } from './semester.js'

// Use the entry's explicit calendar date, independent of the host's time zone.
const entryResult = (entry, termStart) => ({
  ...entry,
  week: termWeek(termStart, entry.start.slice(0, 10)),
  dayOfWeek: dayOfWeek(entry.start.slice(0, 10)),
})

const OUTPUT = { type: 'object', additionalProperties: true }

const short = iso => (typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 16) : String(iso))
const isoParam = description => ({ type: 'string', description })
const enumParam = (values, description) => ({ type: 'string', enum: values, description })

const TASK_ACTIONS = ['list', 'create', 'update', 'complete', 'delete']
const ENTRY_ACTIONS = ['list', 'create', 'update', 'delete', 'batch_create']

/** Map snake_case tool args onto the service's camelCase inputs. */
function taskPatch(args) {
  const patch = {}
  if (args.title !== undefined) patch.title = args.title
  if (args.due !== undefined) patch.due = args.due
  if (args.description !== undefined) patch.description = args.description
  if (args.task_type !== undefined) patch.taskType = args.task_type
  if (args.priority !== undefined) patch.priority = args.priority
  if (args.completed !== undefined) patch.completed = args.completed
  if (args.entry_id !== undefined) patch.entryId = args.entry_id
  if (args.remind_lead !== undefined) patch.remindLead = leadOf(args.remind_lead)
  return patch
}

function entryInput(args) {
  const input = {}
  if (args.title !== undefined) input.title = args.title
  if (args.description !== undefined) input.description = args.description
  if (args.location !== undefined) input.location = args.location
  if (args.lock !== undefined) input.lock = args.lock
  if (args.category !== undefined) input.category = args.category
  if (args.start !== undefined) input.start = args.start
  if (args.end !== undefined) input.end = args.end
  if (args.all_day !== undefined) input.allDay = args.all_day
  if (args.task_id !== undefined) input.taskId = args.task_id
  if (args.remind_lead !== undefined) input.remindLead = leadOf(args.remind_lead)
  return input
}

/** `-1` (or null) clears the override back to the global tier default. */
const leadOf = value => (value === -1 || value === null ? null : value)

async function runTask(service, args) {
  switch (args.action) {
    case 'list': {
      const tasks = service.listTasks({
        scope: args.scope ?? 'all',
        includeCompleted: args.include_completed ?? false,
      })
      return { count: tasks.length, tasks }
    }
    case 'create':
      return service.createTask({
        ...taskPatch(args),
        taskType: args.task_type ?? 'other',
        priority: args.priority ?? 'medium',
        source: 'agent',
      })
    case 'update':
      return service.updateTask(args.id, taskPatch(args))
    case 'complete':
      return service.setTaskCompleted(args.id, args.completed ?? true)
    case 'delete':
      return service.deleteTask(args.id)
    default:
      throw new Error(`未知 action：${args.action}`)
  }
}

async function runEntry(service, args) {
  switch (args.action) {
    case 'list': {
      const meta = service.getMeta()
      const entries = service.listEntries(args.from, args.to).map(entry => entryResult(entry, meta.termStart))
      return { count: entries.length, entries, categories: meta.categories, termStart: meta.termStart }
    }
    case 'create':
      return entryResult(await service.createEntry(entryInput(args), { allowConflicts: args.allow_conflicts ?? false }), service.getMeta().termStart)
    case 'update':
      return entryResult(await service.updateEntry(args.id, entryInput(args), { allowConflicts: args.allow_conflicts ?? false }), service.getMeta().termStart)
    case 'delete':
      return service.deleteEntry(args.id)
    case 'batch_create': {
      if (!Array.isArray(args.entries) || args.entries.length === 0) {
        throw new Error('batch_create 需要非空的 entries 数组')
      }
      const results = await service.batchCreateEntries(
        args.entries.map(item => entryInput(item)),
        { allowConflicts: args.allow_conflicts ?? false },
      )
      return {
        okCount: results.filter(item => item.ok).length,
        total: results.length,
        results: results.map(item => item.ok
          ? { ...item, entry: entryResult(item.entry, service.getMeta().termStart) }
          : item),
      }
    }
    default:
      throw new Error(`未知 action：${args.action}`)
  }
}

function renderTask(args, value) {
  if (conflicted(value)) return conflictText(value)
  switch (args.action) {
    case 'list': return `共 ${value.count} 条任务`
    case 'create': return `已创建任务「${value.title}」（${short(value.due)} 截止）`
    case 'update': return '任务已更新'
    case 'complete': return `任务已${(args.completed ?? true) ? '' : '取消'}完成`
    case 'delete': return '任务已删除'
    default: return '完成'
  }
}

function renderEntry(args, value) {
  if (conflicted(value)) return conflictText(value)
  switch (args.action) {
    case 'list': return `${value.count} 条条目`
    case 'create': return `已创建条目「${value.title}」（${short(value.start)} 起）`
    case 'update': return '条目已更新'
    case 'delete': return '条目已删除'
    case 'batch_create': return `批量完成：${value.okCount}/${value.total} 条成功`
    default: return '完成'
  }
}

const conflicted = value =>
  value !== null && typeof value === 'object' && value.ok === false && Array.isArray(value.conflicts)

const conflictText = value =>
  `未写入：${value.conflicts.map(conflict => conflict.reason).join('；')}。如确认要重叠，请带 allow_conflicts=true 重试`

const TOOLS = [
  {
    name: 'sched_task',
    description: '查询或修改有截止时间、可标记完成的待办任务；占时活动用 sched_entry。list 返回 tasks，写入回显结果；操作规则见 schedule skill。',
    parameters: {
      action: { ...enumParam(TASK_ACTIONS, 'list 查 / create 建 / update 改 / complete 完成或取消 / delete 删'), required: true },
      id: { type: 'string', description: '已有任务的真实 id（update/complete/delete 必填）' },
      title: { type: 'string', description: '标题（create 必填）' },
      due: isoParam('截止时间（create 必填），如 2026-10-19T23:59:00+08:00'),
      task_type: enumParam(TASK_TYPES, '任务类型（固定枚举，非条目类别），默认 other'),
      priority: enumParam(PRIORITIES, '优先级，默认 medium'),
      description: { type: 'string', description: '备注；更新时传空字符串表示清除' },
      completed: { type: 'boolean', description: '完成状态；complete 省略为 true，false 表示撤销完成' },
      entry_id: { type: 'string', description: '关联的日历条目 id，可省略' },
      remind_lead: { type: 'number', description: '提醒提前分钟数（0=截止时提醒，1440=提前 1 天；-1 或省略=跟随全局默认设置）' },
      scope: enumParam(['today', 'week', 'overdue', 'all'], 'list 范围，默认 all；week 为从现在起未来 7 天，非自然周'),
      include_completed: { type: 'boolean', description: 'list 是否含已完成，默认 false' },
    },
    run: runTask,
    render: renderTask,
  },
  {
    name: 'sched_entry',
    description: '查询或修改占用时间的日历条目。list 返回 entries/categories/termStart，创建/更新回显完整条目及 week/dayOfWeek；默认拒绝时间冲突，允许重叠须经用户确认。规则见 schedule skill。',
    parameters: {
      action: { ...enumParam(ENTRY_ACTIONS, 'list 查 / create 建 / update 改 / delete 删 / batch_create 批量建'), required: true },
      id: { type: 'string', description: '已有条目的真实 id（update/delete 必填）' },
      title: { type: 'string', description: '标题（create/batch_create 必填）' },
      start: isoParam('带时区的开始时间（create 必填）；单日全天条目传 YYYY-MM-DD'),
      end: isoParam('带时区的结束时间（普通 create 必填且晚于 start）；单日全天条目可省略'),
      category: { type: 'string', description: '类别 id，默认 other；list 返回当前可用 categories' },
      description: { type: 'string', description: '备注；更新时传空字符串表示清除' },
      location: { type: 'string', description: '地点，可省略；空字符串清除' },
      lock: { type: 'boolean', description: '只禁止页面快捷拖动/缩放，默认 false；仍可工具改期、编辑和删除' },
      all_day: { type: 'boolean', description: '单日全天条目，start 传 YYYY-MM-DD，按服务本地时区处理' },
      task_id: { type: 'string', description: '关联任务 id，可省略' },
      remind_lead: { type: 'number', description: '提醒提前分钟数（0=开始时提醒，1440=提前 1 天；-1 或省略=跟随全局默认设置）' },
      allow_conflicts: { type: 'boolean', description: '经用户确认后允许时间重叠，默认 false；不覆盖已有条目；批量时作用于全部项' },
      from: isoParam('list 查询窗口起点（含），带时区 ISO 8601；返回与窗口相交的条目'),
      to: isoParam('list 查询窗口终点（不含），带时区 ISO 8601；省略边界则不限制该侧'),
      entries: {
        type: 'array',
        description: 'batch_create 非空数组，每项用 create 字段（单日全天可省略 end）；allow_conflicts 只放顶层；逐项回执，仅重试失败项',
        items: { type: 'object', additionalProperties: true },
      },
    },
    run: runEntry,
    render: renderEntry,
  },
]

/**
 * Register the generic tool set on the caller's context. Source adapters
 * register their own sync/import tools separately.
 * @returns {() => void} disposer removing every registration.
 */
export function registerScheduleTools(ctx, service) {
  const disposers = []

  for (const spec of TOOLS) {
    disposers.push(ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: OUTPUT,
        // Only rendered content reaches the model; the canonical value alone does not.
        render: (args, value) => [
          { type: 'text', text: `${spec.render(args, value)}\n` },
          { type: 'text', text: JSON.stringify(value) },
        ],
      },
      // Writes are deliberately not concurrency-safe: exclusive scheduling
      // serializes writes onto the shared domain.
      async execute(args, exec) {
        if (exec.signal.aborted) throw new Error('cancelled')
        try {
          return await spec.run(service, args)
        } catch (error) {
          if (error.code === 'conflict') {
            return { ok: false, conflicts: error.details?.conflicts ?? [] }
          }
          throw error
        }
      },
    })))
  }

  return () => disposers.forEach(dispose => dispose())
}
