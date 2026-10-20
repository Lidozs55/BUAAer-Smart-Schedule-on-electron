/**
 * BUAA SSO login and JW API access over the host's fetch.
 *
 * Credentials are call-scoped: the password is used for this login only and
 * is never stored. There is deliberately no session cache and no cookie jar
 * persistence — a timetable is a once-per-term fact, so asking for the
 * password again next term is cheaper (and safer) than keeping a login
 * alive that nothing else needs.
 */

const API_BASE = 'https://byxt.buaa.edu.cn/jwapp/sys'
const HOME_PATH = '/homeapp/home/index.html?contextPath=/jwapp'
const SCHEDULE_PATH = '/homeapp/api/home/student/getMyScheduleDetail.do'
const EXAMS_PATH = '/homeapp/api/home/student/exams.do'

/** The JW app page the browser sends as `referrer`; the login URL comes from the 302. */
const APP_REFERRER = `${API_BASE}${HOME_PATH}`

/**
 * What we probe to learn the SSO login URL. It MUST be a protected API, not
 * `HOME_PATH`: the home page is a static SPA shell that is served to
 * everyone with HTTP 200, so probing it can never observe the redirect.
 * Anonymous access to any `api.home.*` endpoint answers 302 to the SSO, which
 * is the signal the login flow needs (verified 2026-10-20).
 */
const LOGIN_PROBE_URL = `${API_BASE}${SCHEDULE_PATH}`

/**
 * Headers the school side expects (its requirements, not ours). No
 * `X-Requested-With`: with it the JW API answers an anonymous XHR with 401
 * instead of redirecting to the SSO with 302, and the login flow keys on that
 * 302. `fetch-api` is what the JW front end sets on every one of its own
 * XHRs; omitting it makes some endpoints answer as if the caller were a
 * browser navigation.
 */
const schoolHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'fetch-api': 'true',
}

export class BuaaError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Minimal cookie jar over `Set-Cookie` collection. */
class CookieJar {
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
    signal: options.signal ?? AbortSignal.timeout(20_000),
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
 * Perform the full SSO dance: trigger the JW redirect, read the login page,
 * post credentials, follow the callback chain, verify the SSO TGC.
 * @returns {CookieJar} the authenticated jar for this call only.
 */
export async function ssoLogin(username, password, signal) {
  const jar = new CookieJar()

  const probe = await request(jar, LOGIN_PROBE_URL, { signal })
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

/**
 * Call one JW endpoint and unwrap its `{ datas, code, msg }` envelope.
 * A 302/401 body means the login did not (or no longer) apply.
 */
async function jwtCall(jar, url, options, signal) {
  let response = await request(jar, url, { ...options, signal })
  if (response.status === 302) {
    // One retry: the 302's Set-Cookie may have bound the server session.
    response = await request(jar, url, { ...options, signal })
  }
  if (response.status === 302 || response.status === 401) {
    throw new BuaaError('auth', '教务登录失效，请重新输入密码同步')
  }
  if (response.status !== 200) {
    throw new BuaaError('network', `教务接口返回 HTTP ${response.status}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new BuaaError('data', '教务接口响应不是合法 JSON')
  }
  if (payload === null || typeof payload !== 'object' || !('code' in payload)) {
    throw new BuaaError('data', '教务接口返回格式无法识别')
  }
  if (payload.code !== '0') {
    throw new BuaaError('data', `教务接口报错：${payload.msg ?? '未知错误'}`)
  }
  return payload
}

/**
 * Fetch the WHOLE term timetable in one request. Unlike the day-by-day
 * `detail.do` feed, every cell carries its own week information.
 * `referrer` is a fetch init option, not a header: the Fetch spec lists it
 * among the forbidden header names, so setting it in `headers` is silently
 * dropped.
 * @param {string} termCode - e.g. `2026-2027-1`; `-3` is the summer term.
 */
export function fetchSchedule(jar, termCode, signal) {
  return jwtCall(jar, `${API_BASE}${SCHEDULE_PATH}`, {
    method: 'POST',
    referrer: APP_REFERRER,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ termCode, type: 'term' }).toString(),
  }, signal)
}

/** Fetch the term's exam list (`{ datas: [...] }`). */
export function fetchExams(jar, termCode, signal) {
  return jwtCall(jar, `${API_BASE}${EXAMS_PATH}?termCode=${encodeURIComponent(termCode)}`, {
    referrer: APP_REFERRER,
  }, signal)
}