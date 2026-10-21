/**
 * Host half of @buaaer/dsh-schedule-buaa — the BUAA JW source adapter.
 *
 * Hard dependency: `scheduleCore` (the generic schedule core). This bundle
 * owns the BUAA-specific parts (student id, SSO login, JW endpoints, parsing)
 * and writes dated teaching/exam entries and exam tasks through the core service. Removing it
 * leaves the core and its data untouched.
 *
 * One sync = one whole term: the JW timetable endpoint returns every cell of
 * the semester with its own week information, so there is no window, no
 * paging, no session to keep alive and nothing to extrapolate.
 */
import { registerBuaaApi } from './host/api.js'
import { runSync } from './host/sync.js'
import { registerBuaaTools } from './host/tools.js'

export const inject = ['scheduleCore', 'connection', 'tools']

export async function apply(ctx) {
  const service = ctx.scheduleCore
  const deps = { service, runSync: creds => runSync({ service }, creds) }

  ctx.effect(() => registerBuaaTools(ctx, deps), 'buaa-schedule: tools')
  ctx.effect(() => registerBuaaApi(ctx, deps), 'buaa-schedule: api')

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'buaa-schedule',
      order: 1001,
      text: () => [
        '北航教务导入插件已启用：用 buaa_course_sync 一次导入整学期课表与考试。',
        '它需要密码（仅当次使用、不保存）和学期起始日期（第一周周一，已保存在日程设置里则不必重复给）。',
        '导入是整学期快照：课表自带的周次即最终周次，重复导入会替换此前的教学与考试日程，未排课的空缺不会被外推。',
      ].join('\n'),
    }), 'buaa-schedule: prompt section')
  }

  ctx.logger.info('buaa-schedule: BUAA source adapter active')
}