/**
 * Pure parsing and scheduling rules.
 *
 * No network, no storage, no clock reads: every function takes the text /
 * timestamp it needs, so the six official announcement formats can be unit
 * tested offline. All dates are handled as UTC+8 wall time and emitted as
 * ISO strings with an explicit `+08:00` offset — never with the host zone.
 */
import { DEFAULT_PREVIEW_WINDOW, DEFAULT_UPDATE_WINDOW, bumpVersion } from './games.js'

const pad = value => String(value).padStart(2, '0')
const DAY_MS = 86_400_000
const CST_OFFSET_MS = 8 * 3_600_000

/** Construct a validated UTC+8 ISO string. Returns null for impossible dates. */
export function cstIso(year, month, day, hour = 0, minute = 0) {
  const parts = [year, month, day, hour, minute]
  if (!parts.every(Number.isInteger)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day || probe.getUTCHours() !== hour
    || probe.getUTCMinutes() !== minute) return null
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`
}

/** CST calendar fields of any ISO instant. */
export function cstParts(iso) {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  const shifted = new Date(ms + CST_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  }
}

export function normalizeCstIso(iso) {
  if (typeof iso !== 'string' || iso === '') return null
  const parts = cstParts(iso)
  if (parts === null) return null
  return cstIso(parts.year, parts.month, parts.day, parts.hour, parts.minute)
}

export function addDays(iso, days) {
  const p = cstParts(iso)
  if (p === null) return null
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days, p.hour, p.minute))
  return cstIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes())
}

export function atMinutes(iso, minutes) {
  const p = cstParts(iso)
  if (p === null) return null
  return cstIso(p.year, p.month, p.day, Math.floor(minutes / 60), minutes % 60)
}

export function dayDiff(fromIso, toIso) {
  const a = new Date(fromIso).getTime()
  const b = new Date(toIso).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / DAY_MS)
}

export const isFuture = (iso, now = new Date()) =>
  new Date(iso).getTime() > now.getTime()

const referenceParts = publishTime => {
  if (publishTime === undefined || publishTime === null || publishTime === '') return null
  if (typeof publishTime === 'number' && Number.isFinite(publishTime)) {
    return cstParts(new Date(publishTime * 1000).toISOString())
  }
  return cstParts(String(publishTime))
}

/**
 * Resolve a possibly year-less announcement date against the post date.
 * A date more than half a year behind the post belongs to the next year.
 */
function resolveYear(month, explicitYear, ref) {
  if (explicitYear !== undefined && explicitYear !== null) return Number(explicitYear)
  if (ref === null) return null
  const delta = month - ref.month
  if (delta < -6) return ref.year + 1
  if (delta > 6) return ref.year - 1
  return ref.year
}

const DATE_TIME_SOURCE =
  /(?:(\d{4})\s*[年\/.]\s*)?(\d{1,2})\s*[月\/.]\s*(\d{1,2})\s*日?(?:\s*[（(][^）)]*[）)])?\s*(?:晚上|晚间)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g

/** Every dated instant in a text, in source order. */
export function dateTimes(text, publishTime) {
  const ref = referenceParts(publishTime)
  const out = []
  if (typeof text !== 'string') return out
  DATE_TIME_SOURCE.lastIndex = 0
  for (const match of text.matchAll(DATE_TIME_SOURCE)) {
    const month = Number(match[2])
    const day = Number(match[3])
    const year = resolveYear(month, match[1], ref)
    const iso = year === null ? null : cstIso(year, month, day, Number(match[4]), Number(match[5]))
    if (iso === null) continue
    out.push({ iso, index: match.index ?? 0, text: match[0] })
  }
  return out
}

const context = (text, index, length, radius = 60) =>
  text.slice(Math.max(0, index - radius), Math.min(text.length, index + length + radius))

/** First dated instant whose surrounding text matches `near`. */
function firstNear(text, publishTime, near, { limit = Infinity } = {}) {
  for (const item of dateTimes(text, publishTime)) {
    if (item.index > limit) break
    if (near.test(context(text, item.index, item.text.length))) return item
  }
  return null
}

/** `2026/09/23 06:00` etc. following a label. */
function labelledDate(text, label, publishTime) {
  const pattern = new RegExp(
    `${label}[^\\d\\n]{0,24}?(?:(\\d{4})\\s*[年\\/.]\\s*)?`
    + '(\\d{1,2})\\s*[月\\/.]\\s*(\\d{1,2})\\s*日?\\s*'
    + '(?:(?:晚上|晚间)\\s*)?(\\d{1,2})\\s*[:：]\\s*(\\d{2})',
  )
  const match = pattern.exec(text)
  if (match === null) return null
  const ref = referenceParts(publishTime)
  const month = Number(match[2])
  const year = resolveYear(month, match[1], ref)
  if (year === null) return null
  return cstIso(year, month, Number(match[3]), Number(match[4]), Number(match[5]))
}

/** Version label such as `4.6` plus its quoted name. */
export function extractVersion(title, body = '') {
  const sources = [title, body.slice(0, 800)]
  let version = null
  for (const source of sources) {
    const match = /(\d+\.\d+)\s*版本/.exec(source)
    if (match !== null) {
      version = match[1]
      break
    }
  }
  const quoted = /[「『]([^」』]{1,40})[」』]/.exec(title)
    ?? /版本[「『]([^」』]{1,40})[」』]/.exec(title)
  const versionName = quoted !== null
    && !/版本|更新|公告|说明|预告|通讯/.test(quoted[1])
    ? quoted[1].trim()
    : null
  return { version, versionName }
}

/** Official maintenance start. The label is far more reliable than "first date". */
export function extractUpdateStart(text, publishTime, game) {
  if (typeof text !== 'string') return null
  const labelled = labelledDate(text, '(?:更新开始时间|更新时间)', publishTime)
  if (labelled !== null) return labelled

  const maintenance = labelledDate(text,
    '(?:更新维护时间|停服维护时间|维护时间)', publishTime)
  if (maintenance !== null) return maintenance

  // NTE writes the date without a year before the range.
  const nte = /更新维护时间[^\d\n]{0,24}(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2})\s*[:：]\s*(\d{2})/
    .exec(text)
  if (nte !== null) {
    const ref = referenceParts(publishTime)
    const year = resolveYear(Number(nte[1]), null, ref)
    if (year !== null) return cstIso(year, Number(nte[1]), Number(nte[2]), Number(nte[3]), Number(nte[4]))
  }

  // "将于9月24日06:00 – 11:00进行版本更新维护"
  const range = dateTimes(text, publishTime).find(item => {
    const around = context(text, item.index, item.text.length, 70)
    return /(?:进行)?(?:版本)?更新维护|版本更新/.test(around)
      && /(?:~|～|-|–|—|至)\s*\d{1,2}\s*[:：]\s*\d{2}/.test(around)
  })
  if (range !== undefined) return range.iso

  // Last resort: the first update-related date in the opening section.
  const opened = firstNear(text, publishTime, /更新|维护/, { limit: 1_800 })
  return opened?.iso ?? null
}

/** Maintenance window end; falls back to the game's usual opening hour. */
export function extractUpdateEnd(text, updateStart, game) {
  if (updateStart === null) return null
  // The announcement may use `2026/09/30`, `2026年9月30日` or `9月30日`.
  // Find the maintenance start by its CST calendar day, not by one spelling.
  const p = cstParts(updateStart)
  let position = -1
  if (typeof text === 'string' && p !== null) {
    const escaped = [
      `${p.year}/${pad(p.month)}/${pad(p.day)}`,
      `${p.year}年${p.month}月${p.day}日`,
      `${p.month}月${p.day}日`,
    ].find(spelling => text.includes(spelling))
    if (escaped !== undefined) position = text.indexOf(escaped)
  }
  const probe = position >= 0 ? text.slice(position, position + 180) : text
  const hours = /预计\s*(\d+)\s*个?小时(?:内)?完成/.exec(probe ?? '')
  if (hours !== null) {
    return addHours(updateStart, Number(hours[1]))
  }
  const window = /(?:~|～|-|–|—|至)\s*(\d{1,2})\s*[:：]\s*(\d{2})/.exec(probe ?? '')
  if (window !== null) {
    let end = atMinutes(updateStart, Number(window[1]) * 60 + Number(window[2]))
    if (new Date(end).getTime() <= new Date(updateStart).getTime()) end = addDays(end, 1)
    return end
  }
  const fallback = DEFAULT_UPDATE_WINDOW(game)
  let end = atMinutes(updateStart, fallback.endMinutes)
  if (new Date(end).getTime() <= new Date(updateStart).getTime()) end = addDays(end, 1)
  return end
}

function addHours(iso, hours) {
  const p = cstParts(iso)
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour + hours, p.minute))
  return cstIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes())
}

/** Explicit "version ends at" fact, when the game publishes one. */
export function extractVersionEnd(text) {
  if (typeof text !== 'string') return null
  const patterns = [
    /版本结束时间为?\s*(\d{4})\s*[年\/.]\s*(\d{1,2})\s*[月\/.]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：]\s*(\d{2})/,
    /版本(?:的)?持续时间[^。\n]{0,80}?[-–—~～至]\s*(\d{4})\s*[年\/.]\s*(\d{1,2})\s*[月\/.]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：]\s*(\d{2})/,
    /版本(?:将)?(?:于|在)\s*(\d{4})\s*[年\/.]\s*(\d{1,2})\s*[月\/.]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*结束/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match === null) continue
    const iso = cstIso(Number(match[1]), Number(match[2]), Number(match[3]),
      Number(match[4]), Number(match[5]))
    if (iso !== null) return iso
  }
  return null
}

/** Explicit preview date/time from a teaser, article or dynamic. */
export function extractExplicitPreviewAt(text, publishTime) {
  if (typeof text !== 'string') return null
  const explicit = dateTimes(text, publishTime).find(item => {
    const around = context(text, item.index, item.text.length, 80)
    return /前瞻|直播|播出/.test(around)
  })
  return explicit?.iso ?? null
}

export function extractPreviewAt(text, publishTime, game) {
  if (typeof text !== 'string') return null
  const explicit = extractExplicitPreviewAt(text, publishTime)
  if (explicit !== null) return explicit

  // Date-only teasers ("前瞻定档10月30日") use the usual 19:30 slot.
  const dateOnly = /(?:前瞻|直播)[^。\n]{0,40}?(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text)
  if (dateOnly !== null) {
    const ref = referenceParts(publishTime)
    const year = resolveYear(Number(dateOnly[1]), null, ref)
    if (year === null) return null
    const window = DEFAULT_PREVIEW_WINDOW(game)
    return cstIso(year, Number(dateOnly[1]), Number(dateOnly[2]),
      Math.floor(window.startMinutes / 60), window.startMinutes % 60)
  }
  return null
}

/** A date marked as a content/version update between day 21 and 35. */
export function extractPhaseUpdate(text, updateStart, game) {
  if (game.phaseHint !== true || updateStart === null || typeof text !== 'string') return null
  for (const item of dateTimes(text, null)) {
    const around = context(text, item.index, item.text.length, 50)
    if (!/更新|版本/.test(around)) continue
    if (/活动时间|寻访|申领|开放时间|补偿|领取/.test(around)) continue
    const offset = dayDiff(updateStart, item.iso)
    if (offset === null || offset < 21 || offset > 35) continue
    // Use the usual maintenance hour, not the content-update hour in the text.
    const p = cstParts(item.iso)
    const window = DEFAULT_UPDATE_WINDOW(game)
    const candidate = cstIso(p.year, p.month, p.day,
      Math.floor(window.startMinutes / 60), window.startMinutes % 60)
    const candidateOffset = dayDiff(updateStart, candidate)
    if (candidateOffset === null || candidateOffset < 21 || candidateOffset > 35) continue
    return candidate
  }
  return null
}

/** A "next version goes live on ..." sentence in a dynamic or teaser. */
export function extractNextUpdateAnnouncement(text, publishTime, game) {
  if (typeof text !== 'string') return null
  const versionMatch = /(\d+\.\d+)\s*版本/.exec(text)
  const candidates = dateTimes(text, publishTime).filter(item => {
    const around = context(text, item.index, item.text.length, 70)
    return /(?:上线|更新|开启|维护)/.test(around)
  })
  if (candidates.length > 0) {
    return { version: versionMatch?.[1] ?? null, iso: candidates[0].iso }
  }

  // Date-only announcements ("将于11月11日更新") use the usual opening hour.
  const dateOnly = /(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。\n]{0,30}?(?:上线|更新|开启|维护)/.exec(text)
    ?? /(?:上线|更新|开启|维护)[^。\n]{0,20}?(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text)
  if (dateOnly === null) return null
  const ref = referenceParts(publishTime)
  const year = resolveYear(Number(dateOnly[1]), null, ref)
  if (year === null) return null
  const window = DEFAULT_UPDATE_WINDOW(game)
  return {
    version: versionMatch?.[1] ?? null,
    iso: cstIso(year, Number(dateOnly[1]), Number(dateOnly[2]),
      Math.floor(window.startMinutes / 60), window.startMinutes % 60),
  }
}

/** The Friday in [update-14d, update-8d] at the game's preview hour. */
export function previewByRule(updateStart, game) {
  if (updateStart === null) return null
  const window = DEFAULT_PREVIEW_WINDOW(game)
  for (let offset = -14; offset <= -8; offset += 1) {
    const day = addDays(updateStart, offset)
    if (cstParts(day)?.weekday === 5) return atMinutes(day, window.startMinutes)
  }
  return null
}

/**
 * A real preview program, not a character/scene teaser that also says
 * "前瞻". Official channels upload both, and a teaser has no relation to the
 * live stream.
 */
export function isPreviewTitle(title) {
  return typeof title === 'string'
    && /前瞻|直播/.test(title)
    && !/场景前瞻|角色前瞻|前瞻短片|前瞻PV|预告片|实录|[Pp][Vv]/.test(title)
}

/**
 * Map an official preview video publication to the live stream.
 * A teaser often states the stream time in its title ("将于10月6日19:30播出");
 * that wins. Otherwise HoYo uploads the replay after the stream, so the
 * stream is the previous Friday. WuWa / NTE / Endfield upload around the
 * stream itself.
 */
export function previewFromVideo(video, game, updateStart) {
  if (video === undefined || video === null) return null
  const seconds = Number(video.pubdate)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const explicit = extractPreviewAt(String(video.title ?? ''), seconds, game)
  if (explicit !== null
    && (updateStart === null || new Date(explicit).getTime() < new Date(updateStart).getTime())) {
    return explicit
  }
  const published = new Date(seconds * 1000).toISOString()
  const p = cstParts(published)
  if (p === null) return null
  const window = DEFAULT_PREVIEW_WINDOW(game)
  let day = published
  if (game.previewMode === 'previous-friday') {
    const back = (p.weekday - 5 + 7) % 7
    day = addDays(published, -back)
  }
  let preview = atMinutes(day, window.startMinutes)
  if (updateStart !== null && new Date(preview).getTime() >= new Date(updateStart).getTime()) {
    preview = addDays(preview, -7)
  }
  return preview
}

/** Move a date to the requested weekday, at most ±3 days away. */
export function alignToWeekday(iso, weekday) {
  const p = cstParts(iso)
  if (p === null) return null
  let delta = (weekday - p.weekday + 7) % 7
  if (delta > 3) delta -= 7
  return addDays(iso, delta)
}

const defaultUpdateEnd = (updateStart, game) => {
  const window = DEFAULT_UPDATE_WINDOW(game)
  let end = atMinutes(updateStart, window.endMinutes)
  if (new Date(end).getTime() <= new Date(updateStart).getTime()) end = addDays(end, 1)
  return end
}

/**
 * Complete parse of one official version article.
 * @returns {{
 *   version: string|null, versionName: string|null,
 *   updateStart: string|null, updateEnd: string|null,
 *   versionEnd: string|null, previewAt: string|null,
 *   phaseUpdate: string|null,
 * }}
 */
export function parseArticle({ title, content, publishTime, game }) {
  const text = `${title ?? ''}\n${content ?? ''}`
  const { version, versionName } = extractVersion(title ?? '', content ?? '')
  const updateStart = extractUpdateStart(content || text, publishTime, game)
  const updateEnd = updateStart === null ? null : extractUpdateEnd(content || text, updateStart, game)
  const rawEnd = extractVersionEnd(content || text)
  // A "version duration" must span at least two weeks; anything shorter is
  // an event/banner window that happens to use the same dash notation.
  const versionEnd = rawEnd !== null && updateStart !== null
    && new Date(rawEnd).getTime() > new Date(updateStart).getTime()
    && dayDiff(updateStart, rawEnd) >= 14
    ? rawEnd
    : null
  const previewAt = extractPreviewAt(text, publishTime, game)
  const phaseUpdate = updateStart === null ? null : extractPhaseUpdate(content || text, updateStart, game)
  return { version, versionName, updateStart, updateEnd, versionEnd, previewAt, phaseUpdate }
}

/** Parse a short official text (dynamic, teaser title) for dates. */
export function parseAnnouncement({ text, publishTime, game }) {
  return {
    version: extractVersion('', text ?? '')?.version ?? null,
    update: extractNextUpdateAnnouncement(text ?? '', publishTime, game),
    previewAt: extractPreviewAt(text ?? '', publishTime, game),
  }
}

const videoVersion = (video, game) => {
  const match = /(\d+\.\d+)\s*版本/.exec(video.title ?? '')
  if (match !== null) return match[1]
  const loose = game.versionPattern.exec(video.title ?? '')
  return loose?.[1] ?? null
}

/**
 * Decide the next version's update and preview times.
 *
 * @param {object} input
 * @param {object} input.game - static game record.
 * @param {object} input.current - parsed current version.
 * @param {string} [input.now] - ISO clock (tests inject it).
 * @param {Array} [input.videos] - official uploads ({ title, pubdate, bvid }).
 * @param {Array} [input.announcements] - parsed texts ({ text, pubdate, url }).
 */
export function planNext({ game, current, now = new Date().toISOString(), videos = [], announcements = [] }) {
  const nowMs = new Date(now).getTime()
  let version = current.version ?? null
  let baseStart = current.updateStart ?? null
  let candidate = null

  const nextVersionOf = value => bumpVersion(value)

  // 1. Official end of the current version is the strongest next-update fact.
  if (current.versionEnd !== null && current.versionEnd !== undefined) {
    candidate = {
      version: nextVersionOf(version),
      updateStart: current.versionEnd,
      confidence: 'official',
      evidence: '版本结束时间',
    }
  }

  // 2. A content-update date in an irregular cadence (Endfield).
  if (candidate === null && current.phaseUpdate) {
    candidate = {
      version: nextVersionOf(version),
      updateStart: current.phaseUpdate,
      confidence: 'inferred',
      evidence: '公告中的版本内容更新时间',
    }
  }

  // 3. Explicit "next version goes live" announcement.
  if (candidate === null) {
    const announced = announcements
      .map(item => ({ item, parsed: parseAnnouncement({ text: item.text, publishTime: item.pubdate, game }) }))
      .filter(({ parsed }) => parsed.update !== null && parsed.update.iso !== null)
      // An old dynamic about the version that is already live must not be
      // mistaken for the next one.
      .filter(({ parsed }) => baseStart === null
        || new Date(parsed.update.iso).getTime() > new Date(baseStart).getTime())
      .find(() => true)
    if (announced !== undefined) {
      candidate = {
        version: announced.parsed.update.version ?? nextVersionOf(version),
        updateStart: announced.parsed.update.iso,
        confidence: 'official',
        evidence: '官方更新公告',
      }
    }
  }

  // 4. Arithmetic cadence, aligned to the current version's weekday.
  if (candidate === null && baseStart !== null) {
    const weekday = cstParts(baseStart)?.weekday ?? 3
    const raw = addDays(baseStart, game.cycleDays)
    candidate = {
      version: nextVersionOf(version),
      updateStart: alignToWeekday(raw, weekday),
      confidence: 'inferred',
      evidence: `${game.cycleDays} 天版本节奏`,
    }
  }

  if (candidate === null || candidate.updateStart === null) return null

  // 5. A version whose maintenance already ended is history: roll forward.
  let guard = 0
  while (guard < 16) {
    const end = defaultUpdateEnd(candidate.updateStart, game)
    if (new Date(candidate.updateStart).getTime() > nowMs
      || nowMs <= new Date(end).getTime()) break
    baseStart = candidate.updateStart
    version = candidate.version
    const weekday = cstParts(baseStart)?.weekday ?? 3
    candidate = {
      version: nextVersionOf(version),
      updateStart: alignToWeekday(addDays(baseStart, game.cycleDays), weekday),
      confidence: 'inferred',
      evidence: `${game.cycleDays} 天版本节奏`,
    }
    guard += 1
  }

  const updateStart = candidate.updateStart
  const updateEnd = defaultUpdateEnd(updateStart, game)

  // 6. Preview: explicit announcement > official preview video > Friday rule.
  let previewStart = null
  let previewConfidence = null
  let previewEvidence = null

  const announcedPreview = announcements.find(item => {
    const parsed = parseAnnouncement({ text: item.text, publishTime: item.pubdate, game })
    if (parsed.previewAt === null) return false
    const versionMatch = /(\d+\.\d+)\s*版本/.exec(item.text ?? '')
    return versionMatch === null || candidate.version === null
      || versionMatch[1] === candidate.version
  })
  if (announcedPreview !== undefined) {
    const parsed = parseAnnouncement({
      text: announcedPreview.text, publishTime: announcedPreview.pubdate, game,
    })
    previewStart = parsed.previewAt
    const explicit = extractExplicitPreviewAt(announcedPreview.text, announcedPreview.pubdate)
    previewConfidence = explicit === previewStart ? 'official' : 'inferred'
    previewEvidence = explicit === previewStart ? '官方前瞻公告（明确日期与时间）' : '官方前瞻日期，时刻按惯例推算'
  }

  if (previewStart === null && videos.length > 0) {
    const matching = videos
      .filter(video => isPreviewTitle(video.title))
      .filter(video => {
        const v = videoVersion(video, game)
        if (candidate.version !== null && v !== null) return v === candidate.version
        return true
      })
      .sort((a, b) => Number(b.pubdate) - Number(a.pubdate))
    if (matching.length > 0) {
      previewStart = previewFromVideo(matching[0], game, updateStart)
      const explicit = extractExplicitPreviewAt(matching[0].title, matching[0].pubdate)
      previewConfidence = previewStart === null ? null : explicit === previewStart ? 'official' : 'inferred'
      previewEvidence = previewStart === null ? null
        : `${explicit === previewStart ? '官方视频标题明确时间' : '官方视频发布日期回推（非确认时间）'} ${matching[0].bvid ?? ''}`.trim()
    }
  }

  if (previewStart === null) {
    previewStart = previewByRule(updateStart, game)
    previewConfidence = previewStart === null ? null : 'inferred'
    previewEvidence = previewStart === null ? null : '更新时间前两周的周五 19:30'
  }

  if (previewStart !== null && new Date(previewStart).getTime() >= new Date(updateStart).getTime()) {
    previewStart = previewByRule(updateStart, game)
    previewConfidence = 'inferred'
    previewEvidence = '更新时间前两周的周五 19:30'
  }

  const previewEnd = previewStart === null
    ? null
    : atMinutes(previewStart, DEFAULT_PREVIEW_WINDOW(game).endMinutes)

  return {
    version: candidate.version,
    updateStart,
    updateEnd,
    previewStart,
    previewEnd,
    updateConfidence: candidate.confidence,
    previewConfidence,
    updateEvidence: candidate.evidence,
    previewEvidence,
  }
}

export { defaultUpdateEnd }
