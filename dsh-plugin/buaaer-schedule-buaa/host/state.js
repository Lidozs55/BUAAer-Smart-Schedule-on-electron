/**
 * Durable adapter state lives in the schedule core's opaque `sourceState`
 * map — the source plugin owns the shape, the core guarantees persistence.
 */

export const SOURCE_ID = 'buaa'

/**
 * One-shot migration from the v1 schedule domain fields (`buaaId`,
 * `termCode`) into `sourceState.buaa`. Existing profiles keep their student
 * id and term code without re-entering anything.
 */
export async function ensureSourceState(service) {
  const legacy = service.legacyGlobal()
  const state = service.getSourceState(SOURCE_ID)
  const next = { ...state }
  if (!next.buaaId && typeof legacy.buaaId === 'string' && legacy.buaaId !== '') {
    next.buaaId = legacy.buaaId
  }
  if (!next.termCode && typeof legacy.termCode === 'string' && legacy.termCode !== '') {
    next.termCode = legacy.termCode
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) {
    await service.setSourceState(SOURCE_ID, next)
  }
  return next
}

export async function saveSourceState(service, patch) {
  const next = { ...service.getSourceState(SOURCE_ID), ...patch }
  await service.setSourceState(SOURCE_ID, next)
  return next
}
