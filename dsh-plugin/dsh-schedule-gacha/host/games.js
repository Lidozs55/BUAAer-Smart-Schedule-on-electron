/**
 * Static knowledge about the six tracked games.
 *
 * Everything here is either an official account id, a title pattern that
 * identifies an official announcement, or a scheduling default used only
 * when the announcements do not state a date. The parser never guesses a
 * game from content; callers always name the game explicitly.
 */

/** @typedef {'genshin'|'hsr'|'zzz'|'wuwa'|'endfield'|'nte'} GameId */

const minutes = value => {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

/**
 * `previewMode` decides how an officially published preview video maps back
 * to the live broadcast:
 * - `previous-friday`: HoYo publishes the replay the next day; the stream is
 *   the most recent Friday 19:30 before publication.
 * - `same-day`: WuWa / NTE / Endfield publish at or just after the stream, so
 *   the publication date is the stream date.
 */
export const GAMES = [
  {
    id: 'genshin',
    name: '原神',
    mid: '401742377',
    versionPattern: /(\d+\.\d+)/,
    updateTitle: /(\d+\.\d+)\s*版本更新说明/,
    excludeTitle: /性能|设备|FAQ|补偿|优化|问题修复/,
    previewSeriesKeyword: '前瞻',
    searchKeyword: '原神 前瞻',
    previewMode: 'previous-friday',
    cycleDays: 42,
    updateStart: '06:00',
    updateEnd: '11:00',
    previewStart: '19:30',
    previewEnd: '21:00',
  },
  {
    id: 'hsr',
    name: '崩坏：星穹铁道',
    mid: '1340190821',
    versionPattern: /(\d+\.\d+)/,
    updateTitle: /(\d+\.\d+)\s*版本[「『].*?[」』]\s*版本更新说明|(\d+\.\d+)\s*版本更新说明/,
    excludeTitle: /补偿|延长|优化|问题修复|FAQ/,
    previewSeriesKeyword: '前瞻',
    searchKeyword: '崩坏星穹铁道 前瞻',
    previewMode: 'previous-friday',
    cycleDays: 42,
    // HSR/ZZZ normally publish an explicit version end date; if the list
    // summary truncated it away, the full column is worth one extra read.
    expectVersionEnd: true,
    updateStart: '06:00',
    updateEnd: '11:00',
    previewStart: '19:30',
    previewEnd: '21:00',
  },
  {
    id: 'zzz',
    name: '绝区零',
    mid: '1636034895',
    versionPattern: /(\d+\.\d+)/,
    updateTitle: /(\d+\.\d+)\s*版本[「『].*?[」』]\s*更新(?:公告|说明)|(\d+\.\d+)\s*版本更新(?:公告|说明)/,
    excludeTitle: /FAQ|性能|设备|优化|问题修复/,
    previewSeriesKeyword: '前瞻',
    searchKeyword: '绝区零 前瞻',
    previewMode: 'previous-friday',
    cycleDays: 42,
    expectVersionEnd: true,
    updateStart: '06:00',
    updateEnd: '11:00',
    previewStart: '19:30',
    previewEnd: '21:00',
  },
  {
    id: 'wuwa',
    name: '鸣潮',
    mid: '1955897084',
    versionPattern: /(\d+\.\d+)/,
    updateTitle: /(\d+\.\d+)\s*版本(?:内容说明|更新维护预告)/,
    excludeTitle: /补偿|优化|问题修复|FAQ/,
    previewSeriesKeyword: '前瞻',
    searchKeyword: '鸣潮 前瞻',
    previewMode: 'same-day',
    cycleDays: 42,
    updateStart: '04:00',
    updateEnd: '11:00',
    previewStart: '19:30',
    previewEnd: '21:00',
  },
  {
    id: 'endfield',
    name: '明日方舟：终末地',
    mid: '1265652806',
    versionPattern: /(\d+\.\d+)/,
    updateTitle: /版本更新说明/,
    excludeTitle: /研发通讯|补偿|优化|问题修复|FAQ|测试/,
    previewSeriesKeyword: '前瞻',
    searchKeyword: '明日方舟 终末地 前瞻',
    previewMode: 'same-day',
    cycleDays: 42,
    updateStart: '06:00',
    updateEnd: '12:00',
    previewStart: '19:30',
    previewEnd: '21:00',
    // Endfield has run 4-, 6- and 7-week versions. A date explicitly marked
    // as a content update between day 21 and day 35 is a stronger signal than
    // the arithmetic cycle.
    phaseHint: true,
  },
  {
    id: 'nte',
    name: '异环',
    mid: '3546636978489848',
    versionPattern: /(\d+\.\d+)/,
    updateTitle: /(\d+\.\d+)\s*版本[「『].*?[」』]\s*更新公告/,
    excludeTitle: /停服维护|补偿|优化|问题修复|FAQ/,
    previewSeriesKeyword: '前瞻',
    searchKeyword: '异环 前瞻',
    previewMode: 'same-day',
    cycleDays: 42,
    updateStart: '06:00',
    updateEnd: '11:00',
    previewStart: '19:30',
    previewEnd: '21:00',
  },
]

export const GAME_IDS = GAMES.map(game => game.id)

/** @type {Map<string, typeof GAMES[number]>} */
const GAME_BY_ID = new Map(GAMES.map(game => [game.id, game]))

export const getGame = id => GAME_BY_ID.get(id)

export const isGameId = id => typeof id === 'string' && GAME_BY_ID.has(id)

export const DEFAULT_UPDATE_WINDOW = game => ({
  startMinutes: minutes(game.updateStart),
  endMinutes: minutes(game.updateEnd),
})

export const DEFAULT_PREVIEW_WINDOW = game => ({
  startMinutes: minutes(game.previewStart),
  endMinutes: minutes(game.previewEnd),
})

/** `7.1` → `7.2`; `null` stays `null` (Endfield has no numeric version). */
export function bumpVersion(version) {
  if (typeof version !== 'string') return null
  const match = /^(\d+)\.(\d+)$/.exec(version.trim())
  if (match === null) return null
  return `${Number(match[1])}.${Number(match[2]) + 1}`
}

/** Marker written into every entry owned by this plugin. */
export const entryMarker = game => `[gacha:${game}]`

/** Second marker distinguishing the preview entry from the update entry. */
export const kindMarker = kind => `[kind:${kind}]`

export const ownsEntry = (entry, game) =>
  (entry?.source === 'gacha' && typeof entry.sourceKey === 'string' && entry.sourceKey.startsWith(game + ':'))
  || (typeof entry?.description === 'string' && entry.description.includes(entryMarker(game)))

export const ownsKind = (entry, game, kind) =>
  ownsEntry(entry, game) && (entry.sourceKey === game + ':' + kind
    || (typeof entry.description === 'string' && entry.description.includes(kindMarker(kind))))
