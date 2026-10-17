/**
 * The one business implementation behind every caller (rule: a UI write and
 * an agent tool hit the same method here). Validates with the domain's zod
 * schemas, runs conflict detection, writes through the domain's serialized
 * chain, then bumps a revision counter and notifies subscribers.
 */
import { randomUUID } from 'node:crypto'
import { ISO_DATETIME_RE, PRIORITIES, TASK_TYPES } from './domain.js'
import { findConflicts } from './conflicts.js'
import { deriveWeekOccurrences, termWeek, today } from './semester.js'

const nowIso = () => new Date().toISOString()

class ServiceError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

const assert = (condition, code, message) => {
  if (!condition) throw new ServiceError(code, message)
}

const isIso = value =>
  typeof value === 'string' && ISO_DATETIME_RE.test(value)

/** Trim, then reject empty optional strings by turning them into null. */
const text = (value, field) => {
  if (value === null || value === undefined) return null
  assert(typeof value === 'string', 'invalid_input', `${field} 必须是字符串`)
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Whole-day entries span [day T00:00, day+1 T00:00) in local time. */
function normalizeAllDay(day) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(day), 'invalid_input', `allDay 日期格式应为 YYYY-MM-DD：${day}`)
  const next = new Date(day + 'T12:00:00')
  next.setDate(next.getDate() + 1)
  const p = n => String(n).padStart(2, '0')
  const endDay = `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`
  const offset = offsetOf(day + 'T12:00:00')
  return { start: `${day}T00:00:00${offset}`, end: `${endDay}T00:00:00${offset}` }
}

