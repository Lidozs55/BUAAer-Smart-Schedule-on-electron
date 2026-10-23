/**
 * iclass (课堂签到) client.
 *
 * iclass is a third application behind the same SSO as JW and SPOC. The
 * remote check-in button lives on a BUAA teaching entry, long after the
 * manual sync has returned: by then the password and the call-scoped cookie
 * jar are gone. The manual sync therefore resolves iclass's `loginName` while
 * it still owns the SSO jar and exchanges it for an iclass
 * `userId`/`sessionId` pair. That session lives in this module's memory only
 * — no password, cookie or token is written to the store, an API payload or a
 * CLI receipt. A host restart requires one manual sync, exactly like SPOC.
 *
 * Protocol source: UBAA's `SigninClient.kt` / `LocalSigninApi.kt`. The
 * endpoints are the school's, not ours; a failed decode is reported as a
 * data/auth error instead of being guessed around.
 */
import { BuaaError, request, ssoLoginAt } from './jw.js'

const MY_CENTER = 'https://iclass.buaa.edu.cn:8346/?type=jumpMyCenter'
const APP_LOGIN = 'https://iclass.buaa.edu.cn:8347/app/user/login.action'
const CLASSES = 'https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action'
const TIMESTAMP = 'http://iclass.buaa.edu.cn:8081/app/common/get_timestamp.action'
const SIGN = 'http://iclass.buaa.edu.cn:8081/eschool/app/course/stu_scan_sign.action'
const REDIRECT_LIMIT = 8
const REQUEST_TIMEOUT_MS = 12_000

/** A no-cookie jar for the iclass app calls: only `sessionId` matters there. */
const emptyJar = { header: () => '', store() {} }
const abort = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS)

/** @type {{ userId: string, sessionId: string, username: string, lastUsedAt: number }|null} */
let session = null
let loginPromise = null
let loginUsername = ''
// Bumped by clearSession() so an in-flight login cannot resurrect a session
// that the user just disabled (or that failed and was cleared).
let sessionEpoch = 0

export const hasSession = () => session !== null

export function clearSession() {
  sessionEpoch += 1
  session = null
}

/** Safe public facts for the settings card; never the iclass session id. */
export function sessionSnapshot() {
  if (session === null) return null
  return {
    username: session.username,
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
  }
}

/**
 * Pull `loginName` out of the jump URL's query string. Query parsing is done
 * by hand instead of `URLSearchParams` so a base64-ish value keeps a literal
 * `+` (form decoding would turn it into a space).
 * @param {string} url
 * @returns {string|null}
 */
