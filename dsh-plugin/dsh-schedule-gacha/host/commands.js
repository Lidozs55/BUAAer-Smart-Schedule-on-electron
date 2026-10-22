/**
 * `schedule gacha` command namespace.
 *
 * The source adapter owns its games, source markers and preview entries; the
 * core owns discovery, validation and transport. Command handlers can only
 * address this source's games, never arbitrary schedule entries.
 */
import { GAME_IDS } from './games.js'

export function registerGachaCommands(registry, service) {
  const dispose = registry.register({
    name: 'gacha',
    summary: '二游版本前瞻：查询、刷新、原文核对、官方校正与周检',
    description: '读取 gacha-calendar 服务格式化的六款游戏版本信息，维护版本前瞻直播条目；版本更新只保存为来源信息。只在启用二游前瞻插件时可用。',
    usage: 'schedule gacha <list|refresh|posts|apply-official|watch> [选项]',
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
        description: '重新读取 gacha-calendar 服务格式化后的最新结果（服务的 B 站采集另有后台周期）；回执含本次刷新结果。',
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
        name: 'posts',
        summary: '分页读取服务保存的原始公告与动态',
        description: '读取 gacha-calendar 服务保存的 B 站公告、动态与视频元数据（标题、UTC 发布时间、原文入口），用于核对官方时间；只读，不写入日程。',
        timeoutMs: 60_000,
        options: {
          game: { type: 'string', enum: GAME_IDS, description: '省略读取全部游戏' },
          page: { type: 'integer', default: 1, description: '页码，从 1 开始' },
          'page-size': { type: 'integer', default: 20, description: '每页条数，1–100' },
          type: { type: 'string', description: '原始类型过滤，如 article/dynamic/video' },
        },
        examples: [
          'schedule gacha posts --game genshin --page-size 5',
          'schedule gacha posts --game endfield --type article --page 2',
        ],
        notes: [
          '返回服务原始分页结构；标题与链接用于核对，发布时间的 utc 字段为 UTC。',
          '只把清晰可核对的官方内容当作证据；材料不足时说明未核实，不推断无变化。',
        ],
        async run(input) {
          if (!Number.isInteger(input.page) || input.page < 1) {
            throw Object.assign(new Error('page 必须是正整数'), { code: 'invalid_input' })
          }
          if (!Number.isInteger(input['page-size']) || input['page-size'] < 1 || input['page-size'] > 100) {
            throw Object.assign(new Error('page-size 必须是 1–100 的整数'), { code: 'invalid_input' })
          }
          return service.calendarApi.posts({
            gameId: input.game,
            page: input.page,
            pageSize: input['page-size'],
            type: input.type,
          })
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
      '命令：`schedule gacha list|refresh|posts|apply-official|watch`（先看 `schedule gacha --help`）。',
      '',
      '范围：',
      '- 只维护原神、崩坏：星穹铁道、绝区零、鸣潮、明日方舟：终末地、异环的「版本前瞻直播」条目。',
      '- 版本更新只保存为来源信息，不占用日历时间；不要为版本更新另建条目。',
      '- gacha-calendar 服务后台每 6 小时采集；本插件每 6 小时读取格式化结果，设置卡开关会移除该游戏由本插件写入的条目。',
      '',
      '查询、原文与刷新：',
      '- `list` 是状态摘要，不是官方证据；需要核实官方时间时，先用 `posts` 读服务保存的公告/动态原文，再用可用检索工具与官方账号相互印证。',
      '- `posts --game <id> --page <n> --page-size <n> [--type article]` 分页读取原始材料；只把清晰可核对的官方内容当作证据。',
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
