/**
 * Stable identity of the six tracked games.
 *
 * Everything that changes lives in the gacha-calendar service: official
 * account ids, announcement title patterns, version cadence, update/preview
 * windows and the planning rules. The adapter only needs an id → display-name
 * mapping plus the markers it writes into its own entries, so a rename or a
 * new announcement format never requires a plugin release.
 */

/** @typedef {'genshin'|'hsr'|'zzz'|'wuwa'|'endfield'|'nte'} GameId */

export const GAMES = [
  { id: 'genshin', name: '原神' },
  { id: 'hsr', name: '崩坏：星穹铁道' },
  { id: 'zzz', name: '绝区零' },
  { id: 'wuwa', name: '鸣潮' },
  { id: 'endfield', name: '明日方舟：终末地' },
  { id: 'nte', name: '异环' },
]

export const GAME_IDS = GAMES.map(game => game.id)

/** @type {Map<string, typeof GAMES[number]>} */
const GAME_BY_ID = new Map(GAMES.map(game => [game.id, game]))

export const getGame = id => GAME_BY_ID.get(id)

export const isGameId = id => typeof id === 'string' && GAME_BY_ID.has(id)

/** Marker written into every entry owned by this plugin. */
export const entryMarker = game => `[gacha:${game}]`

/** Second marker distinguishing the preview entry from the legacy update entry. */
export const kindMarker = kind => `[kind:${kind}]`

export const ownsEntry = (entry, game) =>
  (entry?.source === 'gacha' && typeof entry.sourceKey === 'string' && entry.sourceKey.startsWith(game + ':'))
  || (typeof entry?.description === 'string' && entry.description.includes(entryMarker(game)))

export const ownsKind = (entry, game, kind) =>
  ownsEntry(entry, game) && (entry.sourceKey === game + ':' + kind
    || (typeof entry?.description === 'string' && entry.description.includes(kindMarker(kind))))
