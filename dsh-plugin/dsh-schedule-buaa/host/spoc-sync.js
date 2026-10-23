/**
 * Reconcile SPOC assignments into core homework tasks.
 *
 * SPOC is the only BUAA source that produces repeating, dated work: an
 * assignment keeps its identity until it is submitted, but its deadline can be
 * extended. The core task is therefore matched by a normalized
 * "course + assignment" title, and only `due` is corrected for tasks the user
 * created by hand; fields owned by this source are refreshed in full.
 *
 * Two deliberate limits:
 * - Submitted assignments never become tasks. A submitted item is history, not
 *   work, and creating it would only add reminder noise.
 * - Deletion is bounded to this source and to the current term anchor. Without
 *   an anchor we cannot tell a previous term's completed work from a vanished
 *   assignment, so deletion is skipped entirely.
 */
export const SPOC_SOURCE_ID = 'spoc'

/** @param {object} assignment - parsed SPOC assignment. */
export function spocTaskTitle(assignment) {
  return `${assignment.courseName} 作业：${assignment.title}`
}

function spocTaskDescription(assignment) {
  return [
    `课程：${assignment.courseName}`,
    assignment.teacherName ? `教师：${assignment.teacherName}` : null,
    assignment.score ? `满分：${assignment.score}` : null,
  ].filter(part => part !== null).join('；')
}

/** Whitespace/case-insensitive identity, so a hand-typed title still matches. */
export function normalizedTitle(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

const dayOf = task => String(task.due ?? '').slice(0, 10)

/**
 * @param {object} deps - `{ service }`.
 * @param {object} feed - result of `fetchAssignments` / `refreshAssignments`.
 * @param {{ termStart?: string }} [options] - term anchor used to bound deletion.
 * @returns {Promise<{ created: number, updated: number, removed: number,
 *   total: number, submitted: number, skipped: number, duplicates: number }>}
 */
export async function syncSpocTasks({ service }, feed, { termStart = '' } = {}) {
  const drafts = []
  const draftByKey = new Map()
  let duplicates = 0

  for (const assignment of feed.assignments ?? []) {
    const fields = {
      title: spocTaskTitle(assignment),
      description: spocTaskDescription(assignment),
      due: assignment.due,
      taskType: 'homework',
    }
    const key = normalizedTitle(fields.title)
    const draft = draftByKey.get(key)
    if (draft === undefined) {
      const created = { key, ...fields }
      draftByKey.set(key, created)
      drafts.push(created)
      continue
    }
    // Two assignments with the same course/name in one term are rare, but a
    // title-only identity cannot tell them apart. Keep the earliest deadline
    // instead of silently thrashing one task.
    duplicates += 1
    if (fields.due < draft.due) Object.assign(draft, fields)
  }

  // Group instead of overwrite: a manual task and a source-owned task can share
  // a title, and the owned one must win so its fields are refreshed instead of
  // duplicated.
  const existingByKey = new Map()
  for (const task of service.listTasks({ scope: 'all' })) {
    const key = normalizedTitle(task.title)
    const bucket = existingByKey.get(key)
    if (bucket === undefined) existingByKey.set(key, [task])
    else bucket.push(task)
  }

  let created = 0
  let updated = 0
  for (const { key, ...fields } of drafts) {
    const bucket = existingByKey.get(key)
    if (bucket === undefined) {
      await service.createTask({ ...fields, source: SPOC_SOURCE_ID })
      created += 1
      continue
    }
    const index = bucket.findIndex(task => task.source === SPOC_SOURCE_ID)
    const [existing] = bucket.splice(index === -1 ? 0 : index, 1)
    const owned = existing.source === SPOC_SOURCE_ID
    const stale = existing.due !== fields.due
      || (owned && (existing.title !== fields.title
        || existing.description !== fields.description
        || existing.taskType !== fields.taskType))
    if (!stale) continue
    await service.updateTask(existing.id, owned ? fields : { due: fields.due })
    updated += 1
  }

  let removed = 0
  if (termStart !== '') {
    for (const bucket of existingByKey.values()) {
      for (const leftover of bucket) {
        if (leftover.source !== SPOC_SOURCE_ID) continue
        if (dayOf(leftover) < termStart) continue
        await service.deleteTask(leftover.id)
        removed += 1
      }
    }
  }

  return {
    created,
    updated,
    removed,
    total: drafts.length,
    submitted: feed.submitted ?? 0,
    skipped: feed.skipped ?? 0,
    duplicates,
  }
}
