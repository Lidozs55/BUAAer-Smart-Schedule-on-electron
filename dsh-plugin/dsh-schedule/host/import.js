/**
 * Full-domain import for the shape this plugin's own export produces
 * (`settings.section` → export JSON). Round-tripping an export must work.
 */
import { PRIORITIES } from './model.js'

const priorityOf = value => (PRIORITIES.includes(value) ? value : 'medium')

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * @param {object} service - the schedule service.
 * @param {object} payload - `{ global?, entries?, tasks? }`.
 * @returns {object} per-table reconciliation counts.
 */
export async function importSchedulePayload(service, payload) {
  if (!isObject(payload)) {
    throw Object.assign(new Error('导入载荷不是对象'), { code: 'invalid_input' })
  }
  const unsupported = Object.keys(payload).filter(key => !['global', 'entries', 'tasks'].includes(key))
  if (unsupported.length > 0) {
    throw Object.assign(new Error(`不支持的导入字段：${unsupported.join('、')}；请使用当前条目格式`), { code: 'invalid_input' })
  }
  for (const table of ['entries', 'tasks']) {
    if (payload[table] !== undefined && !Array.isArray(payload[table])) {
      throw Object.assign(new Error(`${table} 必须是数组`), { code: 'invalid_input' })
    }
  }
  const counts = {
    entries: { total: 0, created: 0, skipped: 0 },
    tasks: { total: 0, created: 0, skipped: 0 },
  }

  const termStart = payload.global?.termStart
  if (typeof termStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(termStart)
      && service.getMeta().termStart === '') {
    await service.setMeta({ termStart })
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
      location: entry.location ?? null,
      lock: entry.lock ?? false,
      source: entry.source,
      sourceKey: entry.sourceKey,
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
