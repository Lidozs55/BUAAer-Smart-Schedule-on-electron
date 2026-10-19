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

/** `YYYY-MM-DDTHH:mm:ss(.sss)?(Z|±HH:MM)` — offset is mandatory. */
export const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

const isoDateTime = z.string().regex(ISO_DATETIME_RE)
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/** `N`, `N-M` or a comma list of those, e.g. `1-16`, `1,3,5-8`. */
export const WEEK_RANGE_RE = /^\d{1,2}(-\d{1,2})?(,\d{1,2}(-\d{1,2})?)*$/

/**
 * Global singletons may not be nullable (null is the backend's "never
 * written" sentinel), so unset facts are the empty string.
 *
 * `sourceState` is the extension point for import-source plugins: each
 * source owns one JSON string under its own key. The schedule core never
 * interprets those values, so adding a source needs no schema change.
 */
const globalSchema = z.object({
  /** Monday of teaching week 1, `YYYY-MM-DD`; '' until configured. */
  termStart: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  /** Per-source adapter state: source id → JSON string. */
  sourceState: z.record(z.string(), z.string()).default({}),
})

const courseSchema = z.object({
  id: z.string().min(1),
  courseName: z.string().min(1),
  teacher: z.string(),
  classroom: z.string(),
  /** 1 (Monday) … 7 (Sunday). */
  dayOfWeek: z.number().int().min(1).max(7),
  /** Teaching-week grammar, see WEEK_RANGE_RE. */
  weekRange: z.string().regex(WEEK_RANGE_RE),
  startTime: hhmm,
  endTime: hhmm,
  updatedAt: isoDateTime,
})

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * One manual exception to a synced weekly course rule (holiday make-up,
 * room/time change, cancellation). Keyed by `courseId@baseDay`, where
 * `baseDay` is the projection day the exception was created from, so the
 * rule itself stays untouched and a later sync never overwrites the edit.
 */
const courseOverrideSchema = z.object({
  id: z.string().min(1),
  courseId: z.string().min(1),
  baseDay: dayKey,
  courseName: z.string().min(1),
  teacher: z.string(),
  classroom: z.string(),
  start: isoDateTime,
  end: isoDateTime,
  canceled: z.boolean(),
  updatedAt: isoDateTime,
})

export const TASK_TYPES = ['homework', 'exam', 'lecture', 'other']
export const PRIORITIES = ['high', 'medium', 'low']

/**
 * Tasks may be tagged by any source plugin, so the source is an open id
 * rather than a fixed enum: `manual`, `import`, `agent`, `source_sync`, or a
 * future source's own id. The shape matches source-state ids on purpose.
 */
export const SOURCE_ID_RE = /^[a-z][a-z0-9_-]*$/
/** @deprecated Built-in tags for reference only; the schema accepts any id. */
export const TASK_SOURCES = ['manual', 'source_sync', 'agent', 'import']

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

export const ENTRY_CATEGORIES = [
  'course', 'homework', 'exam', 'meeting', 'study', 'sports', 'other',
]

const entrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable(),
  category: z.enum(ENTRY_CATEGORIES),
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
    courses: domainTable(courseSchema),
    // Additive table: existing stores open unchanged (no records to migrate).
    // Table names are storage-domain unit identifiers and must match
    // /^[a-z][a-z0-9_]*$/ — camelCase fails `defineDomain` at import time,
    // which would keep the whole plugin (host and client) from activating.
    course_overrides: domainTable(courseOverrideSchema),
    tasks: domainTable(taskSchema),
    entries: domainTable(entrySchema),
  },
  global: {
    schema: globalSchema,
    initial: { termStart: '', sourceState: {} },
  },
})