function offsetOf(localIso) {
  const date = new Date(localIso)
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const p = n => String(n).padStart(2, '0')
  return `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

/**
 * @param {import('@deepseek-ai/dsh-storage-domain').Domain} domain
 */
export function createScheduleService(ctx, domain) {
  const entries = domain.table('entries')
  const tasks = domain.table('tasks')
  const courses = domain.table('courses')
  let revision = 0
  const listeners = new Set()

  const changed = tables => {
    revision += 1
    for (const listener of listeners) {
      try {
        listener({ tables, revision })
      } catch (error) {
        ctx.logger.warn('buaaerSchedule listener failed: %s', error.message)
      }
    }
  }

  const allEntries = () => [...entries.entries()].map(([, row]) => row)
  const allTasks = () => [...tasks.entries()].map(([, row]) => row)
  const allCourses = () => [...courses.entries()].map(([, row]) => row)

  const termStartOf = () => domain.global.get().termStart || null

  /** Gate writes that overlap existing time unless the caller opts in. */
  const guardConflicts = async (candidate, allowConflicts) => {
    if (allowConflicts) return
    const conflicts = findConflicts(candidate, {
      entries: allEntries(),
      courseRows: allCourses(),
      termStart: termStartOf(),
    })
    if (conflicts.length > 0) {
      throw new ServiceError('conflict', '写入与既有日程冲突', { conflicts })
    }
  }

  const entryInput = (input, { partial = false } = {}) => {
    const row = {}
    if (!partial || input.title !== undefined) {
      row.title = text(input.title, 'title') ?? assertTitle(input.title)
    }
    if (!partial || input.description !== undefined) row.description = text(input.description, 'description')
    if (!partial || input.category !== undefined) {
      assert(typeof input.category === 'string' && input.category.length > 0, 'invalid_input', 'category 不能为空')
      row.category = input.category
    }
    if (input.allDay) {
      const { start, end } = normalizeAllDay(input.day ?? String(input.start).slice(0, 10))
      row.allDay = true
      row.start = start
      row.end = end
    } else {
      if (!partial || input.start !== undefined) {
        assert(isIso(input.start), 'invalid_input', `start 必须是带时区的 ISO 8601：${input.start}`)
        row.start = input.start
      }
      if (!partial || input.end !== undefined) {
        assert(isIso(input.end), 'invalid_input', `end 必须是带时区的 ISO 8601：${input.end}`)
        row.end = input.end
      }
      assert(row.end === undefined || row.start === undefined || new Date(row.end) > new Date(row.start),
        'invalid_input', 'end 必须晚于 start')
    }
    if (input.taskId !== undefined) row.taskId = text(input.taskId, 'taskId')
    return row
  }

  function assertTitle(title) {
    assert(typeof title === 'string' && title.trim() !== '', 'invalid_input', 'title 不能为空')
    return title.trim()
  }

  const service = {
    // -- entries ------------------------------------------------------------
    listEntries(from, to) {
      // Half-open window [from, to); both bounds optional.
      const start = from === undefined ? -Infinity : new Date(from).getTime()
      const end = to === undefined ? Infinity : new Date(to).getTime()
      return allEntries()
        .filter(row => {
          const rowStart = new Date(row.start).getTime()
          const rowEnd = new Date(row.end).getTime()
          return rowStart < end && rowEnd > start
        })
        .sort((a, b) => a.start.localeCompare(b.start))
    },

    async createEntry(input, { allowConflicts = false } = {}) {
      const row = entryInput(input)
      row.id = randomUUID()
      row.updatedAt = nowIso()
      await guardConflicts(row, allowConflicts)
      await entries.put(row.id, row)
      changed(['entries'])
      return row
    },

    async updateEntry(id, patch, { allowConflicts = false } = {}) {
      const current = entries.get(id)
      assert(current !== undefined, 'not_found', `条目不存在：${id}`)
      const row = { ...current, ...entryInput(patch, { partial: true }), updatedAt: nowIso() }
      if (patch.allDay === false) {
        delete row.allDay
      }
      await guardConflicts(row, allowConflicts)
      await entries.put(id, row)
      changed(['entries'])
      return row
    },

    async moveEntry(id, start, end, { allowConflicts = false } = {}) {
      assert(isIso(start) && isIso(end), 'invalid_input', 'move 需要 start/end（带时区 ISO 8601）')
      return service.updateEntry(id, { start, end }, { allowConflicts })
    },

    async deleteEntry(id) {
      const existed = await entries.delete(id)
      assert(existed, 'not_found', `条目不存在：${id}`)
      changed(['entries'])
      return { id, deleted: true }
    },

    async batchCreateEntries(inputs, { allowConflicts = false } = {}) {
      const results = []
      for (const input of inputs) {
        try {
          const row = await service.createEntry(input, { allowConflicts })
          results.push({ ok: true, id: row.id, title: row.title })
        } catch (error) {
          results.push({ ok: false, title: input?.title, code: error.code ?? 'error', message: error.message })
        }
      }
      return results
    },

    // -- tasks --------------------------------------------------------------
    listTasks({ scope = 'all', includeCompleted = true } = {}) {
      const now = Date.now()
      const endOfWeek = now + 7 * 86_400_000
      return allTasks()
        .filter(row => {
          if (!includeCompleted && row.completed) return false
          if (scope === 'all') return true
          const due = new Date(row.due).getTime()
          if (scope === 'overdue') return !row.completed && due < now
          if (scope === 'today') return dayKeyOf(row.due) === today()
          if (scope === 'week') return due >= now && due <= endOfWeek
          return true
        })
        .sort((a, b) => a.due.localeCompare(b.due))
    },

    taskInput(input, { partial = false, current } = {}) {
      const row = {}
      if (!partial || input.title !== undefined) row.title = assertTitle(input.title)
      if (!partial || input.description !== undefined) row.description = text(input.description, 'description')
      if (!partial || input.taskType !== undefined) {
        const taskType = input.taskType ?? (partial ? undefined : 'other')
        assert(TASK_TYPES.includes(taskType), 'invalid_input', `taskType 须为 ${TASK_TYPES.join('|')}`)
        if (taskType !== undefined) row.taskType = taskType
      }
      if (!partial || input.due !== undefined) {
        assert(isIso(input.due), 'invalid_input', `due 必须是带时区的 ISO 8601：${input.due}`)
        row.due = input.due
      }
      if (!partial || input.priority !== undefined) {
        const priority = input.priority ?? (partial ? undefined : 'medium')
        assert(PRIORITIES.includes(priority), 'invalid_input', `priority 须为 ${PRIORITIES.join('|')}`)
        if (priority !== undefined) row.priority = priority
      }
      if (!partial || input.completed !== undefined) {
        assert(input.completed === undefined || typeof input.completed === 'boolean',
          'invalid_input', 'completed 必须是布尔值')
        row.completed = input.completed ?? false
      }
      // entryId is a required (nullable) schema key — always materialize it,
      // or records written without one fail open()'s validation on restart.
      if (input.entryId !== undefined) row.entryId = text(input.entryId, 'entryId')
      else if (!partial && current === undefined) row.entryId = null
      if (input.source !== undefined) row.source = input.source
      else if (!partial && current === undefined) row.source = 'manual'
      return row
    },

    async createTask(input) {
      const row = service.taskInput(input)
      row.id = randomUUID()
      row.updatedAt = nowIso()
      await tasks.put(row.id, row)
      changed(['tasks'])
      return row
    },

    async updateTask(id, patch) {
      const current = tasks.get(id)
      assert(current !== undefined, 'not_found', `任务不存在：${id}`)
      const row = { ...current, ...service.taskInput(patch, { partial: true, current }), updatedAt: nowIso() }
      await tasks.put(id, row)
      changed(['tasks'])
      return row
    },

    async setTaskCompleted(id, completed) {
      return service.updateTask(id, { completed })
    },

    async deleteTask(id) {
      const existed = await tasks.delete(id)
      assert(existed, 'not_found', `任务不存在：${id}`)
      changed(['tasks'])
      return { id, deleted: true }
    },

    // -- courses ------------------------------------------------------------
    listCourses() {
      return allCourses().sort((a, b) =>
        a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime))
    },

    /** Project weekly rules onto one displayed week (computed, never stored). */
    weekOccurrences(weekStart) {
      return deriveWeekOccurrences(allCourses(), weekStart, termStartOf())
    },

    /**
     * Upsert sync results by rule identity — replaces the legacy
     * "delete the whole table, then insert" destructive write.
     * Absent rules are NOT removed: the sync observes one teaching week, so
     * a rule outside it (e.g. weeks 1-8 while week 10 syncs) would be
     * indistinguishable from a dropped course. The one safe full clear is a
     * term boundary, handled by the `termCode` rollover below.
     * @param {readonly object[]} rules - parsed course rules from sync.
     * @param {object} [options]
     * @param {string} [options.termCode] - school term the rules belong to.
     */
    async upsertCoursesFromSync(rules, { termCode } = {}) {
      let cleared = 0
      if (termCode && termCode !== domain.global.get().termCode) {
        for (const stale of allCourses()) {
          await courses.delete(stale.id)
          cleared += 1
        }
        await domain.global.set({ ...domain.global.get(), termCode })
      }
      const keyOf = rule =>
        [rule.courseName, rule.dayOfWeek, rule.startTime, rule.weekRange].join('\u0000')
      const existing = new Map(allCourses().map(row => [keyOf(row), row]))
      let created = 0
      let updated = 0
      for (const rule of rules) {
        const key = keyOf(rule)
        const prior = existing.get(key)
        const stamp = nowIso()
        if (prior === undefined) {
          const row = { ...rule, id: randomUUID(), updatedAt: stamp }
          await courses.put(row.id, row)
          created += 1
        } else if (prior.teacher !== rule.teacher || prior.classroom !== rule.classroom
          || prior.endTime !== rule.endTime) {
          await courses.put(prior.id, { ...prior, ...rule, id: prior.id, updatedAt: stamp })
          updated += 1
        }
      }
      if (created + updated + cleared > 0) changed(['courses', 'global'])
      return { created, updated, cleared, total: rules.length }
    },

    // -- meta & subscriptions ------------------------------------------------
    getMeta() {
      return { ...domain.global.get() }
    },

    async setMeta(patch) {
      const current = domain.global.get()
      const next = { ...current }
      for (const field of ['buaaId', 'termStart', 'termCode']) {
        if (patch[field] !== undefined) {
          assert(typeof patch[field] === 'string', 'invalid_input', `${field} 必须是字符串`)
          if (field === 'termStart') {
            assert(patch[field] === '' || /^\d{4}-\d{2}-\d{2}$/.test(patch[field]),
              'invalid_input', 'termStart 应为 YYYY-MM-DD（学期第一周周一）')
          }
          next[field] = patch[field].trim()
        }
      }
      await domain.global.set(next)
      changed(['global'])
      return { ...next }
    },

    /** Snapshot for the client panel: one fetch, everything it renders. */
    snapshot({ weekStart } = {}) {
      const meta = service.getMeta()
      const weekMonday = weekStart || mondayToday()
      return {
        revision,
        global: meta,
        // Teaching-week number of the DISPLAYED week (the badge follows navigation).
        termWeek: termWeek(meta.termStart, weekMonday),
        termWeekToday: termWeek(meta.termStart, today()),
        today: today(),
        courses: service.listCourses(),
        occurrences: service.weekOccurrences(weekMonday),
        weekStart: weekMonday,
        entries: service.listEntries(
          `${weekMonday}T00:00:00${offsetOf(weekMonday + 'T12:00:00')}`,
          addDaysIso(weekMonday, 7, offsetOf(weekMonday + 'T12:00:00')),
        ),
        tasks: service.listTasks(),
      }
    },

    currentRevision() {
      return revision
    },

    /** Change notification for satellite plugins (reminders, later bridge). */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return service
}

function dayKeyOf(isoDatetime) {
  const date = new Date(isoDatetime)
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

function mondayToday() {
  const date = new Date()
  const shift = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - shift)
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

function addDaysIso(day, days, offset) {
  const date = new Date(day + 'T12:00:00')
  date.setDate(date.getDate() + days)
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T00:00:00${offset}`
}

export { ServiceError }
