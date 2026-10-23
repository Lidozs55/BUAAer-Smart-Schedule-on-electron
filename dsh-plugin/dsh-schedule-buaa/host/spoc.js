/**
 * SPOC (智学北航) client.
 *
 * SPOC is not another timetable endpoint: it is a separate application behind
 * the same CAS. This module reuses the call-scoped SSO session from `jw.js`,
 * exchanges the CAS ticket for an SPOC token, and reads the current term's
 * assignment feed.
 *
 * The session lives in this module's memory only. Nothing here is persisted:
 * the password and the SPOC bearer token both die with the host process. That
 * is deliberate — the schedule core's credential contract forbids passwords on
 * disk, and a token that is never written cannot leak from a backup or a
 * synced home directory.
 */
import { createCipheriv } from 'node:crypto'
import { BuaaError, request, ssoLoginAt } from './jw.js'

const SPOC_BASE = 'https://spoc.buaa.edu.cn'
const CAS_ENTRY = `${SPOC_BASE}/spocnewht/cas`
const CAS_LOGIN = `${SPOC_BASE}/spocnewht/sys/casLogin`
const CURRENT_TERM_URL = `${SPOC_BASE}/spocnewht/inco/ht/queryOne`
const COURSES_URL = `${SPOC_BASE}/spocnewht/jxkj/queryKclb`
const ASSIGNMENTS_URL = `${SPOC_BASE}/spocnewht/inco/ht/queryListByPage`

/**
 * Constants copied from the SPOC web client. They are not secrets: the AES
 * key and IV are shipped inside the page bundle, and the two identifiers are
 * the school's fixed query ids. They can change with a SPOC release, which is
 * why a failed decode is reported as `data`, not as an auth failure.
 */
const CRYPTO_KEY = Buffer.from('inco12345678ocni', 'utf8')
const CRYPTO_IV = Buffer.from('ocni12345678inco', 'utf8')
const CURRENT_TERM_PARAM =
  'YHrxtTavu6raCwC0/qdgYffB9evWHBkTng/XS4W6j3f/TPo02iEPSoegscDTRNzIPRG49o3RHl4JiFCXAiBkkA=='
const ASSIGNMENTS_PAGE_SQL_ID = '1713252980496efac7d5d9985e81693116d3e8a52ebf2b'
const PAGE_SIZE = 15
const MAX_PAGES = 100

/** @type {{ token: string, roleCode: string, jar: object, username: string, termCode: string, termName: string|null, lastUsedAt: number }|null} */
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

/** Safe public facts for the settings card; never the token itself. */
export function sessionSnapshot() {
  if (session === null) return null
  return {
    username: session.username,
    termCode: session.termCode,
    termName: session.termName,
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
  }
}

/**
 * AES-128-CBC with zero padding, as the SPOC front end does. Node's default
 * PKCS#7 padding is disabled explicitly; the school decrypts the trailing
 * zero bytes itself.
 * @param {string} plainText - JSON string to encrypt.
 * @returns {string} Base64 ciphertext.
 */
export function encryptParam(plainText) {
  const input = Buffer.from(plainText, 'utf8')
  const paddedLength = input.length === 0 ? 0 : Math.ceil(input.length / 16) * 16
  const padded = Buffer.alloc(paddedLength)
  input.copy(padded)
  const cipher = createCipheriv('aes-128-cbc', CRYPTO_KEY, CRYPTO_IV)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}

/**
 * The CAS callback puts the SPOC token in the query string of a URL whose
 * path contains `/spocnew/cas`. The entry path `/spocnewht/cas` is
 * deliberately not matched.
 * @param {string} url - absolute URL.
 * @returns {{ token: string, refreshToken: string|null }|null}
 */
export function extractLoginTokens(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!parsed.pathname.includes('/spocnew/cas')) return null
  const token = parsed.searchParams.get('token')
  if (token === null || token.trim() === '') return null
  const refreshToken = parsed.searchParams.get('refreshToken')
  return { token, refreshToken: refreshToken === null || refreshToken === '' ? null : refreshToken }
}

/** Normalize SPOC's local/offset date strings to the core's ISO grammar. */
export function normalizeDateTime(rawValue) {
  const value = String(rawValue ?? '').trim()
  if (value === '') return null

  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (match !== null) {
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}+08:00`
    const parsed = new Date(iso)
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T23:59:59+08:00`)
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString()
  }
  return null
}

