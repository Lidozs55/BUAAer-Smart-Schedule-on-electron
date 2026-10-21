/**
 * Minimal Bilibili read client.
 *
 * Verified preconditions (2026-10-21):
 * - Official column lists (x/space/article) work without login.
 * - Full columns (x/article/view) work without login but are rate limited:
 *   two quick calls answered `-509`. Requests are therefore serialized with
 *   a >= 2.5 s gap and retried with exponential backoff.
 * - Search and the dynamic feed need a `buvid3` cookie; the anonymous SPI
 *   endpoint supplies one without login.
 * - `x/space/wbi/arc/search` is not used: it answered `-352` even with a
 *   cookie, and WBI signing is not worth the fragility.
 *
 * Every failure is surfaced as BiliError; callers keep the previous state
 * instead of writing guessed values.
 */

const API = 'https://api.bilibili.com'
const DEFAULT_REFERER = 'https://www.bilibili.com/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Codes that mean "slow down / refresh the cookie", never "no data". */
const TRANSIENT = new Set([-352, -412, -500, -503, -509, -799])

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const backoff = attempt => [5_000, 12_000, 25_000][Math.min(attempt, 2)]

export class BiliError extends Error {
  constructor(code, message, url) {
    super(message || `Bilibili error ${code}`)
    this.name = 'BiliError'
    this.code = code
    this.url = url
  }
}

