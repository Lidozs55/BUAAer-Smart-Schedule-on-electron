/**
 * BUAA SSO login and JW API access over the host's fetch, with a manual
 * cookie jar (the port of the legacy `requests.Session` flow). Passwords
 * are call-scoped inputs only — they never reach Config, credentials, or
 * the storage domain. SSO jars live in process memory and expire after
 * 30 idle minutes, mirroring the legacy session manager.
 */

const SSO_LOGIN_URL = 'https://sso.buaa.edu.cn/login'
const API_BASE = 'https://byxt.buaa.edu.cn/jwapp/sys'
const DETAIL_PATH = '/homeapp/api/home/teachingSchedule/detail.do'
const EXAMS_PATH = '/homeapp/api/home/student/exams.do'

/** Headers the school side expects; these are its requirements, not ours. */
export const schoolHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://byxt.buaa.edu.cn/jwapp/sys/homeapp/home/index.html',
  'X-Requested-With': 'XMLHttpRequest',
  'sec-ch-ua': '"Chromium";v="142", "Microsoft Edge";v="142", "Not_A Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
}

export class BuaaError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Minimal cookie jar over `Set-Cookie` collection. */
export class CookieJar {
  constructor() {
    this.cookies = new Map()
  }

  store(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  has(name) {
    return this.cookies.has(name)
  }
}

async function request(jar, url, options = {}) {
  const headers = { ...schoolHeaders, ...options.headers }
  const cookie = jar.header()
  if (cookie !== '') headers.Cookie = cookie
  const response = await fetch(url, {
    ...options,
    headers,
    redirect: 'manual',
    signal: options.signal ?? AbortSignal.timeout(15_000),
  })
  jar.store(response)
  return response
}

function extractExecution(html) {
  const patterns = [
    /<input\s+[^>]*?name=["']execution["'][^>]*?value=["'](.*?)["']/is,
    /<input\s+[^>]*?value=["'](.*?)["'][^>]*?name=["']execution["']/is,
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) return match[1]
  }
  throw new BuaaError('auth', '无法从登录页提取 execution 参数（页面结构可能已变化）')
}

/**
 * Perform the full SSO dance: trigger the JW redirect, read the login
 * page, post credentials, follow the callback chain, verify the SSO TGC.
 * @returns {CookieJar} the authenticated jar.
 */
export async function ssoLogin(username, password, signal) {
  const jar = new CookieJar()
  const probeUrl = `${API_BASE}${DETAIL_PATH}?rq=2026-01-01&lxdm=student`

  const probe = await request(jar, probeUrl, { signal })
  if (probe.status !== 302) {
    throw new BuaaError('auth', `教务入口未按预期重定向（HTTP ${probe.status}）`)
  }
  const ssoUrl = probe.headers.get('location')
  if (!ssoUrl || !ssoUrl.startsWith('http')) {
    throw new BuaaError('auth', '教务入口重定向缺少 SSO 地址')
  }

  const loginPage = await request(jar, ssoUrl, { signal })
  if (loginPage.status !== 200) {
    throw new BuaaError('network', `获取登录页失败（HTTP ${loginPage.status}）`)
  }
  const execution = extractExecution(await loginPage.text())

  const login = await request(jar, ssoUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username,
      password,
      execution,
      _eventId: 'submit',
      geolocation: '',
    }).toString(),
    signal,
  })
  if (login.status !== 200 && login.status !== 302) {
    throw new BuaaError('auth', `登录提交失败（HTTP ${login.status}，学号或密码可能错误）`)
  }

  // Follow the callback chain so the JW server session cookie lands.
  let hop = login
  for (let i = 0; i < 5 && hop.status === 302; i += 1) {
    const next = hop.headers.get('location')
    if (!next) break
    hop = await request(jar, new URL(next, ssoUrl).toString(), { signal })
  }

  if (!jar.has('CASTGC') && !jar.has('_WEU')) {
    throw new BuaaError('auth', '登录失败：未获得核心认证 Cookie（请核对学号与密码）')
  }
  return jar
}

/** GET a JW API endpoint and normalize `{datas, code}` envelopes. */
export async function apiGet(jar, url, signal) {
  let response = await request(jar, url, { signal })
  if (response.status === 302) {
    // One retry: the 302's Set-Cookie may have bound the server session.
    response = await request(jar, url, { signal })
  }
  if (response.status === 302) {
    throw new BuaaError('need_login', 'SSO 会话已过期，需要重新登录')
  }
  if (response.status !== 200) {
    throw new BuaaError('network', `HTTP ${response.status}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new BuaaError('data', 'API 响应不是合法 JSON')
  }
  if (payload === null || typeof payload !== 'object' || !('code' in payload)) {
    throw new BuaaError('data', 'API 返回格式无法识别')
  }
  if (payload.code !== '0') {
    throw new BuaaError('data', `教务 API 报错：${payload.msg ?? '未知错误'}`)
  }
  return Array.isArray(payload.datas) ? payload.datas : []
}

export function detailUrl(date) {
  return `${API_BASE}${DETAIL_PATH}?rq=${date}&lxdm=student`
}

export function examsUrl(termCode) {
  return `${API_BASE}${EXAMS_PATH}?termCode=${encodeURIComponent(termCode)}`
}

/**
 * In-memory SSO jar cache with the school's 30-minute idle expiry.
 * Keyed by student id; one active login per student is enough here.
 */
export class SsoSessionCache {
  constructor(idleMs = 30 * 60_000) {
    this.idleMs = idleMs
    this.entries = new Map()
  }

  get(buaaId) {
    const entry = this.entries.get(buaaId)
    if (entry === undefined) return undefined
    if (Date.now() - entry.lastUsed > this.idleMs) {
      this.entries.delete(buaaId)
      return undefined
    }
    entry.lastUsed = Date.now()
    return entry.jar
  }

  set(buaaId, jar) {
    this.entries.set(buaaId, { jar, lastUsed: Date.now() })
  }

  clear() {
    this.entries.clear()
  }
}
