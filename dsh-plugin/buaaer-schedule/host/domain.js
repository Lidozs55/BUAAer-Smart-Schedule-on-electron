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
 */
const globalSchema = z.object({
  /** BUAA student id; '' until the user sets it. */
  buaaId: z.string(),
  /** Monday of teaching week 1, `YYYY-MM-DD`; '' until configured. */
  termStart: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  /** Term code last seen from a sync, e.g. `2026-2027-1`; '' if never. */
  termCode: z.string(),
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

export const TASK_TYPES = ['homework', 'exam', 'lecture', 'other']
export const PRIORITIES = ['high', 'medium', 'low']
export const TASK_SOURCES = ['manual', 'buaa_sync', 'agent', 'import']

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
  source: z.enum(TASK_SOURCES),
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
  name: 'buaaer_schedule',
  version: 1,
  tables: {
    courses: domainTable(courseSchema),
    tasks: domainTable(taskSchema),
    entries: domainTable(entrySchema),
  },
  global: {
    schema: globalSchema,
    initial: { buaaId: '', termStart: '', termCode: '' },
  },
})