/** `tjzt` is either the school's flag or a human-readable status. */
export function mapSubmissionStatus(rawStatus) {
  const value = String(rawStatus ?? '').trim()
  if (['1', '已做', '已提交', 'submitted'].includes(value)) return 'submitted'
  if (['0', '未做', '未提交', 'unsubmitted'].includes(value)) return 'unsubmitted'
  return value === '' ? 'unsubmitted' : 'unknown'
}

export const submissionStatusText = status =>
  status === 'submitted' ? '已提交' : status === 'unknown' ? '未知状态' : '未提交'

/** Scores arrive as `95`, `95.0` or `95 分`; keep the number when present. */
export function normalizeScore(rawScore) {
  const value = String(rawScore ?? '').trim()
  if (value === '') return null
  const match = value.match(/-?\d+(?:\.\d+)?/)
  return match === null ? value : match[0]
}

function firstNonEmpty(value) {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstNonEmpty(item)
      if (found !== null) return found
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    for (const key of ['rolecode', 'roleCode', 'jsdm', 'code', 'value']) {
      if (key in value) {
        const found = firstNonEmpty(value[key])
        if (found !== null) return found
      }
    }
  }
  return null
}

export function resolveRoleCode(content) {
  return firstNonEmpty(content?.jsdm)
    ?? firstNonEmpty(content?.rolecode)
    ?? firstNonEmpty(content?.jsdmList)
}

function looksLikeLoginPage(text) {
  return text.includes('name="execution"')
    || text.includes('统一身份认证')
    || /^<!doctype html/i.test(text.trimStart())
}

function looksLikeAuthenticationFailure(message, bodyText) {
  const text = `${message} ${bodyText}`
  return ['登录', 'token', '未认证', '未登录', '权限'].some(word =>
    text.toLowerCase().includes(word.toLowerCase()))
}

async function readEnvelope(response, operation) {
  if (response.status === 302 || response.status === 401) {
    throw new BuaaError('auth', `SPOC ${operation} 需要重新登录`)
  }
  if (response.status !== 200) {
    throw new BuaaError('network', `SPOC ${operation} 返回 HTTP ${response.status}`)
  }

  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    if (looksLikeLoginPage(text)) {
      throw new BuaaError('auth', `SPOC ${operation} 登录状态失效`)
    }
    throw new BuaaError('data', `SPOC ${operation} 响应不是合法 JSON`)
  }

  if (Number(payload?.code) === 200) return payload.content
  const message = payload?.msg ?? payload?.msg_en ?? `SPOC ${operation} 失败`
  if (looksLikeAuthenticationFailure(message, text)) {
    throw new BuaaError('auth', `SPOC ${operation} 登录状态失效`)
  }
  throw new BuaaError('data', `SPOC ${operation} 失败`)
}

async function tryLoginTokens(jar) {
  let currentUrl = CAS_ENTRY
  for (let hop = 0; hop < 8; hop += 1) {
    const fromUrl = extractLoginTokens(currentUrl)
    if (fromUrl !== null) return fromUrl

    const response = await request(jar, currentUrl)
    const location = response.headers.get('location')
    if (location === null) return null

    const nextUrl = new URL(location, currentUrl).toString()
    const fromLocation = extractLoginTokens(nextUrl)
    if (fromLocation !== null) return fromLocation
    currentUrl = nextUrl
  }
  throw new BuaaError('auth', 'SPOC 登录重定向次数过多')
}

async function casLogin(jar, tokens) {
  const response = await request(jar, CAS_LOGIN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Token: `Inco-${tokens.token}`,
    },
    body: JSON.stringify({ token: tokens.token }),
  })
  const content = await readEnvelope(response, 'casLogin')
  if (content === null || typeof content !== 'object') {
    throw new BuaaError('data', 'SPOC 登录成功但未返回角色信息')
  }
  const roleCode = resolveRoleCode(content)
  if (roleCode === null) {
    throw new BuaaError('data', 'SPOC 登录成功但未取得 roleCode')
  }
  return {
    token: tokens.token,
    refreshToken: tokens.refreshToken,
    roleCode,
    jar,
    username: '',
    termCode: '',
    termName: null,
    lastUsedAt: Date.now(),
  }
}