/** Strip column HTML to readable text while keeping paragraph breaks. */
export function stripHtml(input) {
  if (typeof input !== 'string') return ''
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Best-effort text of one dynamic card (opus, draw, forward, video). */
export function dynamicText(item) {
  const dynamic = item?.modules?.module_dynamic
  const candidates = [
    dynamic?.desc?.text,
    dynamic?.major?.opus?.summary?.text,
    dynamic?.major?.opus?.title,
    dynamic?.major?.archive?.title,
    dynamic?.major?.archive?.desc,
  ]
  return candidates.find(value => typeof value === 'string' && value.trim() !== '')?.trim() ?? ''
}

export const articleUrl = id => {
  const value = String(id)
  if (/^cv\d+$/i.test(value)) return `https://www.bilibili.com/read/${value}`
  // `x/space/article` returns the numeric column id (cv id without prefix);
  // opus ids are 18–19 digit snowflakes.
  if (/^\d{1,12}$/.test(value)) return `https://www.bilibili.com/read/cv${value}`
  return `https://www.bilibili.com/opus/${value}`
}
export const videoUrl = bvid => `https://www.bilibili.com/video/${bvid}`

/**
 * @param {{ warn?: Function, info?: Function }} [logger]
 */
export function createBilibili(logger = {}) {
  let cookiePromise = null
  let lastRequestAt = 0
  /** Serial chain: Bilibili limits per source IP, not per endpoint. */
  let chain = Promise.resolve()

  const stats = { requests: 0, retries: 0, lastError: null }

  function enqueue(task, gap) {
    const run = chain.then(async () => {
      const wait = lastRequestAt + gap - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        return await task()
      } finally {
        lastRequestAt = Date.now()
        stats.requests += 1
      }
    })
    // Keep the chain alive after a rejected request.
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  async function rawJson(url, cookie, referer, signal) {
    const response = await fetch(url, {
      signal,
      headers: {
        'User-Agent': UA,
        Referer: referer,
        // The `x/space/*` and `x/series/*` endpoints answer HTTP 412 when
        // called as a bare document request; a space origin makes them accept
        // the same anonymous cookie the browser sends.
        Origin: 'https://space.bilibili.com',
        Accept: 'application/json, text/plain, */*',
        ...(cookie === '' ? {} : { Cookie: cookie }),
      },
    })
    if (response.status === 412) {
      throw new BiliError(412, '请求被 B 站风控拦截（HTTP 412）', url)
    }
    if (!response.ok) {
      throw new BiliError(response.status, `HTTP ${response.status}`, url)
    }
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new BiliError('bad_json', 'B 站返回了非 JSON 内容', url)
    }
  }

  async function ensureCookie(signal) {
    if (cookiePromise !== null) return cookiePromise
    cookiePromise = (async () => {
      try {
        const url = `${API}/x/frontend/finger/spi`
        const data = await enqueue(async () => {
          const json = await rawJson(url, '', DEFAULT_REFERER, signal)
          if (json.code !== 0) throw new BiliError(json.code, json.message, url)
          return json.data
        }, 0)
        const buvid3 = typeof data?.b_3 === 'string' ? data.b_3 : ''
        const buvid4 = typeof data?.b_4 === 'string' ? data.b_4 : ''
        if (buvid3 === '') return ''
        return `buvid3=${buvid3}${buvid4 === '' ? '' : `; buvid4=${buvid4}`}`
      } catch (error) {
        logger.warn?.('gacha-schedule: anonymous buvid cookie unavailable: %s', error.message)
        return ''
      }
    })()
    return cookiePromise
  }

  /**
   * One logical GET with retries. `gap` is the minimum distance from the
   * previous request; full-column reads use a much larger gap.
   */
  async function getJson(path, {
    gap = 1_500,
    retries = 2,
    signal,
    cookie = true,
    referer = DEFAULT_REFERER,
  } = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`
    let auth = cookie ? await ensureCookie(signal) : ''
    for (let attempt = 0; ; attempt += 1) {
      const startedAt = Date.now()
      try {
        const json = await enqueue(() => rawJson(url, auth, referer, signal), gap)
        if (json.code === 0) {
          logger.debug?.('gacha-schedule: GET %s ok in %d ms (%d requests total)',
            path.split('?')[0], Date.now() - startedAt, stats.requests)
          return json.data
        }
        if (!TRANSIENT.has(json.code)) throw new BiliError(json.code, json.message, url)
        throw new BiliError(json.code, json.message, url)
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        const transient = error instanceof BiliError ? TRANSIENT.has(error.code) : true
        if (!transient || attempt >= retries) {
          stats.lastError = error.message
          throw error
        }
        stats.retries += 1
        logger.warn?.('gacha-schedule: Bilibili retry %d for %s: %s',
          attempt + 1, path.split('?')[0], error.message)
        if (error?.code === -352 || error?.code === 412) {
          // The cookie may have gone stale; fetch a fresh anonymous one.
          cookiePromise = null
          auth = cookie ? await ensureCookie(signal) : ''
        }
        await sleep(backoff(attempt))
      }
    }
  }

  return {
    stats,
    async articleList(mid, { signal } = {}) {
      const data = await getJson(
        `/x/space/article?mid=${encodeURIComponent(mid)}&pn=1&ps=30&sort=publish_time`,
        {
          gap: 1_200,
          retries: 2,
          signal,
          referer: `https://space.bilibili.com/${encodeURIComponent(mid)}/article`,
        })
      return Array.isArray(data?.articles) ? data.articles : []
    },

    async articleView(id, { signal } = {}) {
      const data = await getJson(`/x/article/view?id=${encodeURIComponent(id)}`,
        { gap: 2_800, retries: 4, signal, referer: articleUrl(id) })
      return {
        id: Number(data?.id ?? id),
        title: typeof data?.title === 'string' ? data.title : '',
        content: stripHtml(data?.content ?? ''),
        publishTime: Number(data?.publish_time ?? 0),
        author: typeof data?.author_name === 'string' ? data.author_name : '',
      }
    },

    /** Official uploads matching a keyword, with pubdate. Endpoint may reject. */
    async featureVideos(mid, keyword, { signal } = {}) {
      try {
        const data = await getJson(
          `/x/series/recArchivesByKeywords?mid=${encodeURIComponent(mid)}`
          + `&keywords=${encodeURIComponent(keyword)}&ps=20`,
          {
            gap: 2_500,
            retries: 3,
            signal,
            // A space origin is mandatory: the default www referer yields 412.
            referer: `https://space.bilibili.com/${encodeURIComponent(mid)}/upload/video`,
          })
        return Array.isArray(data?.archives) ? data.archives : []
      } catch (error) {
        logger.info?.('gacha-schedule: feature video list unavailable for %s: %s', mid, error.message)
        return []
      }
    },

    async searchVideos(keyword, { signal } = {}) {
      const data = await getJson(
        '/x/web-interface/search/type?search_type=video&order=pubdate&page=1&page_size=50'
        + `&keyword=${encodeURIComponent(keyword)}`,
        { gap: 1_800, retries: 1, signal, referer: 'https://search.bilibili.com/' })
      return Array.isArray(data?.result) ? data.result : []
    },

    /** Recent official dynamics; optional because some accounts answer -352. */
    async dynamics(mid, { signal } = {}) {
      try {
        // `features=itemOpusStyle` makes the Genshin account answer -352;
        // the plain feed carries the same module_dynamic text.
        const data = await getJson(
          `/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(mid)}`
          + '&offset=&timezone_offset=-480',
          {
            gap: 2_500,
            retries: 1,
            signal,
            referer: `https://space.bilibili.com/${encodeURIComponent(mid)}/dynamic`,
          })
        return Array.isArray(data?.items) ? data.items : []
      } catch (error) {
        logger.info?.('gacha-schedule: dynamics unavailable for %s: %s', mid, error.message)
        return []
      }
    },

    async video(bvid, { signal } = {}) {
      const data = await getJson(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
        { gap: 1_200, retries: 1, signal })
      return {
        bvid,
        title: typeof data?.title === 'string' ? data.title : '',
        desc: stripHtml(data?.desc ?? ''),
        pubdate: Number(data?.pubdate ?? 0),
      }
    },
  }
}
