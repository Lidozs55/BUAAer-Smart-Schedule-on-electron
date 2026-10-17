/**
 * Agent tool surface (§5.2 of the ledger). Every tool delegates to the one
 * service — the same methods the client panel calls — and returns a
 * canonical structured value; prose lives only in `render`. Conflict
 * rejections come back as a structured value (not an error) so the model
 * can read the reasons and retry with `allow_conflicts`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ENTRY_CATEGORIES, PRIORITIES, TASK_TYPES } from './domain.js'
import { startSyncJob } from './sync.js'

const OUTPUT = { type: 'object', additionalProperties: true }

const short = iso => (typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 16) : String(iso))
const isoParam = description => ({ type: 'string', description })
const enumParam = (values, description) => ({ type: 'string', enum: values, description })

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
  if (args.category !== undefined) input.category = args.category
  if (args.start !== undefined) input.start = args.start
  if (args.end !== undefined) input.end = args.end
  if (args.all_day !== undefined) input.allDay = args.all_day
  if (args.task_id !== undefined) input.taskId = args.task_id
  return input
}

/**
 * Spec table: one row per tool; `method` names the service method and
 * `args` builds its argument list from validated tool input.
 */
const TOOLS = [
  {
    name: 'buaaer_task_list',
    method: 'listTasks',
    description: '查询日程库中的任务（作业/考试/其他截止事项）。回答"我这周有什么要交"这类问题用它。',
    parameters: {
      scope: enumParam(['today', 'week', 'overdue', 'all'], '查询范围，默认 all'),
      include_completed: { type: 'boolean', description: '是否包含已完成任务，默认 false' },
    },
    args: args => [{ scope: args.scope ?? 'all', includeCompleted: args.include_completed ?? false }],
    wrap: value => ({ count: value.length, tasks: value }),
    summarize: value => `共 ${value.count} 条任务`,
  },
  {
    name: 'buaaer_entry_list',
    method: 'listEntries',
    description: '查询日历条目。from/to 均为带时区 ISO 8601，窗口为左闭右开 [from, to)；省略则返回全部。课程占位用 week_start 现算。',
    parameters: {
      from: isoParam('窗口起点，如 2026-10-19T00:00:00+08:00'),
      to: isoParam('窗口终点（不含）'),
      week_start: { type: 'string', description: 'YYYY-MM-DD；给出时同时返回该教学周的课程出现' },
    },
    args: args => [args.from, args.to],
    wrap: (value, args, service) => ({
      count: value.length,
      entries: value,
      occurrences: args.week_start ? service.weekOccurrences(args.week_start) : [],
    }),
    summarize: value => `${value.count} 条条目、${value.occurrences.length} 个课程出现`,
  },
  {
    name: 'buaaer_task_create',
    method: 'createTask',
    description: '创建一条任务（截止事项）。用户提到作业、考试、报名截止等需要跟踪的事项时使用。',
    parameters: {
      title: { type: 'string', required: true, description: '任务标题' },
      due: { ...isoParam('截止时间，带时区 ISO 8601'), required: true },
      task_type: enumParam(TASK_TYPES, '类别，默认 other'),
      priority: enumParam(PRIORITIES, '优先级，默认 medium'),
      description: { type: 'string', description: '备注，可省略' },
    },
    args: args => [{
      ...taskPatch(args),
      taskType: args.task_type ?? 'other',
      priority: args.priority ?? 'medium',
      source: 'agent',
    }],
    summarize: value => `已创建任务「${value.title}」（${short(value.due)} 截止）`,
  },
  {
    name: 'buaaer_task_update',
    method: 'updateTask',
    description: '修改一条任务（标题/描述/截止/优先级/类型）。完成任务请改用 buaaer_task_complete。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id' },
      title: { type: 'string', description: '新标题' },
      due: isoParam('新截止时间'),
      task_type: enumParam(TASK_TYPES, '新类别'),
      priority: enumParam(PRIORITIES, '新优先级'),
      description: { type: 'string', description: '新备注；传空字符串表示清除' },
    },
    args: args => [args.id, taskPatch(args)],
    summarize: () => '任务已更新',
  },
  {
    name: 'buaaer_task_complete',
    method: 'setTaskCompleted',
    description: '把一条任务标记为完成（completed 省略或 true），或撤销完成（false）。',
    parameters: {
      id: { type: 'string', required: true, description: '任务 id' },
      completed: { type: 'boolean', description: '默认 true' },
    },
    args: args => [args.id, args.completed ?? true],
    summarize: (value, args) => `任务已${(args.completed ?? true) ? '' : '取消'}完成`,
  },
  {
    name: 'buaaer_task_delete',
    method: 'deleteTask',
    description: '删除一条任务（不可恢复；对应提醒会自动撤销）。',
    parameters: { id: { type: 'string', required: true, description: '任务 id' } },
    args: args => [args.id],
    summarize: () => '任务已删除',
  },
  {
    name: 'buaaer_entry_create',
    method: 'createEntry',
    description: '创建一条日历条目（会议、自习、运动等占时事项；课程由同步产生，勿手工建）。与课程或既有条目重叠时返回冲突原因；确认要重叠时传 allow_conflicts=true。',
    parameters: {
      title: { type: 'string', required: true, description: '条目标题' },
      start: { ...isoParam('开始时间，带时区 ISO 8601'), required: true },
      end: { ...isoParam('结束时间，带时区 ISO 8601'), required: true },
      category: enumParam(ENTRY_CATEGORIES, '类别（决定显示配色），默认 other'),
      description: { type: 'string', description: '备注，可省略' },
      all_day: { type: 'boolean', description: '全天条目；此时 start 传当天日期即可' },
      allow_conflicts: { type: 'boolean', description: '允许与既有日程重叠，默认 false' },
    },
    args: args => [entryInput(args), { allowConflicts: args.allow_conflicts ?? false }],
    summarize: value => `已创建条目「${value.title}」（${short(value.start)} 起）`,
  },
  {
    name: 'buaaer_entry_update',
    method: 'updateEntry',
    description: '修改一条日历条目（改时间即改期，不必删除重建）。',
    parameters: {
      id: { type: 'string', required: true, description: '条目 id' },
      title: { type: 'string', description: '新标题' },
      start: isoParam('新开始时间'),
      end: isoParam('新结束时间'),
      category: enumParam(ENTRY_CATEGORIES, '新类别'),
      description: { type: 'string', description: '新备注；传空字符串表示清除' },
      allow_conflicts: { type: 'boolean', description: '允许与既有日程重叠，默认 false' },
    },
    args: args => [args.id, entryInput(args), { allowConflicts: args.allow_conflicts ?? false }],
    summarize: () => '条目已更新',
  },
  {
    name: 'buaaer_entry_delete',
    method: 'deleteEntry',
    description: '删除一条日历条目（不可恢复）。',
    parameters: { id: { type: 'string', required: true, description: '条目 id' } },
    args: args => [args.id],
    summarize: () => '条目已删除',
  },
  {
    name: 'buaaer_entry_batch_create',
    method: 'batchCreateEntries',
    description: '批量创建日历条目（解析待办/剪贴板内容后的落库入口）。逐条校验、返回逐条成功/失败，单条失败不中断整批。',
    parameters: {
      entries: {
        type: 'array', required: true,
        description: '条目数组，每项含 title/start/end，可选 category/description/all_day',
        items: { type: 'object', additionalProperties: true },
      },
      allow_conflicts: { type: 'boolean', description: '允许与既有日程重叠，默认 false' },
    },
    args: args => [args.entries.map(item => entryInput(item)), { allowConflicts: args.allow_conflicts ?? false }],
    wrap: results => ({ okCount: results.filter(item => item.ok).length, total: results.length, results }),
    summarize: value => `批量完成：${value.okCount}/${value.total} 条成功`,
  },
]

