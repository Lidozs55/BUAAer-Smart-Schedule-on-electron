/** Shared validation vocabulary for storage, services and Agent tools. */
export const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
export const SOURCE_ID_RE = /^[a-z][a-z0-9_-]*$/
export const TASK_TYPES = ['homework', 'exam', 'lecture', 'other']
export const PRIORITIES = ['high', 'medium', 'low']
export const DEFAULT_CATEGORIES = Object.freeze([
  { id: 'course', name: '课程', color: '#3B82F6' },
  { id: 'homework', name: '作业', color: '#F59E0B' },
  { id: 'exam', name: '考试', color: '#EF4444' },
  { id: 'meeting', name: '会议', color: '#A855F7' },
  { id: 'study', name: '学习', color: '#06B6D4' },
  { id: 'sports', name: '运动', color: '#22C55E' },
  { id: 'other', name: '其它', color: '#64748B' },
].map(Object.freeze))

export const cloneCategories = (categories = DEFAULT_CATEGORIES) => categories.map(category => ({ ...category }))

/** Shared by API writes, backup imports and persisted global validation. */
export function validateCategories(categories) {
  const invalid = message => { throw Object.assign(new Error(message), { code: 'invalid_input' }) }
  if (!Array.isArray(categories)) invalid('categories 必须是数组')
  const ids = new Set()
  const result = categories.map(category => {
    if (!category || typeof category !== 'object' || Array.isArray(category)) invalid('类别必须是对象')
    const { id, name, color } = category
    if (typeof id !== 'string' || !SOURCE_ID_RE.test(id)) invalid('类别 id 必须是合法的稳定标识')
    if (ids.has(id)) invalid(`重复类别 id：${id}`)
    ids.add(id)
    if (typeof name !== 'string' || !name.trim()) invalid('类别名称不能为空')
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) invalid('类别颜色必须是 #RRGGBB')
    if (id === 'other' && name !== '其它') invalid('other 名称必须为“其它”')
    return { id, name: name.trim(), color: color.toUpperCase() }
  })
  if (!ids.has('other')) invalid('必须保留 other 类别')
  return result
}
