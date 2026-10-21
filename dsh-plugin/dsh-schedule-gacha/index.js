/**
 * Host half of @lidozs55/dsh-schedule-gacha.
 *
 * The generic schedule core owns the calendar, entries, conflict detection
 * and settings page. This adapter owns only the six official Bilibili
 * accounts, the announcement parsing rules and one preview entry per game.
 * Version updates remain source information. Removing it leaves every existing entry in
 * place; only future refreshes stop.
 */
import { registerGachaApi } from './host/api.js'
import { createGachaService } from './host/service.js'
import { registerGachaTools } from './host/tools.js'

export const inject = ['scheduleCore', 'connection', 'tools']

export async function apply(ctx) {
  const service = createGachaService(ctx, { service: ctx.scheduleCore })

  ctx.effect(() => registerGachaTools(ctx, service), 'gacha-schedule: tools')
  ctx.effect(() => registerGachaApi(ctx, service), 'gacha-schedule: api')
  ctx.effect(() => () => service.dispose(), 'gacha-schedule: dispose')
  await service.reconcileCachedEntries()

  // Background refresh is the primary path: no Agent turn is required, and a
  // profile without the optional schedule bundle still gets correct dates.
  // `ctx.timer` is a Cordis context mixin (not a service).
  const timer = ctx.timer
  if (timer !== undefined && timer !== null) {
    ctx.effect(() => timer.timeout(() => {
      if (service.needsRefresh()) void service.requestRefresh()
    }, 20_000), 'gacha-schedule: first refresh')
    ctx.effect(() => timer.interval(() => {
      if (service.needsRefresh()) void service.requestRefresh()
    }, service.autoRefreshMs), 'gacha-schedule: six-hour refresh')
  } else {
    ctx.logger.warn('gacha-schedule: ctx.timer unavailable — automatic refresh disabled')
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'gacha-schedule',
      order: 1002,
      text: () => [
        '二游前瞻插件已启用：后台每 6 小时从六款游戏的 B 站官方账号刷新版本更新与前瞻直播时间，',
        '仅「版本前瞻直播」同步至日程；「版本更新」只保存为来源信息，不占用日历时间。',
        '用 gacha_schedule 查询（action=list）或立即刷新（action=refresh）；',
        '官方明确给出时间时用 action=apply_official 按游戏写入（带时区 ISO 8601，UTC+8），',
        '推算前瞻时间可编辑；官方明确日期与时间的前瞻仅锁定快捷拖动，其他编辑照常。不要把其他日程改成二游内容。',
        '查询、刷新和官方校正都使用本插件工具，不用 sched_entry 替代刷新或额外创建同一前瞻；显式编辑/删除不受锁定限制，但后续刷新仍会按来源规则对账。',
        'list 只提供状态摘要，不作为官方证据；官方校正须有用户提供的明确官方材料或可用检索工具查证，不把推算当官方时间。',
        '需要每周由 Agent 核对一次（终末地节奏不固定）时，用 action=watch 登记，固定为每周三 10:00（Asia/Shanghai），工具只支持开关；',
        '该能力依赖「自动化任务」bundle，缺失时只保留 6 小时后台刷新。',
      ].join('\n'),
    }), 'gacha-schedule: prompt section')
  }

  ctx.logger.info('gacha-schedule: six-game preview tracker active')
}
