/**
 * Agent tool surface of the BUAA source adapter. Writes go through the
 * schedule core service; the tool only owns the SSO/job dance.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

const OUTPUT = { type: 'object', additionalProperties: true }

export function registerBuaaTools(ctx, deps) {
  return ctx.tools.register(defineTool({
    name: 'buaa_course_sync',
    description: '同步北航教务课表与考试安排（后台作业：从今天起逐日抓 7 天，按周期规则 upsert，不清空旧课）。密码仅当次使用、绝不保存。',
    parameters: {
      password: { type: 'string', required: true, description: '北航统一认证密码（仅当次使用，不落盘）' },
      buaa_id: { type: 'string', description: '学号；省略则用设置里保存的学号' },
      start_day: { type: 'string', description: '抓取窗口起点 YYYY-MM-DD；省略则从今天起 7 天' },
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
      const run = deps.startSync({
        buaaId: args.buaa_id,
        password: args.password,
        ...(args.start_day !== undefined ? { startDay: args.start_day } : {}),
      })
      if (!run.inline) return { jobId: run.jobId }
      return { summary: await run.done }
    },
  }))
}
