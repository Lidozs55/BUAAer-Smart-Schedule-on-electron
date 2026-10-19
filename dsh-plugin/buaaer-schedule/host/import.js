/**
 * Full-domain import for the shape this plugin's own export produces
 * (`settings.section` → export JSON). Round-tripping an export must work.
 *
 * Source-specific legacy dumps (the old Electron SQLite export) belong to
 * their source adapter, not here — see `@buaaer/dsh-schedule-buaa`.
 */

const PRIORITIES = ['high', 'medium', 'low']

const priorityOf = value => (PRIORITIES.includes(value) ? value : 'medium')

const hhmm = value => (typeof value === 'string' ? value.slice(0, 5) : '00:00')

const ruleKey = row => [
  row.courseName, row.dayOfWeek, row.startTime, row.weekRange,
].join('\u0000')

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const courseOf = row => ({
  courseName: typeof row.courseName === 'string' ? row.courseName : '',
  teacher: typeof row.teacher === 'string' ? row.teacher : '未知',
  classroom: typeof row.classroom === 'string' ? row.classroom : '',
  dayOfWeek: Number(row.dayOfWeek),
  weekRange: typeof row.weekRange === 'string' && row.weekRange !== '' ? row.weekRange : '1-16',
  startTime: hhmm(row.startTime),
  endTime: hhmm(row.endTime),
})

/**
 * @param {object} service - the schedule service.
 * @param {object} payload - `{ global?, courses?, courseOverrides?, entries?, tasks? }`.
 * @returns {object} per-table reconciliation counts.
 */
export async function importSchedulePayload(service, payload) {
  if (!isObject(payload)) {
    throw Object.assign(new Error('导入载荷不是对象'), { code: 'invalid_input' })
  }
  const counts = {
    courses: { total: 0, created: 0, updated: 0 },
    courseOverrides: { total: 0, imported: 0 },
    entries: { total: 0, created: 0, skipped: 0 },
    tasks: { total: 0, created: 0, skipped: 0 },
  }

  const termStart = payload.global?.termStart
  if (typeof termStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(termStart)
      && service.getMeta().termStart === '') {
    await service.setMeta({ termStart })
  }

  const courseRows = Array.isArray(payload.courses) ? payload.courses : []
  counts.courses.total = courseRows.length
  if (courseRows.length > 0) {
    const summary = await service.upsertCourses(courseRows.map(courseOf), { source: 'import' })
    counts.courses.created = summary.created
    counts.courses.updated = summary.updated
  }

  // Exceptions are keyed by the OLD course id in an export; importer-created
  // rules get fresh ids, so re-key by rule identity before writing them back.
  const overrides = Array.isArray(payload.courseOverrides) ? payload.courseOverrides : []
  counts.courseOverrides.total = overrides.length
  if (overrides.length > 0) {
    const currentByKey = new Map(service.listCourses().map(row => [ruleKey(row), row.id]))
    const newIdOf = new Map()
    for (const row of courseRows) {
      if (row?.id === undefined) continue
      newIdOf.set(String(row.id), currentByKey.get(ruleKey(courseOf(row))))
    }
    for (const override of overrides) {
      const courseId = newIdOf.get(String(override.courseId))
      if (courseId === undefined) continue
      try {
        await service.saveCourseOccurrence({ ...override, courseId })
        counts.courseOverrides.imported += 1
      } catch {
        // A stale exception must not abort the whole import.
      }
    }
  }

  const entryIdMap = new Map()
  const existingEntries = new Map(service.listEntries()
    .map(row => [`${row.title}\u0000${row.start}`, row.id]))
  for (const entry of Array.isArray(payload.entries) ? payload.entries : []) {
    counts.entries.total += 1
    const start = entry.start
    const dedupKey = `${entry.title}\u0000${start}`
    if (existingEntries.has(dedupKey)) {
      if (entry.id !== undefined) entryIdMap.set(String(entry.id), existingEntries.get(dedupKey))
      counts.entries.skipped += 1
      continue
    }
    const created = await service.createEntry({
      title: entry.title,
      description: entry.description ?? null,
      category: entry.category ?? 'other',
      start,
      end: entry.end,
      allDay: entry.allDay === true || undefined,
    }, { allowConflicts: true })
    existingEntries.set(dedupKey, created.id)
    if (entry.id !== undefined) entryIdMap.set(String(entry.id), created.id)
    counts.entries.created += 1
  }

  const existingTasks = new Set(service.listTasks({ scope: 'all' })
    .map(row => `${row.title}\u0000${row.due}`))
  for (const task of Array.isArray(payload.tasks) ? payload.tasks : []) {
    counts.tasks.total += 1
    const due = task.due
    if (existingTasks.has(`${task.title}\u0000${due}`)) {
      counts.tasks.skipped += 1
      continue
    }
    await service.createTask({
      title: task.title,
      description: task.description ?? null,
      taskType: task.taskType ?? 'other',
      due,
      priority: priorityOf(task.priority),
      completed: task.completed === true,
      entryId: task.entryId === undefined || task.entryId === null
        ? null
        : entryIdMap.get(String(task.entryId)) ?? null,
      source: 'import',
    })
    existingTasks.add(`${task.title}\u0000${due}`)
    counts.tasks.created += 1
  }

  return counts
}
