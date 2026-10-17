/**
 * One BUAA sync run: SSO login (or cached jar), seven day-by-day course
 * fetches ~0.2s apart, exam listing, then an upsert into the domain.
 * Runs either inside a `ctx.jobs` job (observable, cancellable) or inline
 * when the jobs seam is unavailable.
 */
import { apiGet, BuaaError, detailUrl, examsUrl, SsoSessionCache, ssoLogin } from './sso.js'
import { termCodeFor, today, zonedIso } from './semester.js'

const DAY_MS = 86_400_000
const FETCH_PAUSE_MS = 200

/** Shared across activations of this module generation. */
const ssoCache = new SsoSessionCache()

/**
 * Parse one day's `detail.do` item list into weekly course rules.
 * New format (`bizName`/`time`/`place`) carries no week info and pins to
 * the default `1-16`; legacy format (`kcmc`/`zcd`/…) keeps its own values.
 */
export function parseCourseItems(items, date) {
  const dayOfWeek = (new Date(date + 'T12:00:00').getDay() + 6) % 7 + 1
  const rules = new Map()
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    let rule = null
    if (typeof item.bizName === 'string' && typeof item.time === 'string') {
      rule = parseModernItem(item, dayOfWeek)
    } else if (typeof item.kcmc === 'string') {
      rule = parseLegacyItem(item, dayOfWeek)
    }
    if (rule !== null) rules.set(ruleKey(rule), rule)
  }
  return [...rules.values()]
}

const ruleKey = rule =>
  [rule.courseName, rule.dayOfWeek, rule.startTime, rule.weekRange].join('\u0000')

function parseModernItem(item, dayOfWeek) {
  let courseName = item.bizName.trim()
  let teacher = ''
  const teacherMatch = courseName.match(/\(([^)]+)\)/)
  if (teacherMatch) {
    teacher = teacherMatch[1].trim()
    courseName = courseName.replace(teacherMatch[0], '').trim()
  }
  const time = item.time.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/)
  if (!time || courseName === '') return null
  return {
    courseName,
    teacher: teacher || '未知',
    classroom: (item.place ?? '').trim(),
    dayOfWeek,
    weekRange: '1-16',
    startTime: pad(time[1]),
    endTime: pad(time[2]),
  }
}

function parseLegacyItem(item, dayOfWeek) {
  const day = Number(item.xqj)
  const start = typeof item.kssj === 'string' && item.kssj.match(/^\d{1,2}:\d{2}$/)
  const end = typeof item.jssj === 'string' && item.jssj.match(/^\d{1,2}:\d{2}$/)
  if (!(day >= 1 && day <= 7) || !start || !end || !item.zcd) return null
  const classroom = `${item.jxlh ?? ''}${item.jash ?? ''}`.trim()
  return {
    courseName: item.kcmc.trim(),
    teacher: (item.jsxm ?? '').trim() || '未知',
    classroom,
    dayOfWeek: day,
    weekRange: item.zcd.trim(),
    startTime: pad(item.kssj),
    endTime: pad(item.jssj),
  }
}

const pad = hhmm => {
  const [h, m] = hhmm.split(':')
  return `${h.padStart(2, '0')}:${m}`
}

/** Parse `exams.do` items into exam task drafts. */
export function parseExamItems(items) {
  const exams = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const name = String(item.kcmc ?? '').trim()
    const date = String(item.ksrq ?? '').trim()
    const start = String(item.kssj ?? '').trim()
    if (name === '' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(start)) continue
    const [y, m, d] = date.split('-').map(Number)
    const [hh, mm] = start.split(':').map(Number)
    const details = [
      item.ksdd ? `地点：${item.ksdd}` : '',
      item.ksxz ? `性质：${item.ksxz}` : '',
      item.khfsmc ? `考核方式：${item.khfsmc}` : '',
    ].filter(Boolean).join('；')
    exams.push({
      title: `${name} 考试`,
      description: details === '' ? null : details,
      taskType: 'exam',
      due: zonedIso(y, m, d, hh, mm),
      priority: 'high',
    })
  }
  return exams
}

/**
 * @param {object} deps - `{ service, ctx }`.
 * @param {object} creds - `{ buaaId, password? }`; when `password` is
 *   omitted a cached SSO jar is required.
 * @param {object} [control] - `{ onProgress(text), signal }` from a job.
 * @returns {object} summary for tools and the settings panel.
 */