async function login({ jar, username, password }) {
  let tokens = jar === undefined ? null : await tryLoginTokens(jar)
  let activeJar = jar

  if (tokens === null) {
    // The JW session may not be accepted by SPOC's CAS client (or the host
    // just restarted). Ask CAS for a fresh service ticket with the same
    // call-scoped password; nothing is retained after this call.
    activeJar = await ssoLoginAt(CAS_ENTRY, username, password, undefined, { requireTgc: false })
    tokens = await tryLoginTokens(activeJar)
    if (tokens === null) {
      throw new BuaaError('auth', 'SPOC 登录失败：未取得 CAS token')
    }
  }

  const result = await casLogin(activeJar, tokens)
  result.username = username
  return result
}

async function ensureSession({ jar, username, password, force = false }) {
  const name = typeof username === 'string' ? username.trim() : ''
  if (name === '') throw new BuaaError('invalid_input', '缺少学号，无法登录 SPOC')
  if (loginPromise !== null) {
    if (loginUsername !== name) throw new BuaaError('busy', 'SPOC 正在登录另一账号，请稍后重试')
    return loginPromise
  }
  if (session !== null && session.username !== name) clearSession()
  if (!force && session !== null) return session
  if (typeof password !== 'string' || password === '') {
    throw new BuaaError('auth', 'SPOC 会话不存在，请先手动同步一次')
  }

  const epoch = sessionEpoch
  loginUsername = name
  loginPromise = login({ jar, username: name, password })
    .then(next => {
      if (epoch !== sessionEpoch) throw new BuaaError('cancelled', 'SPOC 会话已清除，请重新同步')
      session = next
      return next
    })
    .catch(error => {
      if (error instanceof BuaaError) throw error
      throw new BuaaError('network', 'SPOC 登录失败，请稍后重试')
    })
    .finally(() => {
      loginPromise = null
      loginUsername = ''
    })
  return loginPromise
}

async function spocCall(active, operation, url, options = {}) {
  try {
    const response = await request(active.jar, url, {
      ...options,
      headers: {
        ...options.headers,
        'X-Requested-With': 'XMLHttpRequest',
        Token: `Inco-${active.token}`,
        RoleCode: active.roleCode,
      },
    })
    active.lastUsedAt = Date.now()
    return await readEnvelope(response, operation)
  } catch (error) {
    if (error instanceof BuaaError) throw error
    throw new BuaaError('network', `SPOC ${operation} 请求失败，请稍后重试`)
  }
}

async function getCurrentTerm(active) {
  const content = await spocCall(active, 'queryOne', CURRENT_TERM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param: CURRENT_TERM_PARAM }),
  })
  const term = Array.isArray(content) ? content[0] : content
  if (term === null || typeof term !== 'object' || typeof term.mrxq !== 'string' || term.mrxq === '') {
    throw new BuaaError('data', 'SPOC 未返回当前学期代码')
  }
  return { termCode: term.mrxq, termName: typeof term.dqxq === 'string' ? term.dqxq : null }
}

async function getCourses(active, termCode) {
  const content = await spocCall(
    active,
    'queryKclb',
    `${COURSES_URL}?kcmc=&xnxq=${encodeURIComponent(termCode)}`,
  )
  return Array.isArray(content) ? content : []
}

async function getAssignmentsPage(active, termCode, pageNum) {
  const plainText = JSON.stringify({
    pageSize: PAGE_SIZE,
    pageNum,
    sqlid: ASSIGNMENTS_PAGE_SQL_ID,
    xnxq: termCode,
    kcid: '',
    yzwz: '',
  })
  return spocCall(active, 'queryListByPage', ASSIGNMENTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param: encryptParam(plainText) }),
  })
}

async function getAllAssignments(active, termCode) {
  const rows = []
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    const page = await getAssignmentsPage(active, termCode, pageNum)
    if (!Array.isArray(page?.list)) {
      throw new BuaaError('data', 'SPOC 作业分页缺少有效列表，保留已有待办')
    }
    const pages = Number(page.pages)
    const hasPageCount = page.pages !== undefined && Number.isInteger(pages) && pages >= 0
    const hasNext = typeof page.hasNextPage === 'boolean'
      ? page.hasNextPage
      : hasPageCount ? pageNum < pages : null
    if (hasNext === null || (hasPageCount && hasNext !== (pageNum < pages))
      || (hasNext && page.list.length === 0)) {
      throw new BuaaError('data', 'SPOC 作业分页信息不完整，保留已有待办')
    }
    rows.push(...page.list)
    if (!hasNext) return rows
  }
  throw new BuaaError('data', 'SPOC 作业超过分页上限，保留已有待办')
}