export function extractLoginName(url) {
  const text = String(url ?? '')
  const question = text.indexOf('?')
  if (question < 0) return null
  const query = text.slice(question + 1).split('#')[0]
  for (const part of query.split('&')) {
    const equals = part.indexOf('=')
    const key = equals < 0 ? part : part.slice(0, equals)
    if (key.toLowerCase() !== 'loginname') continue
    const raw = equals < 0 ? '' : part.slice(equals + 1)
    if (raw === '') continue
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

/** Resolve a Location header against the URL that produced it. */
export function resolveRedirectUrl(currentUrl, location) {
  const target = String(location ?? '').trim()
  if (target === '') return null
  try {
    return new URL(target, currentUrl).toString()
  } catch {
    return null
  }
}

/** JSON primitives arrive as strings, numbers or booleans depending on the endpoint. */
export function jsonString(value, key) {
  if (value === null || typeof value !== 'object') return null
  const raw = value[key]
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return null
}

/** iclass accepts 0, 200 or the literal `success` as its success status. */
export function isStatusSuccess(payload) {
  const status = jsonString(payload, 'STATUS')
  return status === '0' || status === '200' || status?.toLowerCase() === 'success'
}

/** Map iclass's class rows to the small shape the schedule needs. */
export function parseSigninClasses(payload) {
  const rows = Array.isArray(payload?.result) ? payload.result : []
  return rows.map(raw => ({
    courseId: jsonString(raw, 'id') ?? '',
    courseName: jsonString(raw, 'courseName') ?? '',
    classBeginTime: jsonString(raw, 'classBeginTime') ?? '',
    classEndTime: jsonString(raw, 'classEndTime') ?? '',
    signStatus: Number.parseInt(jsonString(raw, 'signStatus') ?? '0', 10) || 0,
  }))
}

export const normalizeCourseName = value => String(value ?? '').replace(/\s+/g, '').trim()

/**
 * iclass has returned both `HH:mm` and `yyyy-MM-dd HH:mm:ss`; take the wall
 * clock either way. A bare time keeps its leading zero so `8:00` still matches
 * `08:00`.
 */
const hhmm = value => {
  const match = /(\d{1,2}):(\d{2})/.exec(String(value ?? ''))
  return match === null ? '' : `${match[1].padStart(2, '0')}:${match[2]}`
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})
const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function formatParts(format, date) {
  const parts = {}
  for (const part of format.formatToParts(date)) parts[part.type] = part.value
  return parts
}

/**
 * China-local wall clock of an instant. The host process may run anywhere, so
 * calendar entries (which BUAA authors in +08:00) must not be compared using
 * the machine's local timezone.
 * @param {Date|string|number} value
 * @returns {{ date: string, time: string }}
 */
export function chinaClock(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return { date: '', time: '' }
  const day = formatParts(dateFormat, date)
  const clock = formatParts(timeFormat, date)
  return {
    date: `${day.year}-${day.month}-${day.day}`,
    time: `${clock.hour}:${clock.minute}`,
  }
}

/** `yyyyMMdd`, the shape iclass's `dateStr` query expects. */
export function signinDateString(value = new Date()) {
  return chinaClock(value).date.replaceAll('-', '')
}

/**
 * Match a BUAA teaching entry to today's iclass row. Course names are
 * whitespace-insensitive; begin/end are the primary identity. If the school
 * rounded one end differently, a unique course name + begin match still wins.
 * @param {object[]} classes
 * @param {object} entry
 * @returns {object|null}
 */
export function matchClassForEntry(classes, entry) {
  if (!Array.isArray(classes) || entry === null || typeof entry !== 'object') return null
  const name = normalizeCourseName(entry.title)
  const begin = chinaClock(entry.start).time
  const end = chinaClock(entry.end).time
  if (name === '' || begin === '') return null

  const sameName = classes.filter(row => normalizeCourseName(row.courseName) === name)
  const exact = sameName.find(row =>
    hhmm(row.classBeginTime) === begin && hhmm(row.classEndTime) === end)
  if (exact !== undefined) return exact

  const byBegin = sameName.filter(row => hhmm(row.classBeginTime) === begin)
  return byBegin.length === 1 ? byBegin[0] : null
}

/** Same wording as UBAA: never echo an upstream message that may contain HTML. */
export function sanitizeSigninMessage(success, rawMessage) {
  if (success) return '签到成功'
  const message = String(rawMessage ?? '')
  if (message.includes('已签到')) return '您今天已经签到过了'
  if (message.includes('未开始')) return '当前还未到签到时间'
  if (message.includes('不是上课时间')) return '当前不是上课时间，无法签到'
  if (message.includes('已结束')) return '本次签到已结束'
  if (message.includes('范围')) return '当前不在可签到范围内'
  if (message.includes('用户不存在')) return '签到账号不存在，请联系管理员'
  if (message.includes('课程') && message.includes('不存在')) return '未找到对应课程，请刷新后重试'
  return '签到失败，请稍后重试'
}

const looksLikeAuthFailure = message =>
  ['登录', 'session', 'token', '未认证', '未登录'].some(word =>
    String(message ?? '').toLowerCase().includes(word.toLowerCase()))

async function readJson(response, operation) {
  if (response.status === 302 || response.status === 401) {
    throw new BuaaError('auth', `${operation}需要重新登录 iclass`)
  }
  if (response.status !== 200) {
    throw new BuaaError('network', `${operation}返回 HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new BuaaError('data', `${operation}响应不是合法 JSON`)
  }
}

/**
 * Follow the MyCenter jump until the URL carries `loginName`. With an
 * authenticated SSO jar this is the CAS ticket round-trip; without one it
 * stops at the login page and returns null, which lets the caller retry with a
 * fresh call-scoped password.
 * @param {{ jar?: object }} [options]
 * @returns {Promise<string|null>}
 */
export async function resolveLoginName({ jar = emptyJar } = {}) {
  let currentUrl = MY_CENTER
  for (let hop = 0; hop < REDIRECT_LIMIT; hop += 1) {
    const known = extractLoginName(currentUrl)
    if (known !== null) return known

    const response = await request(jar, currentUrl, { signal: abort() })
    const location = response.headers.get('location')
    if (location !== null) {
      const nextUrl = resolveRedirectUrl(currentUrl, location)
      const found = nextUrl === null ? null : extractLoginName(nextUrl)
      if (found !== null) return found
    }
    if (response.status < 300 || response.status >= 400 || location === null) return null

    const next = resolveRedirectUrl(currentUrl, location)
    if (next === null) return null
    currentUrl = next
  }
  throw new BuaaError('auth', 'iclass 登录重定向次数过多')
}

async function appLogin(jar, loginName) {
  const url = new URL(APP_LOGIN)
  url.searchParams.set('password', '')
  url.searchParams.set('phone', loginName)
  url.searchParams.set('userLevel', '1')
  url.searchParams.set('verificationType', '2')
  url.searchParams.set('verificationUrl', '')

  const payload = await readJson(
    await request(jar, url.toString(), { signal: abort() }),
    'iclass 登录',
  )
  if (!isStatusSuccess(payload)) {
    throw new BuaaError('auth', 'iclass 登录失败')
  }
  const userId = jsonString(payload.result, 'id')
  const sessionId = jsonString(payload.result, 'sessionId')
  if (userId === null || userId === '' || sessionId === null || sessionId === '') {
    throw new BuaaError('data', 'iclass 登录成功但未返回会话')
  }
  return { userId, sessionId, username: '', lastUsedAt: Date.now() }
}

async function login({ jar, username, password }) {
  let activeJar = jar
  let loginName = await resolveLoginName({ jar: activeJar })

  if (loginName === null) {
    if (typeof password !== 'string' || password === '') {
      throw new BuaaError('auth', 'iclass 会话不存在，请先手动同步一次')
    }
    // The JW jar may not have an iclass service session. Ask CAS for one with
    // the same call-scoped password; nothing is retained after this call.
    activeJar = await ssoLoginAt(MY_CENTER, username, password, undefined, { requireTgc: false })
    loginName = await resolveLoginName({ jar: activeJar })
    if (loginName === null) throw new BuaaError('auth', 'iclass 登录失败：未取得 loginName')
  }

  const next = await appLogin(activeJar, loginName)
  next.username = username
  return next
}

/**
 * Manual-sync path: establish the in-memory iclass session. Reuses the JW jar
 * and falls back to one extra CAS login with the same call-scoped password.
 * @param {{ jar?: object, username: string, password: string }} credentials
 */
export async function acquireSession({ jar, username, password } = {}) {
  const name = typeof username === 'string' ? username.trim() : ''
  if (name === '') throw new BuaaError('invalid_input', '缺少学号，无法登录 iclass')
  if (loginPromise !== null) {
    if (loginUsername !== name) throw new BuaaError('busy', 'iclass 正在登录另一账号，请稍后重试')
    return loginPromise
  }
  // Manual sync must repair expired sessions even before the next check-in.
  if (session !== null) clearSession()
  if (typeof password !== 'string' || password === '') {
    throw new BuaaError('auth', 'iclass 会话不存在，请先手动同步一次')
  }

  const epoch = sessionEpoch
  loginUsername = name
  loginPromise = login({ jar, username: name, password })
    .then(next => {
      if (epoch !== sessionEpoch) throw new BuaaError('cancelled', 'iclass 会话已清除，请重新同步')
      session = next
      return next
    })
    .catch(error => {
      if (error instanceof BuaaError) throw error
      throw new BuaaError('network', 'iclass 登录失败，请稍后重试')
    })
    .finally(() => {
      loginPromise = null
      loginUsername = ''
    })
  return loginPromise
}

/**
 * Read one day's iclass course rows. This is the polling/read path: it uses
 * only the in-memory session and never credentials.
 * @param {{ now?: Date|string|number }} [options]
 */
export async function fetchTodayClasses({ now = new Date() } = {}) {
  const active = session
  if (active === null) throw new BuaaError('auth', 'iclass 会话不存在，请先手动同步一次')

  const url = new URL(CLASSES)
  url.searchParams.set('id', active.userId)
  url.searchParams.set('dateStr', signinDateString(now))

  let response
  try {
    response = await request(emptyJar, url.toString(), {
      headers: { sessionId: active.sessionId },
      signal: abort(),
    })
  } catch {
    throw new BuaaError('network', 'iclass 课表读取失败，请稍后重试')
  }
  if (response.status === 302 || response.status === 401) {
    if (session === active) clearSession()
    throw new BuaaError('auth', 'iclass 登录状态失效，请先手动同步一次')
  }
  if (response.status !== 200) {
    throw new BuaaError('network', `iclass 课表读取失败（HTTP ${response.status}）`)
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    throw new BuaaError('data', 'iclass 课表响应不是合法 JSON')
  }
  if (payload !== null && typeof payload === 'object' && 'STATUS' in payload
    && !isStatusSuccess(payload)) {
    const message = jsonString(payload, 'ERRMSG') || 'iclass 课表读取失败'
    if (looksLikeAuthFailure(message)) {
      if (session === active) clearSession()
      throw new BuaaError('auth', 'iclass 登录状态失效，请先手动同步一次')
    }
    throw new BuaaError('data', 'iclass 课表读取失败')
  }

  if (session !== active) throw new BuaaError('cancelled', 'iclass 会话已变更，请重试')
  active.lastUsedAt = Date.now()
  return parseSigninClasses(payload)
}

/**
 * Submit one check-in. Returns `{ success, message, status }` for a business
 * rejection (already signed, not in the window, …) and throws only when no
 * usable answer was received.
 * @param {string} courseSchedId - iclass's row `id`, not the JW course code.
 */
export async function performSignin(courseSchedId, active = session) {
  if (active === null) throw new BuaaError('auth', 'iclass 会话不存在，请先手动同步一次')
  if (session !== active) throw new BuaaError('cancelled', 'iclass 会话已变更，请重试')
  if (typeof courseSchedId !== 'string' || courseSchedId.trim() === '') {
    throw new BuaaError('invalid_input', '缺少 iclass 课程 id')
  }

  let timestamp
  try {
    const payload = await readJson(
      await request(emptyJar, TIMESTAMP, { signal: abort() }),
      '获取服务器时间',
    )
    timestamp = jsonString(payload, 'timestamp')
  } catch (error) {
    if (error instanceof BuaaError) {
      if (error.code === 'data') throw new BuaaError('data', '获取服务器时间失败')
      throw error
    }
    throw new BuaaError('network', '获取服务器时间失败，请稍后重试')
  }
  if (timestamp === null || timestamp === '') {
    throw new BuaaError('data', '获取服务器时间失败')
  }

  if (session !== active) throw new BuaaError('cancelled', 'iclass 会话已变更，请重试')
  const url = new URL(SIGN)
  url.searchParams.set('courseSchedId', courseSchedId.trim())
  url.searchParams.set('timestamp', timestamp)

  let response
  try {
    response = await request(emptyJar, url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        sessionId: active.sessionId,
      },
      body: new URLSearchParams({ id: active.userId }).toString(),
      signal: abort(),
    })
  } catch {
    throw new BuaaError('network', '签到请求失败，请稍后重试')
  }
  if (response.status === 302 || response.status === 401) {
    if (session === active) clearSession()
    throw new BuaaError('auth', 'iclass 登录状态失效，请先手动同步一次')
  }
  if (response.status !== 200) {
    throw new BuaaError('network', `签到请求返回 HTTP ${response.status}`)
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    throw new BuaaError('data', '签到响应不是合法 JSON')
  }
  if (session !== active) throw new BuaaError('cancelled', 'iclass 会话已变更，请重试')
  const success = isStatusSuccess(payload) && jsonString(payload.result, 'stuSignStatus') === '1'
  const rawMessage = jsonString(payload, 'ERRMSG')
  if (!success && looksLikeAuthFailure(rawMessage)) {
    clearSession()
    return { success: false, message: '签到会话已失效，请先手动同步一次', status: 0 }
  }

  active.lastUsedAt = Date.now()
  return {
    success,
    message: sanitizeSigninMessage(success, rawMessage),
    status: success ? 1 : 0,
  }
}

/**
 * End-to-end entry action: today's gate → today's iclass rows → matching row →
 * check-in. The host API passes a stored entry, never a client-supplied course
 * id, so the button cannot be used to sign an arbitrary row.
 * @param {object} entry - a stored schedule entry.
 * @param {{ now?: Date|string|number }} [options]
 */
export async function signinEntry(entry, { now = new Date() } = {}) {
  if (entry === null || typeof entry !== 'object') {
    throw new BuaaError('invalid_input', '缺少课程条目')
  }
  const today = chinaClock(now).date
  const day = chinaClock(entry.start).date
  if (today === '' || day === '' || day !== today) {
    throw new BuaaError('invalid_input', '只能签到今天的课程')
  }

  const active = session
  const classes = await fetchTodayClasses({ now })
  if (session !== active) throw new BuaaError('cancelled', 'iclass 会话已变更，请重试')
  const matched = matchClassForEntry(classes, entry)
  if (matched === null) {
    throw new BuaaError('not_found', '今天的 iclass 课表中没有找到这节课（可能尚未同步或已调课）')
  }
  if (matched.signStatus === 1) {
    return {
      success: true,
      message: '您今天已经签到过了',
      status: 1,
      courseId: matched.courseId,
      courseName: matched.courseName,
    }
  }

  const result = await performSignin(matched.courseId, active)
  return {
    ...result,
    courseId: matched.courseId,
    courseName: matched.courseName,
  }
}