export async function runSync({ service, ctx }, creds, control = {}) {
  const { onProgress = () => {}, signal } = control
  const buaaId = creds.buaaId || service.getMeta().buaaId
  if (!buaaId) throw new BuaaError('invalid_input', '缺少学号（先在设置或工具参数里提供）')

  let jar = ssoCache.get(buaaId)
  if (creds.password) {
    onProgress('正在登录北航 SSO…')
    jar = await ssoLogin(buaaId, creds.password, signal)
    ssoCache.set(buaaId, jar)
  } else if (!jar) {
    throw new BuaaError('need_login', '没有可用的 SSO 会话，请提供密码重新登录')
  }

  const startDay = today()
  const termCode = termCodeFor(startDay)
  const rulesByKey = new Map()
  let daysFetched = 0
  let daysFailed = 0

  for (let i = 0; i < 7; i += 1) {
    if (signal?.aborted) throw new BuaaError('aborted', '同步已取消')
    const date = new Date(new Date(startDay + 'T12:00:00').getTime() + i * DAY_MS)
    const p = n => String(n).padStart(2, '0')
    const dateStr = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    onProgress(`获取课表 ${i + 1}/7（${dateStr}）…`)
    try {
      const items = await apiGet(jar, detailUrl(dateStr), signal)
      for (const rule of parseCourseItems(items, dateStr)) {
        rulesByKey.set(ruleKey(rule), rule)
      }
      daysFetched += 1
    } catch (error) {
      if (error.code === 'need_login' || error.code === 'aborted') throw error
      // One bad day shouldn't sink the whole sync (legacy behavior).
      daysFailed += 1
      ctx.logger.warn('buaaer sync: day %s failed: %s', dateStr, error.message)
    }
    if (i < 6) await pause(FETCH_PAUSE_MS, signal)
  }
  if (daysFetched === 0) throw new BuaaError('network', '七天课表全部获取失败（网络或会话问题）')

  onProgress('获取考试安排…')
  const examTasks = []
  try {
    examTasks.push(...parseExamItems(await apiGet(jar, examsUrl(termCode), signal)))
  } catch (error) {
    if (error.code === 'need_login' || error.code === 'aborted') throw error
    ctx.logger.warn('buaaer sync: exams failed: %s', error.message)
  }

  onProgress('写入课程规则…')
  const courseSummary = await service.upsertCoursesFromSync([...rulesByKey.values()], { termCode })

  let examCreated = 0
  let examUpdated = 0
  const existingByTitle = new Map(service.listTasks({ scope: 'all' })
    .filter(task => task.source === 'buaa_sync')
    .map(task => [task.title, task]))
  for (const draft of examTasks) {
    const existing = existingByTitle.get(draft.title)
    if (existing === undefined) {
      await service.createTask({ ...draft, source: 'buaa_sync' })
      examCreated += 1
    } else if (existing.due !== draft.due || existing.description !== draft.description) {
      await service.updateTask(existing.id, { ...draft })
      examUpdated += 1
    }
  }

  return {
    daysFetched,
    daysFailed,
    termCode,
    courses: courseSummary,
    exams: { created: examCreated, updated: examUpdated, total: examTasks.length },
  }
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new BuaaError('aborted', '同步已取消'))
    }, { once: true })
  })
}

/**
 * Start the sync as a background job when the seam is mounted, else run it
 * inline. The job's own signal — not the caller's — drives cancellation
 * once the id is published (tool-runbook requirement).
 */
export function startSyncJob(deps, creds) {
  const jobs = deps.ctx.get('jobs')
  if (!jobs) {
    return { inline: true, done: runSync(deps, creds) }
  }
  const controller = new AbortController()
  let settle
  const done = new Promise((resolve, reject) => { settle = { resolve, reject } })
  try {
    const id = jobs.start({
      kind: 'buaaer-sync',
      label: `北航课表同步（${creds.buaaId || '使用已存学号'}）`,
      run(job) {
        runSync(deps, creds, { onProgress: line => job.updateProgress(line), signal: controller.signal })
          .then(summary => {
            job.append(`完成：${summary.daysFetched}/7 天，课程 ${summary.courses.total} 条，考试 ${summary.exams.total} 条\n`)
            settle.resolve(summary)
            return { status: 'completed', result: JSON.stringify(summary) }
          })
          .catch(error => {
            settle.reject(error)
            const failed = error.code === 'aborted'
            job.append(`${failed ? '已取消' : '失败'}：${error.message}\n`)
            return { status: failed ? 'killed' : 'failed', detail: error.message }
          })
        return {
          cancel: reason => controller.abort(new BuaaError('aborted', reason || '用户取消')),
          done,
        }
      },
    })
    return { inline: false, jobId: id, done }
  } catch (error) {
    // A profile without a mounted job controller rejects start(); degrade
    // to an inline run rather than failing the sync itself.
    deps.ctx.logger.warn('buaaer sync: jobs.start unavailable (%s), running inline', error.message)
    return { inline: true, done: runSync(deps, creds) }
  }
}