/**
 * Map raw assignment rows to the source's task drafts. Submitted assignments
 * are counted but intentionally not returned: the todo list is for work that
 * still needs attention, and a submitted item would only create reminder
 * noise. Rows without a readable deadline are also skipped, because a task
 * with no `due` cannot be reminded or sorted.
 * @param {object[]} rows - raw paged assignment rows.
 * @param {Map<string, object>} [courseMap] - `kcid` → course metadata.
 * @returns {{ assignments: object[], submitted: number, skipped: number }}
 */
export function parseAssignments(rows, courseMap = new Map()) {
  const assignments = []
  let submitted = 0
  let skipped = 0

  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') {
      skipped += 1
      continue
    }
    const status = mapSubmissionStatus(raw.tjzt)
    if (status === 'submitted') {
      submitted += 1
      continue
    }
    const due = normalizeDateTime(raw.zyjzsj)
    if (due === null) {
      skipped += 1
      continue
    }
    const course = raw.sskcid === undefined ? undefined : courseMap.get(raw.sskcid)
    const courseName = String(raw.kcmc ?? course?.kcmc ?? '').trim() || '未知课程'
    const title = String(raw.zymc ?? '').trim() || '未命名作业'
    assignments.push({
      assignmentId: String(raw.zyid ?? ''),
      courseId: String(raw.sskcid ?? ''),
      courseName,
      teacherName: typeof course?.skjs === 'string' && course.skjs.trim() !== ''
        ? course.skjs.trim()
        : null,
      title,
      start: normalizeDateTime(raw.zykssj),
      due,
      score: normalizeScore(raw.mf),
      status,
      statusText: submissionStatusText(status),
    })
  }

  assignments.sort((left, right) => left.due.localeCompare(right.due)
    || left.courseName.localeCompare(right.courseName)
    || left.title.localeCompare(right.title))
  return { assignments, submitted, skipped }
}

async function loadAssignments(active) {
  const term = await getCurrentTerm(active)
  active.termCode = term.termCode
  active.termName = term.termName

  let courses = []
  try {
    courses = await getCourses(active, term.termCode)
  } catch (error) {
    // Course metadata only enriches teacher names; assignments still parse
    // without it, so a metadata failure must not hide the deadline feed.
    if (error.code === 'auth') throw error
  }
  const courseMap = new Map(courses
    .filter(course => typeof course?.kcid === 'string')
    .map(course => [course.kcid, course]))
  const rows = await getAllAssignments(active, term.termCode)
  const parsed = parseAssignments(rows, courseMap)
  return { termCode: term.termCode, termName: term.termName, ...parsed }
}

/**
 * Manual sync: log in with the call-scoped password (reusing the JW jar when
 * possible), then read every assignment page. On an expired token it retries
 * once with a fresh CAS login because the password is still available here.
 * @param {{ jar?: object, username: string, password: string }} credentials
 */
export async function fetchAssignments({ jar, username, password } = {}) {
  let active = await ensureSession({ jar, username, password })
  try {
    const feed = await loadAssignments(active)
    if (session !== active) throw new BuaaError('cancelled', 'SPOC 会话已变更，请重新同步')
    return feed
  } catch (error) {
    if (session !== active || error.code !== 'auth' || typeof password !== 'string' || password === '') throw error
    clearSession()
    active = await ensureSession({ username, password, force: true })
    const feed = await loadAssignments(active)
    if (session !== active) throw new BuaaError('cancelled', 'SPOC 会话已变更，请重新同步')
    return feed
  }
}

/**
 * Polling path: use the in-memory session only. There is no password here, so
 * an expired token ends the polling loop and the card asks for one manual
 * sync instead of silently retrying credentials.
 */
export async function refreshAssignments() {
  const active = session
  if (active === null) {
    throw new BuaaError('auth', 'SPOC 会话不存在，请先手动同步一次')
  }
  try {
    const feed = await loadAssignments(active)
    if (session !== active) throw new BuaaError('cancelled', 'SPOC 会话已变更，请重新同步')
    return feed
  } catch (error) {
    if (session === active && error.code === 'auth') clearSession()
    throw error
  }
}
