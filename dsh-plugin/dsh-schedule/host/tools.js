/**
 * Agent tool surface (§5.2 of the ledger). Every tool delegates to the one
 * service — the same methods the client panel calls — and returns a
 * canonical structured value; prose lives only in `render`. Conflict
 * rejections come back as a structured value (not an error) so the model
 * can read the reasons and retry with `allow_conflicts`.
 *
 * Compact surface (2026-10-20): the ten original one-verb tools were
 * folded into two family tools plus the source adapter's sync tool. Tool
 * schemas are sent with every request, so the verbs are an `action` enum
 * instead of separate declarations; per-action formats and category rules
 * live in the `schedule` skill and are loaded only when needed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ENTRY_CATEGORIES, PRIORITIES, TASK_TYPES } from './model.js'

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
  return input
}

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
      const entries = service.listEntries(args.from, args.to)
      return {
        count: entries.length,
        entries,
      }
    }
    case 'create':
      return service.createEntry(entryInput(args), { allowConflicts: args.allow_conflicts ?? false })
    case 'update':
      return service.updateEntry(args.id, entryInput(args), { allowConflicts: args.allow_conflicts ?? false })
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
        results,
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
    description: '查询或修改任务（作业/考试/截止事项）。action 选操作；时间用带时区 ISO 8601。规则见 schedule skill。',
    parameters: {
      action: { ...enumParam(TASK_ACTIONS, 'list 查 / create 建 / update 改 / complete 完成或取消 / delete 删'), required: true },
      id: { type: 'string', description: '任务 id（update/complete/delete）' },
      title: { type: 'string', description: '标题（create 必填）' },
      due: isoParam('截止时间（create 必填），如 2026-10-19T23:59:00+08:00'),
      task_type: enumParam(TASK_TYPES, '类别，默认 other'),
      priority: enumParam(PRIORITIES, '优先级，默认 medium'),
      description: { type: 'string', description: '备注；更新时传空字符串表示清除' },
      completed: { type: 'boolean', description: 'complete 用，默认 true；false 表示撤销' },
      entry_id: { type: 'string', description: '关联的日历条目 id，可省略' },
      scope: enumParam(['today', 'week', 'overdue', 'all'], 'list 范围，默认 all'),
      include_completed: { type: 'boolean', description: 'list 是否含已完成，默认 false' },
    },
    run: runTask,
    render: renderTask,
  },
  {
    name: 'sched_entry',
    description: '查询或修改日历条目（会议/自习/运动等占时事项）。action 选操作；时间用带时区 ISO 8601。规则见 schedule skill。',
    parameters: {
      action: { ...enumParam(ENTRY_ACTIONS, 'list 查 / create 建 / update 改 / delete 删 / batch_create 批量建'), required: true },
      id: { type: 'string', description: '条目 id（update/delete）' },
      title: { type: 'string', description: '标题（create/batch_create 必填）' },
      start: isoParam('开始时间（create 必填）；全天条目传当天日期'),
      end: isoParam('结束时间（create 必填）；全天条目可省略'),
      category: enumParam(ENTRY_CATEGORIES, '类别，默认 other'),
      description: { type: 'string', description: '备注；更新时传空字符串表示清除' },
      location: { type: 'string', description: '地点，可省略；空字符串清除' },
      lock: { type: 'boolean', description: '只禁止日程表左键快捷拖动，默认 false；仍可编辑和删除' },
      all_day: { type: 'boolean', description: '全天条目' },
      task_id: { type: 'string', description: '关联任务 id，可省略' },
      allow_conflicts: { type: 'boolean', description: '允许重叠，默认 false' },
      from: isoParam('list 窗口起点（含）'),
      to: isoParam('list 窗口终点（不含）'),
      entries: {
        type: 'array',
        description: 'batch_create 的条目数组，每项含 title/start/end 及可选字段',
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
        render: (args, value) => [{ type: 'text', text: spec.render(args, value) }],
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
