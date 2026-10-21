/** Shared validation vocabulary for storage, services and Agent tools. */
export const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
export const SOURCE_ID_RE = /^[a-z][a-z0-9_-]*$/
export const TASK_TYPES = ['homework', 'exam', 'lecture', 'other']
export const PRIORITIES = ['high', 'medium', 'low']
export const ENTRY_CATEGORIES = ['homework', 'exam', 'meeting', 'study', 'sports', 'other']
