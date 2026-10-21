/**
 * Agent tool surface of the BUAA source adapter. Writes go through the
 * schedule core service; the tool only owns the login + fetch.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

const OUTPUT = { type: 'object', additionalProperties: true }

export function registerBuaaTools(ctx, deps) {
  return ctx.tools.register(defineTool({
    name: 'buaa_course_sync',
    description: '从北航教务导入整学期课表与考试安排（一次请求拿全学期，按课表自带周次写入，新导入会替换此前同步的日程）。需要学期起始日期（第一周周一）；密码仅当次使用、不保存。',
    parameters: {
      password: { type: 'string', required: true, description: '北航统一认证密码（仅当次使用，不落盘）' },
      buaa_id: { type: 'string', description: '学号；省略则用设置里保存的学号' },
      term_start: { type: 'string', description: '学期起始日期 YYYY-MM-DD（第一周周一）；省略则用日程设置里已保存的值' },
    },
    output: {
      schema: OUTPUT,
      render: (args, value) => [{ type: 'text', text: describe(value) }],
    },
    timeoutMs: 180_000,
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      return deps.runSync({
        buaaId: args.buaa_id,
        password: args.password,
        ...(args.term_start !== undefined ? { termStart: args.term_start } : {}),
      })
    },
  }))
}

const describe = summary => [
  `同步完成（${summary.termLabel}）：日程 ${summary.entries.total} 条`,
  `（新增 ${summary.entries.created}、更新 ${summary.entries.updated}、移除 ${summary.entries.cleared}）`,
  `，覆盖第 ${summary.weeksCovered.join('、')} 周`,
  `，考试 ${summary.exams.total} 条（新增 ${summary.exams.created}、更新 ${summary.exams.updated}、移除 ${summary.exams.removed}）`,
  summary.exams.failed ? `；考试安排读取失败，保留原有考试：${summary.exams.failed}` : '',
].join('')