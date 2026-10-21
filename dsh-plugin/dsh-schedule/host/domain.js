/**
 * Storage domain declaration for the schedule plugin.
 *
 * Time semantics (the ONE rule): every persisted datetime is an ISO 8601
 * string with an explicit UTC offset (e.g. `2026-10-19T08:00:00+08:00`).
 * Naive datetimes are rejected at the durable boundary on purpose — the
 * legacy app's "local time stored as UTC" bug must not come back.
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

import { cloneCategories, ISO_DATETIME_RE, PRIORITIES, SOURCE_ID_RE, TASK_TYPES, validateCategories } from './model.js'

const isoDateTime = z.string().regex(ISO_DATETIME_RE)

/**
 * Global singletons may not be nullable (null is the backend's "never
 * written" sentinel), so unset facts are the empty string.
 *
 * `sourceState` is the extension point for import-source plugins: each
 * source owns one JSON string under its own key. The schedule core never
 * interprets those values, so adding a source needs no schema change.
 */
export const categoriesSchema = z.array(z.object({
  id: z.string(), name: z.string(), color: z.string(),
})).transform((value, ctx) => {
  try { return validateCategories(value) } catch (error) {
    ctx.addIssue({ code: 'custom', message: error.message })
    return z.NEVER
  }
})

const globalSchema = z.object({
  /** Monday of teaching week 1, `YYYY-MM-DD`; '' until configured. */
  termStart: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  entryModelVersion: z.literal(2),
  categoryModelVersion: z.literal(1),
  categories: categoriesSchema.default(cloneCategories),
  /** Per-source adapter state: source id → JSON string. */
  sourceState: z.record(z.string(), z.string()).default({}),
})

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  taskType: z.enum(TASK_TYPES),
  /** Deadline; always present in this model. */
  due: isoDateTime,
  priority: z.enum(PRIORITIES),
  completed: z.boolean(),
  /** Key of the linked entry in `entries`, or null. */
  entryId: z.string().nullable(),
  source: z.string().regex(SOURCE_ID_RE),
  updatedAt: isoDateTime,
})

const entrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  location: z.string().nullable(),
  lock: z.boolean(),
  source: z.string().regex(SOURCE_ID_RE).nullable().optional(),
  sourceKey: z.string().nullable().optional(),
  category: z.string().min(1),
  start: isoDateTime,
  end: isoDateTime,
  /** Whole-day flag; start/end then carry the day at midnight. */
  allDay: z.boolean().optional(),
  /** Key of the linked task in `tasks`, when created from one. */
  taskId: z.string().nullable().optional(),
  updatedAt: isoDateTime,
})

export const scheduleDomainSpec = defineDomain({
  name: 'schedule_core',
  version: 1,
  tables: {
    tasks: domainTable(taskSchema),
    entries: domainTable(entrySchema),
  },
  global: {
    schema: globalSchema,
    initial: { termStart: '', sourceState: {}, entryModelVersion: 2, categoryModelVersion: 1, categories: cloneCategories() },
  },
})
