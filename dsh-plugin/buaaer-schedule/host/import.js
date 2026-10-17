/**
 * One-shot import for both payload shapes this plugin ever produces
 * (decision D-4): the legacy SQLite dump from
 * `scripts/export-legacy-db.mjs` (snake_case, naive Beijing datetimes)
 * and the settings page's full export (camelCase, already zoned).
 * Round-tripping an export back through import must work.
 *
 * Legacy numeric priority folds onto the three-level enum; `urgency` and
 * `color` are dropped by design. The task→entry link is re-keyed through
 * the export's entry ids, including entries deduplicated as "already
 * present".
 */

const withBeijingZone = naive =>
  typeof naive === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(naive) ? naive : `${naive}+08:00`

const PRIORITIES = ['high', 'medium', 'low']

const priorityOf = legacy => {
  if (PRIORITIES.includes(legacy)) return legacy
  const value = Number(legacy)
  if (value >= 67) return 'high'
  if (value >= 34) return 'medium'
  return 'low'
}

const hhmm = value => (typeof value === 'string' ? value.slice(0, 5) : '00:00')

/** First defined value among the given keys — the dual-shape adapter. */
const pick = (row, ...keys) => {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key]
  }
  return undefined
}

/**
 * @param {object} service - the schedule service.
 * @param {object} payload - `{ user?, courses?, tasks?, entries? }` in
 *   either the legacy or the current export shape.
 * @returns {object} per-table reconciliation counts.
 */
export async function importLegacyPayload(service, payload) {
  if (payload === null || typeof payload !== 'object') {
    throw Object.assign(new Error('导入载荷不是对象'), { code: 'invalid_input' })
  }
  const counts = { courses: { total: 0, created: 0 }, entries: { total: 0, created: 0, skipped: 0 }, tasks: { total: 0, created: 0, skipped: 0 } }

  const legacyBuaaId = payload.user?.[0]?.buaa_id
  if (legacyBuaaId && !service.getMeta().buaaId) {
    await service.setMeta({ buaaId: String(legacyBuaaId) })
  }

  for (const course of payload.courses ?? []) {
    counts.courses.total += 1
    await service.upsertCoursesFromSync([{
      courseName: pick(course, 'courseName', 'course_name'),
      teacher: pick(course, 'teacher') || '未知',
      classroom: pick(course, 'classroom') || '',
      dayOfWeek: pick(course, 'dayOfWeek', 'day_of_week'),
      weekRange: pick(course, 'weekRange', 'week_range') || '1-16',
      startTime: hhmm(pick(course, 'startTime', 'start_time')),
      endTime: hhmm(pick(course, 'endTime', 'end_time')),
    }])
    counts.courses.created += 1
  }

  const entryIdMap = new Map()
  const existingEntries = new Map(service.listEntries()
    .map(row => [`${row.title}\u0000${row.start}`, row.id]))
  for (const entry of payload.entries ?? []) {
    counts.entries.total += 1
    const start = withBeijingZone(pick(entry, 'start', 'start_time'))
    const dedupKey = `${entry.title}\u0000${start}`
    if (existingEntries.has(dedupKey)) {
      if (entry.id !== undefined) entryIdMap.set(String(entry.id), existingEntries.get(dedupKey))
      counts.entries.skipped += 1
      continue
    }
    const created = await service.createEntry({
      title: entry.title,
      description: entry.description ?? null,
      category: pick(entry, 'category', 'entry_type') || 'other',
      start,
      end: withBeijingZone(pick(entry, 'end', 'end_time')),
      allDay: entry.allDay === true || undefined,
    }, { allowConflicts: true })
    if (entry.id !== undefined) entryIdMap.set(String(entry.id), created.id)
    counts.entries.created += 1
  }

  const existingTasks = new Set(service.listTasks({ scope: 'all' })
    .map(row => `${row.title}\u0000${row.due}`))
  for (const task of payload.tasks ?? []) {
    counts.tasks.total += 1
    const due = withBeijingZone(pick(task, 'due', 'deadline'))
    if (existingTasks.has(`${task.title}\u0000${due}`)) {
      counts.tasks.skipped += 1
      continue
    }
    const legacyEntryId = pick(task, 'entryId', 'entry_id')
    await service.createTask({
      title: task.title,
      description: task.description ?? null,
      taskType: pick(task, 'taskType', 'task_type') || 'other',
      due,
      priority: priorityOf(pick(task, 'priority')),
      completed: Boolean(task.completed),
      entryId: legacyEntryId === undefined ? null : entryIdMap.get(String(legacyEntryId)) ?? null,
      source: 'import',
    })
    counts.tasks.created += 1
  }

  return counts
}
