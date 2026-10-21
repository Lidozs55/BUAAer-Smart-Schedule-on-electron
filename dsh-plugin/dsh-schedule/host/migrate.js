import { cloneCategories } from './model.js'

/** One-time conversion of persisted weekly rules into dated entries. */
const weeksOf = value => {
  if (!/^\d{1,2}(-\d{1,2})?(,\d{1,2}(-\d{1,2})?)*$/.test(value)) throw new Error(`无效周次：${value}`)
  const weeks = new Set()
  for (const part of value.split(',')) {
    const [from, end = from] = part.split('-').map(Number)
    if (from < 1 || end < from || end > 60) throw new Error(`无效周次：${value}`)
    for (let week = from; week <= end; week += 1) weeks.add(week)
  }
  return weeks
}

const dayAfter = (day, offset) => {
  const date = new Date(`${day}T12:00:00Z`)
  if (!Number.isFinite(date.getTime())) throw new Error('迁移需要合法学期起点')
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

export function materializeEntries(rules, overrides, termStart) {
  const anchor = new Date(`${termStart}T12:00:00Z`)
  if (rules.length && (!/^\d{4}-\d{2}-\d{2}$/.test(termStart)
    || !Number.isFinite(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== termStart
    || anchor.getUTCDay() !== 1)) {
    throw new Error('迁移教学安排前请配置有效的学期第一周周一；原始数据未删除')
  }
  const exceptions = new Map(overrides.map(row => [`${row.courseId}@${row.baseDay}`, row]))
  const result = new Map()
  const visited = new Set()
  const append = (rule, day, override) => {
    const key = `${rule.id}@${day}`
    visited.add(key)
    if (override?.canceled) return
    const row = {
      id: `imported-${key}`, title: override?.courseName ?? rule.courseName,
      description: null, location: (override?.classroom ?? rule.classroom) || null,
      category: 'course', lock: true, source: 'buaa',
      sourceKey: `teaching:${rule.courseName}:${day}:${rule.startTime}`,
      start: override?.start ?? `${day}T${rule.startTime}:00+08:00`,
      end: override?.end ?? `${day}T${rule.endTime}:00+08:00`,
      updatedAt: override?.updatedAt ?? rule.updatedAt,
    }
    if (!row.title || !Number.isFinite(Date.parse(row.start)) || !(Date.parse(row.end) > Date.parse(row.start))) {
      throw new Error(`迁移发现无效日程：${key}`)
    }
    // Overlapping week groups describe the same dated event. Prefer the
    // explicit exception if one group supplied it.
    if (!result.has(row.sourceKey) || override) result.set(row.sourceKey, row)
  }
  for (const rule of rules) {
    if (!Number.isInteger(rule.dayOfWeek) || rule.dayOfWeek < 1 || rule.dayOfWeek > 7) throw new Error('迁移发现无效星期')
    for (const week of weeksOf(rule.weekRange)) {
      const day = dayAfter(termStart, (week - 1) * 7 + rule.dayOfWeek - 1)
      const key = `${rule.id}@${day}`
      append(rule, day, exceptions.get(key))
    }
  }
  // Old projection also displayed exceptions after their base week/rule
  // disappeared. They remain real dated events and must not be discarded.
  const ruleById = new Map(rules.map(rule => [rule.id, rule]))
  for (const [key, override] of exceptions) {
    if (visited.has(key)) continue
    const rule = ruleById.get(override.courseId) ?? {
      id: override.courseId, courseName: override.courseName,
      startTime: override.start.slice(11, 16), updatedAt: override.updatedAt,
    }
    append(rule, override.baseDay, override)
  }
  return [...result.values()]
}

export async function migrateEntryData(domain, validateEntry = row => row) {
  const global = domain.global.get()
  const entries = domain.table('entries')
  const rules = [...domain.table('courses').entries()].map(([, row]) => row)
  const overrides = [...domain.table('course_overrides').entries()].map(([, row]) => row)
  // Compute and validate the entire expansion before the first write.
  const generated = materializeEntries(rules, overrides, global.termStart)
  const existing = [...entries.entries()].map(([, row]) => validateEntry({
    ...row, location: row.location ?? null, lock: row.lock ?? false,
    category: row.category,
  }))
  const ids = new Set(cloneCategories(global.categories).map(category => category.id))
  const validated = generated.map(row => validateEntry({ ...row, category: ids.has(row.category) ? row.category : 'other' }))
  for (const row of existing) await entries.put(row.id, row)
  const persistedKeys = new Set(existing.filter(row => row.source === 'buaa').map(row => row.sourceKey))
  for (const row of validated) {
    if (entries.get(row.id) !== undefined || persistedKeys.has(row.sourceKey)) continue
    await entries.put(row.id, row)
    persistedKeys.add(row.sourceKey)
  }
  // Keep original rules intact until every entry is durable; deterministic ids
  // make restarting after any failed write safe.
  for (const name of ['courses', 'course_overrides']) {
    for (const [key] of domain.table(name).entries()) await domain.table(name).delete(key)
  }
  await domain.global.set({ ...global, entryModelVersion: 2 })
  return { generated: generated.length }
}

/** Independent marker: entry-model migration may already have completed. */
export async function migrateCategoryData(domain, validateEntry = row => row) {
  const global = domain.global.get()
  const categories = cloneCategories(global.categories)
  const ids = new Set(categories.map(category => category.id))
  const entries = domain.table('entries')
  const rows = [...entries.entries()].map(([, row]) => {
    let category = row.category
    if (global.categoryModelVersion !== 1 && row.source === 'buaa'
      && row.sourceKey?.startsWith('teaching:') && category === 'study') category = 'course'
    return validateEntry({ ...row, category: ids.has(category) ? category : 'other' })
  })
  for (const row of rows) await entries.put(row.id, row)
  await domain.global.set({ ...global, categories, categoryModelVersion: 1 })
}

export async function openScheduleDomain(storageDomain) {
  const { scheduleDomainSpec, categoriesSchema } = await import('./domain.js')
  const { z } = await import('zod')
  const { domainTable } = await import('@deepseek-ai/dsh-storage-domain')
  const raw = domainTable(z.record(z.string(), z.unknown()))
  const transitional = {
    ...scheduleDomainSpec,
    global: {
      schema: z.object({
        termStart: z.string(), sourceState: z.record(z.string(), z.string()).default({}),
        entryModelVersion: z.number().optional(), categoryModelVersion: z.number().optional(),
        categories: categoriesSchema.optional(),
      }),
      initial: { termStart: '', sourceState: {} },
    },
    tables: { ...scheduleDomainSpec.tables, entries: raw, courses: raw, course_overrides: raw },
  }
  const domain = await storageDomain.open(transitional)
  try {
    if (domain.global.get().entryModelVersion !== 2) {
      await migrateEntryData(domain, row => scheduleDomainSpec.tables.entries.valueSchema.parse(row))
    }
    if (domain.global.get().categoryModelVersion !== 1 || domain.global.get().categories === undefined) {
      await migrateCategoryData(domain, row => scheduleDomainSpec.tables.entries.valueSchema.parse(row))
    }
  } finally {
    await domain.close()
  }
  return storageDomain.open(scheduleDomainSpec)
}