/**
 * Register the full tool set on the caller's context.
 * @returns {() => void} disposer removing every registration.
 */
export function registerScheduleTools(ctx, service, deps) {
  const disposers = []

  for (const spec of TOOLS) {
    disposers.push(ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: OUTPUT,
        render: (args, value) => [{ type: 'text', text: renderText(spec, value, args) }],
      },
      // Writes are deliberately not concurrency-safe: exclusive scheduling
      // serializes writes onto the shared domain.
      async execute(args, exec) {
        if (exec.signal.aborted) throw new Error('cancelled')
        try {
          const value = await service[spec.method](...spec.args(args))
          return spec.wrap === undefined ? value : spec.wrap(value, args, service)
        } catch (error) {
          if (error.code === 'conflict') {
            return { ok: false, conflicts: error.details?.conflicts ?? [] }
          }
          throw error
        }
      },
    })))
  }

  disposers.push(ctx.tools.register(defineTool({
    name: 'buaaer_course_sync',
    description: '同步北航教务课表与考试安排（后台作业：从今天起逐日抓 7 天，按周期规则 upsert，不清空旧课）。密码仅当次使用、绝不保存。',
    parameters: {
      password: { type: 'string', required: true, description: '北航统一认证密码（仅当次使用，不落盘）' },
      buaa_id: { type: 'string', description: '学号；省略则用设置里保存的学号' },
    },
    output: {
      schema: OUTPUT,
      render: (args, value) => [{
        type: 'text',
        text: value.jobId !== undefined
          ? `同步作业已启动（${value.jobId}），进度见作业面板；完成后课程与考试任务会出现在日程里`
          : `同步完成：${value.summary.daysFetched}/7 天，课程规则 ${value.summary.courses.total} 条（新增 ${value.summary.courses.created}），考试 ${value.summary.exams.total} 条`,
      }],
    },
    timeoutMs: 180_000,
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      const run = startSyncJob(deps, { buaaId: args.buaa_id, password: args.password })
      if (!run.inline) return { jobId: run.jobId }
      return { summary: await run.done }
    },
  })))

  return () => disposers.forEach(dispose => dispose())
}

function renderText(spec, value, args) {
  if (value !== null && typeof value === 'object' && value.ok === false && Array.isArray(value.conflicts)) {
    const reasons = value.conflicts.map(conflict => conflict.reason).join('；')
    return `未写入：${reasons}。如确认要重叠，请带 allow_conflicts=true 重试`
  }
  return spec.summarize(value, args)
}
