/**
 * Durable state of the gacha source adapter.
 *
 * The schedule core only guarantees JSON round-tripping under
 * `sourceState[SOURCE_ID]`; every field below is this plugin's own business
 * fact. The schedule entries themselves never live here — this file only
 * remembers which core entry ids belong to which game track, plus the last
 * parse result so a failed refresh can keep the previous dates.
 */
import { GAME_IDS } from './games.js'

export const SOURCE_ID = 'gacha'

export const GAME_STATUSES = ['idle', 'ok', 'partial', 'error', 'disabled']

const isObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = value => (typeof value === 'string' && value.trim() !== '' ? value : null)

export const emptyGameState = () => ({
  status: 'idle',
  lastRefreshAt: null,
  lastError: null,
  article: null,
  current: null,
  officialPlan: null,
  plan: null,
  override: null,
  entries: { preview: null, update: null },
})

function normalizeArticle(raw) {
  if (!isObject(raw)) return null
  const id = text(raw.id)
  if (id === null) return null
  return {
    id,
    title: typeof raw.title === 'string' ? raw.title : '',
    publishTime: Number.isFinite(Number(raw.publishTime)) ? Number(raw.publishTime) : 0,
    url: text(raw.url) ?? '',
  }
}

function normalizePlan(raw) {
  if (!isObject(raw)) return null
  const iso = key => text(raw[key])
  const confidence = value => (['official', 'video', 'inferred', 'agent'].includes(value) ? value : null)
  return {
    version: text(raw.version),
    updateStart: iso('updateStart'),
    updateEnd: iso('updateEnd'),
    previewStart: iso('previewStart'),
    previewEnd: iso('previewEnd'),
    updateConfidence: confidence(raw.updateConfidence),
    previewConfidence: confidence(raw.previewConfidence),
    updateEvidence: text(raw.updateEvidence),
    previewEvidence: text(raw.previewEvidence),
    generatedAt: iso('generatedAt'),
  }
}

function normalizeOverride(raw) {
  if (!isObject(raw)) return null
  return {
    version: text(raw.version),
    updateStart: text(raw.updateStart),
    updateEnd: text(raw.updateEnd),
    previewStart: text(raw.previewStart),
    previewEnd: text(raw.previewEnd),
    note: text(raw.note),
    appliedAt: text(raw.appliedAt),
  }
}

function normalizeGameState(raw) {
  if (!isObject(raw)) return emptyGameState()
  const entry = key => text(raw.entries?.[key])
  return {
    status: GAME_STATUSES.includes(raw.status) ? raw.status : 'idle',
    lastRefreshAt: text(raw.lastRefreshAt),
    lastError: text(raw.lastError),
    article: normalizeArticle(raw.article),
    current: isObject(raw.current) ? raw.current : null,
    officialPlan: normalizePlan(raw.officialPlan),
    plan: normalizePlan(raw.plan),
    override: normalizeOverride(raw.override),
    entries: { preview: entry('preview'), update: entry('update') },
  }
}

/** Coerce an old / hand-edited sourceState blob into the current shape. */
export function normalizeState(raw) {
  const source = isObject(raw) ? raw : {}
  const enabled = {}
  for (const id of GAME_IDS) enabled[id] = source.enabled?.[id] !== false
  const games = {}
  for (const id of GAME_IDS) games[id] = normalizeGameState(source.games?.[id])
  return {
    version: 1,
    enabled,
    games,
    watch: {
      sessionId: text(source.watch?.sessionId),
      scheduleId: text(source.watch?.scheduleId),
      registeredAt: text(source.watch?.registeredAt),
    },
    lastRefreshAt: text(source.lastRefreshAt),
  }
}
