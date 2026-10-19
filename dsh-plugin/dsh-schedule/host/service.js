/**
 * The one business implementation behind every caller (rule: a UI write and
 * an agent tool hit the same method here). Validates with the domain's zod
 * schemas, runs conflict detection, writes through the domain's serialized
 * chain, then bumps a revision counter and notifies subscribers.
 */
import { randomUUID } from 'node:crypto'
import { ENTRY_CATEGORIES, ISO_DATETIME_RE, PRIORITIES, SOURCE_ID_RE, TASK_TYPES, WEEK_RANGE_RE } from './domain.js'
import { findConflicts } from './conflicts.js'
import { anchorToday, addDays, dateKey, deriveWeekOccurrences, termWeek, today, zonedIso } from './semester.js'

const nowIso = () => new Date().toISOString()

/** `YYYY-MM-DD`, the only day-key shape that reaches window math. */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

const isDayKey = value => typeof value === 'string' && DAY_KEY_RE.test(value)

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

/** Local-zoned ISO at `dayKey` + minutes-from-midnight (handles overflow). */
const dayAt = (dayKey, minutes) => {
  const [y, m, d] = dayKey.split('-').map(Number)
  return zonedIso(y, m, d, Math.floor(minutes / 60), minutes % 60)
}

/** Whole-day entries span [day T00:00, day+1 T00:00) in local time. */
function normalizeAllDay(day) {
  assert(isDayKey(day), 'invalid_input', `allDay 日期格式应为 YYYY-MM-DD：${day}`)
  return { start: dayAt(day, 0), end: dayAt(addDays(day, 1), 0) }
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * One source-supplied weekly rule. Validated here because source plugins
 * persist rules through this service — a malformed row would otherwise only
 * surface at the next domain open.
 */
function courseRule(rule) {
  assert(rule !== null && typeof rule === 'object', 'invalid_input', '课程规则必须是对象')
  const courseName = typeof rule.courseName === 'string' ? rule.courseName.trim() : ''
  assert(courseName !== '', 'invalid_input', 'courseName 不能为空')
  assert(Number.isInteger(rule.dayOfWeek) && rule.dayOfWeek >= 1 && rule.dayOfWeek <= 7,
    'invalid_input', `dayOfWeek 须为 1-7：${rule.dayOfWeek}`)
  assert(typeof rule.weekRange === 'string' && WEEK_RANGE_RE.test(rule.weekRange),
    'invalid_input', `weekRange 格式不合法：${rule.weekRange}`)
  assert(typeof rule.startTime === 'string' && HHMM_RE.test(rule.startTime),
    'invalid_input', `startTime 须为 HH:mm：${rule.startTime}`)
  assert(typeof rule.endTime === 'string' && HHMM_RE.test(rule.endTime),
    'invalid_input', `endTime 须为 HH:mm：${rule.endTime}`)
  assert(new Date(`1970-01-01T${rule.endTime}:00`) > new Date(`1970-01-01T${rule.startTime}:00`),
    'invalid_input', 'endTime 必须晚于 startTime')
  return {
    courseName,
    teacher: typeof rule.teacher === 'string' ? rule.teacher.trim() : '',
    classroom: typeof rule.classroom === 'string' ? rule.classroom.trim() : '',
    dayOfWeek: rule.dayOfWeek,
    weekRange: rule.weekRange,
    startTime: rule.startTime,
    endTime: rule.endTime,
  }
}

/**
 * @param {import('@deepseek-ai/dsh-storage-domain').Domain} domain
 */
export function createScheduleService(ctx, domain) {
  const entries = domain.table('entries')
  const tasks = domain.table('tasks')
  const courses = domain.table('courses')
  const courseOverrides = domain.table('course_overrides')
  let revision = 0
  const listeners = new Set()

  const changed = tables => {
    revision += 1
    for (const listener of listeners) {
      try {
        listener({ tables, revision })
      } catch (error) {
        ctx.logger.warn('scheduleCore listener failed: %s', error.message)
      }
    }
  }

  const allEntries = () => [...entries.entries()].map(([, row]) => row)
  const allTasks = () => [...tasks.entries()].map(([, row]) => row)
  const allCourses = () => [...courses.entries()].map(([, row]) => row)
  const allCourseOverrides = () =>
    [...courseOverrides.entries()].map(([, row]) => row)

  const termStartOf = () => domain.global.get().termStart || null

  /** Gate writes that overlap existing time unless the caller opts in. */
  const guardConflicts = async (candidate, allowConflicts) => {
    if (allowConflicts) return
    const conflicts = findConflicts(candidate, {
      entries: allEntries(),
      courseRows: allCourses(),
      courseOverrides: allCourseOverrides(),
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
      // The store's zod schema enum-checks category on every start, and an
      // invalid record fails domain activation — gate it at the write.
      assert(ENTRY_CATEGORIES.includes(input.category), 'invalid_input',
        `category 须为 ${ENTRY_CATEGORIES.join('|')}：${input.category}`)
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

    // move/delete are natively multi-item (R9-3): pass one `{id, start, end}`
    // or one id for the single-item contract — row returned, errors thrown —
    // or an array for the batch contract — per-item results, no throw. One
    // code path instead of separate single/batch methods.
    async moveEntry(moves, { allowConflicts = false } = {}) {
      const many = Array.isArray(moves)
      const list = many ? moves : [moves]
      const results = []
      let touched = false
      let lastRow = null
      for (const move of list) {
        const { id } = move ?? {}
        try {
          assert(typeof id === 'string' && id !== '', 'invalid_input', 'move 需要 id')
          assert(isIso(move.start) && isIso(move.end), 'invalid_input',
            `move 需要带时区的 start/end：${move.start} .. ${move.end}`)
          const current = await entries.get(id)
          assert(current, 'not_found', `条目不存在：${id}`)
          const row = { ...current, start: move.start, end: move.end, updatedAt: nowIso() }
          await guardConflicts(row, allowConflicts)
          await entries.put(id, row)
          touched = true
          lastRow = row
          results.push({ ok: true, id, title: row.title })
        } catch (error) {
          if (!many) throw error
          results.push({
            ok: false,
            id,
            code: error.code ?? 'error',
            message: error.message,
            ...(error.details?.conflicts ? { conflicts: error.details.conflicts } : {}),
          })
        }
      }
      if (touched) changed(['entries'])
      return many ? results : lastRow
    },

    async deleteEntry(ids) {
      const many = Array.isArray(ids)
      const list = many ? ids : [ids]
      const deleted = []
      const missing = []
      for (const id of list) {
        if (await entries.delete(id)) deleted.push(id)
        else missing.push(id)
      }
      if (deleted.length > 0) changed(['entries'])
      if (!many) {
        assert(deleted.length > 0, 'not_found', `条目不存在：${list[0]}`)
        return { id: list[0], deleted: true }
      }
      return { deleted, missing }
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
          if (scope === 'today') return dateKey(new Date(row.due)) === today()
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
        // Legacy POST /api/tasks defaulted to homework — the dominant
        // kind for this product's audience; keep that default.
        const taskType = input.taskType ?? (partial ? undefined : 'homework')
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
      if (input.source !== undefined) {
        assert(typeof input.source === 'string' && SOURCE_ID_RE.test(input.source),
          'invalid_input', `source 须为小写来源 id：${input.source}`)
        row.source = input.source
      } else if (!partial && current === undefined) {
        row.source = 'manual'
      }
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

    /** Project weekly rules onto one displayed window (computed, never stored). */
    weekOccurrences(windowStart) {
      return deriveWeekOccurrences(
        allCourses(), windowStart, termStartOf(), allCourseOverrides())
    },

    listCourseOverrides() {
      return allCourseOverrides()
    },

    /**
     * Save a manual exception for ONE projected occurrence. The weekly rule
     * is untouched, so holidays / swapped classes do not leak into other
     * weeks and a later sync keeps the edit. `canceled` hides the class but
     * keeps a faint block the client can use to restore it.
     */
    async saveCourseOccurrence(input) {
      const courseId = text(input?.courseId, 'courseId')
      assert(courseId !== null, 'invalid_input', 'courseId 不能为空')
      const course = courses.get(courseId)
      assert(course !== undefined, 'not_found', `课程不存在：${courseId}`)
      const baseDay = text(input?.baseDay, 'baseDay')
      assert(isDayKey(baseDay), 'invalid_input', `baseDay 应为 YYYY-MM-DD：${input?.baseDay}`)
      const courseName = text(input?.courseName, 'courseName') ?? course.courseName
      assert(isIso(input?.start) && isIso(input?.end), 'invalid_input',
        '课程修改需要带时区的 start/end')
      assert(new Date(input.end) > new Date(input.start), 'invalid_input', 'end 必须晚于 start')
      const row = {
        id: `${courseId}@${baseDay}`,
        courseId,
        baseDay,
        courseName,
        teacher: text(input?.teacher, 'teacher') ?? '',
        classroom: text(input?.classroom, 'classroom') ?? '',
        start: input.start,
        end: input.end,
        canceled: input?.canceled === true,
        updatedAt: nowIso(),
      }
      await courseOverrides.put(row.id, row)
      changed(['course_overrides'])
      return row
    },

    /** Drop an exception → the occurrence follows the synced rule again. */
    async resetCourseOccurrence(courseId, baseDay) {
      assert(isDayKey(baseDay), 'invalid_input', `baseDay 应为 YYYY-MM-DD：${baseDay}`)
      const id = `${courseId}@${baseDay}`
      const existed = await courseOverrides.delete(id)
      if (existed) changed(['course_overrides'])
      return { id, deleted: existed }
    },

    /**
     * Upsert course rules from a source adapter (calendaring source plugin).
     * Identity is the rule tuple, so re-syncing never clears the table.
     * Absent rules are NOT removed: a sync observes one teaching week, so a
     * rule outside it (e.g. weeks 1-8 while week 10 syncs) would be
     * indistinguishable from a dropped course. The one safe full clear is a
     * term boundary: when this source reports a DIFFERENT term code than the
     * one it last reported, stale rules and their per-occurrence exceptions
     * are cleared before the upsert.
     * @param {readonly object[]} rules - parsed course rules from a source.
     * @param {object} [options]
     * @param {string} [options.source] - source id owning the term code.
     * @param {string} [options.termCode] - school term the rules belong to.
     */
    async upsertCourses(rules, { source = 'manual', termCode } = {}) {
      assert(Array.isArray(rules), 'invalid_input', '课程规则必须是数组')
      const state = service.getSourceState(source)
      const priorTerm = typeof state.termCode === 'string' ? state.termCode : ''
      const termChanged = termCode !== undefined && priorTerm !== ''
        && termCode !== priorTerm
      let cleared = 0
      let clearedOverrides = 0
      if (termChanged) {
        for (const stale of allCourses()) {
          await courses.delete(stale.id)
          cleared += 1
        }
        // Overrides belong to the old term's rules; keeping them would
        // resurrect dead course ids into the new term's grid.
        for (const stale of allCourseOverrides()) {
          await courseOverrides.delete(stale.id)
          clearedOverrides += 1
        }
      }
      if (termCode !== undefined && termCode !== priorTerm) {
        await service.setSourceState(source, { ...state, termCode })
      }
      const keyOf = rule =>
        [rule.courseName, rule.dayOfWeek, rule.startTime, rule.weekRange].join('\u0000')
      const existing = new Map(allCourses().map(row => [keyOf(row), row]))
      let created = 0
      let updated = 0
      for (const raw of rules) {
        const rule = courseRule(raw)
        const key = keyOf(rule)
        const prior = existing.get(key)
        const stamp = nowIso()
        if (prior === undefined) {
          const row = { ...rule, id: randomUUID(), updatedAt: stamp }
          await courses.put(row.id, row)
          existing.set(key, row)
          created += 1
        } else if (prior.teacher !== rule.teacher || prior.classroom !== rule.classroom
          || prior.endTime !== rule.endTime) {
          const row = { ...prior, ...rule, id: prior.id, updatedAt: stamp }
          await courses.put(prior.id, row)
          existing.set(key, row)
          updated += 1
        }
      }
      if (created + updated + cleared + clearedOverrides > 0) changed(['courses', 'global'])
      return { created, updated, cleared, total: rules.length }
    },

    // -- meta & source state -------------------------------------------------
    /** Generic schedule metadata. Source adapters keep their own state below. */
    getMeta() {
      const global = domain.global.get()
      return { termStart: global.termStart }
    },

    async setMeta(patch) {
      const current = domain.global.get()
      const next = { ...current }
      if (patch.termStart !== undefined) {
        assert(typeof patch.termStart === 'string', 'invalid_input', 'termStart 必须是字符串')
        assert(patch.termStart === '' || /^\d{4}-\d{2}-\d{2}$/.test(patch.termStart),
          'invalid_input', 'termStart 应为 YYYY-MM-DD（学期第一周周一）')
        next.termStart = patch.termStart.trim()
      }
      await domain.global.set(next)
      changed(['global'])
      return service.getMeta()
    },

    /**
     * Opaque per-source state. A source plugin owns one key and decides its
     * own shape; the core only guarantees durable JSON round-tripping.
     * @param {string} source - source id, e.g. `school-portal`.
     * @returns {object} the stored object, or `{}` when never written.
     */
    getSourceState(source) {
      assert(typeof source === 'string' && SOURCE_ID_RE.test(source),
        'invalid_input', `来源 id 不合法：${source}`)
      const raw = domain.global.get().sourceState[source]
      if (raw === undefined) return {}
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        return {}
      }
    },

    async setSourceState(source, value) {
      assert(typeof source === 'string' && SOURCE_ID_RE.test(source),
        'invalid_input', `来源 id 不合法：${source}`)
      assert(value !== null && typeof value === 'object' && !Array.isArray(value),
        'invalid_input', '来源状态必须是对象')
      const current = domain.global.get()
      await domain.global.set({
        ...current,
        sourceState: { ...current.sourceState, [source]: JSON.stringify(value) },
      })
      changed(['global'])
      return { ...value }
    },

    /** Snapshot for the client panel: one fetch, everything it renders. */
    snapshot({ weekStart } = {}) {
      const meta = service.getMeta()
      // The client window is "anchor .. anchor+6", anchored anywhere;
      // the entries window reaches +7d 04:00 so the last column shows
      // its 0–4 o'clock tail (docs/10 P3/P8).
      const anchor = isDayKey(weekStart) ? weekStart : anchorToday()
      return {
        revision,
        global: meta,
        // Teaching-week number of the DISPLAYED window (the badge follows navigation).
        termWeek: termWeek(meta.termStart, anchor),
        termWeekToday: termWeek(meta.termStart, today()),
        today: today(),
        courses: service.listCourses(),
        occurrences: service.weekOccurrences(anchor),
        weekStart: anchor,
        entries: service.listEntries(dayAt(anchor, 0), dayAt(addDays(anchor, 7), 4 * 60)),
        tasks: service.listTasks(),
      }
    },

    currentRevision() {
      return revision
    },

    /** Change notification for the reminders subsystem and future bridges. */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** Derived upcoming-reminder set; host/reminders.js overrides this
     *  when the subsystem is armed (empty otherwise). */
    upcomingReminders: () => [],
  }

  return service
}

export { ServiceError }
