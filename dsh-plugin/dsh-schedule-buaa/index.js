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
import { registerBuaaCommands } from './host/commands.js'

export const inject = ['scheduleCore', 'connection', 'scheduleCommands']

export async function apply(ctx) {
  const service = ctx.scheduleCore
  const deps = { service, runSync: creds => runSync({ service }, creds) }

  ctx.effect(() => registerBuaaCommands(ctx.scheduleCommands, deps), 'buaa-schedule: commands')
  ctx.effect(() => registerBuaaApi(ctx, deps), 'buaa-schedule: api')

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'buaa-schedule',
      order: 1001,
      text: () => [
        '北航教务导入插件已启用：用 `schedule buaa sync` 一次导入整学期课表与考试；先运行 `schedule buaa --help`。',
        '密码仅当次使用、不保存：用 --password-stdin 或 --password-env，不要写进普通命令行参数；学期起点已保存在日程设置里则不必重复给。',
        '导入是整学期快照：课表自带的周次即最终周次，重复导入会替换此前的教学与考试日程，未排课的空缺不会被外推。',
        '本插件生成锁定的课程与考试条目，并保留考试待办；课程用当前 course 类别、考试用 exam，类别已删除时归 other，不恢复已删除类别。锁定仅防快捷拖动，仍可显式编辑或删除。',
        '导入以 CLI 的统计回执为准，不再手工补建同批条目或读取内部文件校验；不要在回复中复述密码。',
      ].join('\n'),
    }), 'buaa-schedule: prompt section')
  }

  ctx.logger.info('buaa-schedule: BUAA source adapter active')
}