/**
 * Durable adapter state lives in the schedule core's opaque `sourceState`
 * map — the source plugin owns the shape, the core guarantees persistence.
 *
 * Shape: `{ buaaId, termCode }`. It is written for display only (which
 * account and term the current timetable came from); the term anchor and
 * every course live in the core. No password, cookie or session is stored
 * anywhere: a timetable is fetched once per term, so the next sync simply
 * asks again.
 */

export const SOURCE_ID = 'buaa'