/**
 * Durable adapter state lives in the schedule core's opaque `sourceState`
 * map — the source plugin owns the shape, the core guarantees persistence.
 *
 * Shape:
 * `{ buaaId, termCode, spocEnabled, spocTermCode, spocLastSyncAt, spocError,
 *    signinError }`.
 * It is written for display and opt-out only (which account/term the current
 * timetable came from, whether SPOC homework sync is on, when it last
 * succeeded, and the last error). The term anchor and every dated entry/task
 * live in the core.
 *
 * No password, cookie or token is stored here. The SPOC session (bearer token
 * + cookie jar) lives in `host/spoc.js` module memory and dies with the host
 * process; the iclass check-in session (userId + sessionId) lives in
 * `host/signin.js` memory. After a restart one manual sync re-establishes
 * both.
 */

export const SOURCE_ID = 'buaa'
