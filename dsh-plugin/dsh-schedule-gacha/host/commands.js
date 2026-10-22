/**
 * `schedule gacha` command namespace.
 *
 * The source adapter owns its games, parsing rules and preview entries; the
 * core owns discovery, validation and transport. Command handlers can only
 * address this source's games, never arbitrary schedule entries.
 */
import { GAME_IDS } from './games.js'

export function registerGachaCommands(registry, service) {
  const dispose = registry.register({
    name: 'gacha',
    summary: '二游版本前瞻：查询、刷新、官方校正与周检',
    description: '只读六款游戏的 B 站官方账号，维护版本前瞻直播条目；版本更新只保存为来源信息。只在启用二游前瞻插件时可用。',
    usage: 'schedule gacha <list|refresh|apply-official|watch> [选项]',
    commands: [
      {
        name: 'list',
        summary: '查看六款游戏的状态摘要',
        description: '返回启用状态、版本、更新/前瞻计划、上次刷新时间与错误；摘要不是官方证据。',
        examples: ['schedule gacha list'],
        async run() {
          return service.getPublicState()
        },
      },
      {
        name: 'refresh',
        summary: '立即刷新一个或全部游戏',
        description: '进入后台刷新队列，可能受 B 站限流影响；回执含本次刷新结果。',
        timeoutMs: 180_000,
        options: {
          game: { type: 'string', enum: GAME_IDS, description: '省略刷新全部已启用游戏' },
        },
        examples: ['schedule gacha refresh', 'schedule gacha refresh --game genshin'],
        notes: [
          '刷新失败不会编造日期：保留上次解析结果，并在回执 lastError/error 中说明。',
          '不要用 `schedule entry` 替代刷新或额外创建同一前瞻；来源刷新会按来源规则对账。',
        ],
        async run(input) {
          return {
            startedAt: new Date().toISOString(),
            results: await service.requestRefresh(input.game === undefined ? undefined : [input.game]),
          }
        },
      },
      {
        name: 'apply-official',
        summary: '写入用户提供或已核实的官方时间',
        description: '按游戏写入官方前瞻/更新时间；只修改本插件维护的条目，不触碰其他日程。',
        options: {
          game: { type: 'string', required: true, enum: GAME_IDS, description: '游戏 id' },
          'update-start': { type: 'string', description: '版本更新开始，带时区 ISO 8601' },
          'update-end': { type: 'string', description: '维护结束；省略按该游戏惯例时段计算' },
          'preview-start': { type: 'string', description: '前瞻直播开始，带时区 ISO 8601' },
          'preview-end': { type: 'string', description: '前瞻直播结束；省略按 21:00 计算' },
          version: { type: 'string', description: '版本号，如 4.7' },
          note: { type: 'string', description: '依据摘要，写进日程备注' },
          clear: { type: 'boolean', description: '清除此前的 Agent 覆盖，回到公告规则' },
        },
        examples: [
          'schedule gacha apply-official --game genshin --preview-start 2026-10-30T19:30:00+08:00 --version 4.7 --note "官方动态 10 月 30 日 19:30 前瞻"',
          'schedule gacha apply-official --game genshin --clear',
        ],
        notes: [
          '官方校正必须有用户提供的明确官方材料或可用检索工具查证，不把推算当官方时间。',
          '至少给出 update-start 或 preview-start；清除覆盖用 --clear。',
          '只写本插件维护的日程；其他条目改由 `schedule entry` 操作。',
        ],
        async run(input) {
          if (input.clear === true) return service.clearOverride(input.game)
          return service.applyOfficial({
            game: input.game,
            update_start: input['update-start'],
            update_end: input['update-end'],
            preview_start: input['preview-start'],
            preview_end: input['preview-end'],
            version: input.version,
            note: input.note,
          })
        },
      },
      {
        name: 'watch',
        summary: '开启或关闭每周 Agent 核对',
        description: '登记固定每周三 10:00（Asia/Shanghai）的周检；依赖「自动化任务」bundle，缺失时返回降级原因。',
        options: {
          enabled: {
            type: 'boolean',
            default: true,
            description: '默认开启；传 --no-enabled 取消周检',
          },
        },
        examples: [
          'schedule gacha watch --session <当前会话 id>',
          'schedule gacha watch --no-enabled',
        ],
        notes: [
          '开启时需要当前 DSH 会话 id：用 --session 传入，或设置 DSH_SESSION_ID / SCHEDULE_SESSION_ID；关闭不需要。',
          '登记后由自动化任务在每周三 10:00 唤醒对应会话；后台每 6 小时刷新不受影响。',
        ],
        async run(input, context) {
          return service.setWatch(context.sessionId, { enabled: input.enabled !== false })
        },
      },
    ],
  }, { owner: 'gacha' })

  const disposeGuide = registry.registerGuide({
    name: 'gacha',
    title: '二游前瞻',
    summary: '六款游戏、官方校正、周检与刷新边界',
    body: [
      '命令：`schedule gacha list|refresh|apply-official|watch`（先看 `schedule gacha --help`）。',
      '',
      '范围：',
      '- 只维护原神、崩坏：星穹铁道、绝区零、鸣潮、明日方舟：终末地、异环的「版本前瞻直播」条目。',
      '- 版本更新只保存为来源信息，不占用日历时间；不要为版本更新另建条目。',
      '- 后台每 6 小时刷新；设置卡开关会移除该游戏由本插件写入的条目。',
      '',
      '查询与刷新：',
      '- `list` 是状态摘要，不是官方证据；需要核实官方时间时使用可用检索工具查看各游戏 B 站官方账号。',
      '- `refresh --game <id>` 立即刷新；刷新失败保留上次结果并报告错误，不推断无变化。',
      '- 不要用 `schedule entry` 替代刷新，也不要额外创建同一前瞻。',
      '',
      '官方校正：',
      '- `apply-official` 按游戏写入带时区 ISO 8601 的时间；只改本插件条目。',
      '- 官方明确日期与时间的前瞻锁定快捷拖动；其他编辑/删除不受锁定限制，但后续刷新仍会按来源规则对账。',
      '- `--clear` 清除 Agent 覆盖，回到公告规则。',
      '',
      '周检：',
      '- `watch --session <id>` 登记每周三 10:00（Asia/Shanghai）的 Agent 核对；`watch --no-enabled` 取消（无需会话 id）。',
      '- 依赖「自动化任务」bundle；缺失时只保留 6 小时后台刷新。',
      '- 无法检索或材料不足时明确说明未核实，不推断无变化。',
    ].join('\n'),
  })

  return () => {
    dispose()
    disposeGuide()
  }
}
