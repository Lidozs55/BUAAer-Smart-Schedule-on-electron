/**
 * Side-effect core of the schedule ⇄ vivarium bridge (docs 09 v2).
 *
 * Kept separate from index.js so tests can exercise the bridge without the
 * host-only `@deepseek-ai/schemastery` peer (the Config schema is the only
 * thing that needs it). `attachBridge` receives the already-validated config.
 */

/** One poll cycle of the reminder watch — also the max earliness of a bubble. */
const WATCH_LEAD_MS = 60_000
const NOTICE_TTL_MS = 30 * 60_000
const REPORT_INTERVAL_MS = 5 * 60_000
/** How long the user has to confirm a pet drop before it is discarded. */
const DROP_CONFIRM_TTL_MS = 30_000
/** How long a pet bubble waits for the user before the session UI takes over. */
const ASK_TTL_MS = 60_000
/** How long a delivered session stays pet-answerable without a new request. */
const SESSION_WATCH_MS = 10 * 60_000

const TYPE_LABELS = { homework: '作业', exam: '考试', lecture: '听课', other: '截止事项' }

/** `YYYY-MM-DD` local day key (bundle-local; cannot import the main plugin). */
const dayKey = date => {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const shortTime = iso => iso.replace('T', ' ').slice(0, 16)

const truncate = (text, cap) => (text.length > cap ? text.slice(0, cap - 1) + '…' : text)

export function attachBridge(ctx, config) {
  const service = ctx.scheduleCore
  const vivarium = ctx.vivarium
  const raised = new Set() // notice ids posted during this activation

  // -- reminder notices -------------------------------------------------------
  // Per-kind presentation over ONE derived set (docs 09 §2.1): tasks can be
  // completed from the bubble; entries are informational (「知道了」
  // only). `key` (taskId / entry-<id>) is the
  // deterministic dedup id — date-scoped where the source repeats, so the
  // bridge keeps no memory beyond the `raised` set.
  const noticeFor = reminder => {
    if (reminder.kind === 'entry') {
      const label = service.getMeta().categories.find(category => category.id === reminder.category)?.name ?? '日程'
      const when = reminder.allDay
        ? `${reminder.start.slice(0, 10)} 全天`
        : `将于 ${shortTime(reminder.start)} 开始`
      return {
        text: `「${label}」${truncate(reminder.title, 40)} ${when}${reminder.location ? `（${reminder.location}）` : ''}，记得参加～`,
        actions: [{ id: 'ack', label: { zh: '知道了', en: 'Got it' } }],
      }
    }
    const typeLabel = TYPE_LABELS[reminder.taskType] ?? TYPE_LABELS.other
    return {
      text: `「${truncate(reminder.title, 40)}」将于 ${shortTime(reminder.due)} 截止（${typeLabel}），记得处理～`,
      actions: [
        { id: 'ack', label: { zh: '知道了', en: 'Got it' } },
        { id: 'complete', label: { zh: '已完成', en: 'Done' } },
      ],
    }
  }

  const watchReminders = () => {
    if (!config.noticeOnReminder) return
    const now = Date.now()
    for (const reminder of service.upcomingReminders()) {
      const at = Date.parse(reminder.at)
      // Fire inside the [at-60s, at+60s] window: one poll may straddle the
      // moment; earlier than that stays silent, later is already gone from
      // the derived set.
      if (at - now > WATCH_LEAD_MS || now - at > WATCH_LEAD_MS) continue
      const id = `sched-rem-${reminder.key ?? reminder.taskId}`
      if (raised.has(id)) continue
      const notice = noticeFor(reminder)
      const posted = vivarium.notices.post({
        id,
        text: notice.text,
        actions: notice.actions,
        ttlMs: NOTICE_TTL_MS,
        source: 'schedule-bridge',
      })
      if (!posted.ok) {
        // duplicate-id = this reminder already has a live bubble.
        if (posted.code === 'duplicate-id') raised.add(id)
        continue
      }
      raised.add(id)
      // The tapped action id settles the promise (`ack` / `complete` / `expired`).
      vivarium.notices.settled(id).then(outcome => {
        if (outcome === 'complete') {
          service.setTaskCompleted(reminder.taskId, true)
            .catch(error => ctx.logger.warn('schedule-bridge: complete-from-bubble failed: %s', error.message))
        }
      }).catch(() => {})
    }
  }

  // -- task state report -------------------------------------------------------
  // Facts only (counts + next deadline): pet semantics — the overdue worry
  // edge and the all-clear celebration — are the BASE's to derive (§4c
  // tasks.report). This bridge translates its domain into the base
  // vocabulary once and remembers nothing (the old prevPending/cleared
  // tracking was base state memory sunk into the wrong layer).
  const canReportTasks = typeof vivarium.tasks?.report === 'function'
  if (config.statusSignals && !canReportTasks) {
    ctx.logger.warn('schedule-bridge: host vivarium lacks tasks.report (contract §4c) — task status reporting disabled')
  }
  const reportTasks = () => {
    if (!config.statusSignals || !canReportTasks) return
    const now = Date.now()
    const today = dayKey(new Date())
    let overdue = 0
    let dueToday = 0
    let later = 0
    let next = null
    for (const task of service.listTasks({ scope: 'all', includeCompleted: false })) {
      const dueMs = Date.parse(task.due)
      if (dueMs < now) {
        overdue += 1
        continue
      }
      if (task.due.slice(0, 10) === today) dueToday += 1
      else later += 1
      if (next === null || dueMs < Date.parse(next.due)) next = task
    }
    vivarium.tasks.report({
      pending: overdue + dueToday + later,
      overdue,
      dueToday,
      next: next === null ? null : { title: next.title, due: next.due },
    })
  }

  // -- dropped content staging -------------------------------------------------
  // The base hands us one validated payload (text, images or both). We stage
  // it as pending and raise a notice with an explicit 「确认」 action: that
  // button is the user's hand-off, and it opens a new Agent session directly
  // — no clipboard step. 「取消」/expiry discards the row. The schedule client
  // polls only confirmed rows, builds the same prompt as the clipboard panel
  // and acks after the prompt is accepted. Nothing here parses text or OCRs
  // images.
  const canReceiveDrops = typeof vivarium.drops?.onDrop === 'function'
    || typeof vivarium.drops?.onText === 'function'
  const dropbox = service.dropbox
  const canStoreDrops = typeof dropbox?.stage === 'function'
    && typeof dropbox?.confirm === 'function'
    && typeof dropbox?.discard === 'function'
  if (config.dropToAgent && (!canReceiveDrops || !canStoreDrops)) {
    ctx.logger.warn(
      'schedule-bridge: drop hand-off unavailable (base lacks vivarium.drops.onDrop/onText or main plugin lacks the confirmable dropbox) — pet drops ignored',
    )
  }

  const dropNoticeText = drop => {
    const images = Array.isArray(drop.images) ? drop.images : []
    const imageCount = images.length === 1 ? '一张图片' : `${images.length} 张图片`
    const names = images
      .map(image => (typeof image.name === 'string' ? truncate(image.name, 20) : ''))
      .filter(name => name !== '')
    const imageDetail = names.length === 0 ? '' : `（${names.join('、')}）`
    const preview = typeof drop.text === 'string' ? truncate(drop.text.replace(/\s+/g, ' '), 48) : ''
    if (preview !== '' && images.length > 0) {
      return `收到一段文本和${imageCount}${imageDetail}：「${preview}」。点「确认」直接新建会话；有明确时间的会直接写入，没有的 Agent 会先来问你。`
    }
    if (preview !== '') {
      return `收到一段文本：「${preview}」。点「确认」直接新建会话；有明确时间的会直接写入，没有的 Agent 会先来问你。`
    }
    return `收到${imageCount}${imageDetail}。点「确认」直接新建会话；有明确时间的会直接写入，没有的 Agent 会先来问你。`
  }

  const stageDrop = drop => {
    const row = dropbox.stage(drop)
    if (row === null) return
    let posted
    try {
      posted = vivarium.notices.post({
        id: `sched-drop-${row.id}`,
        text: dropNoticeText(drop),
        actions: [
          { id: 'confirm', label: { zh: '确认', en: 'Confirm' } },
          { id: 'deny', label: { zh: '取消', en: 'Cancel' } },
        ],
        ttlMs: DROP_CONFIRM_TTL_MS,
        source: 'schedule-bridge',
      })
    } catch (error) {
      dropbox.discard(row.id)
      ctx.logger.warn('schedule-bridge: drop notice failed: %s', error.message)
      return
    }
    if (!posted?.ok) {
      dropbox.discard(row.id)
      ctx.logger.warn('schedule-bridge: drop notice rejected: %s', posted?.code ?? 'unknown')
      return
    }
    vivarium.notices.settled(posted.id).then(outcome => {
      if (outcome === 'confirm') {
        if (!dropbox.confirm(row.id)) {
          ctx.logger.warn('schedule-bridge: confirmed drop %s was already gone', row.id)
        }
      } else {
        dropbox.discard(row.id)
      }
    }).catch(error => {
      // No answer will arrive; never leave a row the client might deliver.
      dropbox.discard(row.id)
      ctx.logger.warn('schedule-bridge: drop confirmation failed: %s', error.message)
    })
  }

  ctx.effect(() => {
    if (!config.dropToAgent || !canReceiveDrops || !canStoreDrops) return () => {}
    const handler = drop => {
      try {
        stageDrop(drop)
      } catch (error) {
        ctx.logger.warn('schedule-bridge: drop staging failed: %s', error.message)
      }
    }
    try {
      if (typeof vivarium.drops?.onDrop === 'function') return vivarium.drops.onDrop(handler)
      return vivarium.drops.onText(text => handler({ text }))
    } catch (error) {
      ctx.logger.warn('schedule-bridge: drop subscriber registration failed: %s', error.message)
      return () => {}
    }
  }, 'schedule-bridge: drop hand-off')

  // -- session question relay ---------------------------------------------------
  // A confirmed drop becomes an Agent session, and the quick-create chain is
  // only complete if the user can answer that session FROM the pet. The
  // bridge subscribes (prepended, ahead of the platform's UI forwarder) to
  // the two DSH answerer waterfalls and claims requests whose
  // `agent.session` it watches:
  //
  //   user-questions/request → pet notice carrying the question, with the
  //     question's own two option labels as buttons; the tapped label is
  //     returned as the structured answer. Free-text, multi-option or
  //     multi-question shapes are NOT claimed — the session UI answers those.
  //   approval/request       → pet notice 「确认 / 拒绝」 mapping to
  //     'allowed-once' / 'rejected'.
  //
  // An unanswered bubble (TTL, dismissal, post failure) delegates via next()
  // so the platform UI takes over; a tapped option IS the answer, never a
  // delegation. Watching lapses SESSION_WATCH_MS after the last request, so
  // ordinary later work in the same session is left to the session UI.
  const canFollowSessions = typeof dropbox?.onDelivered === 'function'
  if (config.dropToAgent && !canFollowSessions) {
    ctx.logger.warn(
      'schedule-bridge: main plugin lacks dropbox.onDelivered — pet drops still open sessions, but their questions stay in the session UI',
    )
  }
  const watched = new Map() // sessionId → expiresAt (ms); pruned lazily
  const isWatched = (sessionId) => {
    const expiresAt = watched.get(sessionId)
    if (expiresAt === undefined) return false
    if (expiresAt < Date.now()) {
      watched.delete(sessionId)
      return false
    }
    return true
  }
  const rewound = () => Date.now() + SESSION_WATCH_MS
  if (config.dropToAgent && canFollowSessions) {
    ctx.effect(() => dropbox.onDelivered(sessionId => {
      watched.set(sessionId, rewound())
    }), 'schedule-bridge: session watch')
  }

  /** Ask one yes/no-shaped thing on the pet; resolve the tapped action id, or null to delegate. */
  const askOnPet = (notice) => {
    let posted
    try {
      posted = vivarium.notices.post(notice)
    } catch (error) {
      ctx.logger.warn('schedule-bridge: ask notice failed: %s', error.message)
      return Promise.resolve(null)
    }
    if (!posted?.ok) {
      ctx.logger.warn('schedule-bridge: ask notice rejected: %s', posted?.code ?? 'unknown')
      return Promise.resolve(null)
    }
    return vivarium.notices.settled(posted.id)
      .then(outcome => (outcome === 'confirm' || outcome === 'deny') ? outcome : null)
      .catch(() => null)
  }

  const claimableQuestion = (request) => {
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length !== 1) return null
    const question = questions[0]
    if (question === null || typeof question !== 'object') return null
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length !== 2 || question.multiSelect === true) return null
    const labels = options.map(option => (typeof option?.label === 'string' ? option.label : ''))
    if (labels.some(label => label === '')) return null
    return { question, labels }
  }

  ctx.effect(() => {
    if (!config.dropToAgent || !canFollowSessions || typeof ctx.on !== 'function') return () => {}
    let seq = 0

    const onQuestion = async (request, next) => {
      const sessionId = request?.agent?.session
      if (sessionId === undefined || !isWatched(sessionId)) return next()
      const claim = claimableQuestion(request)
      if (claim === null) return next()
      watched.set(sessionId, rewound())
      const outcome = await askOnPet({
        id: `sched-ask-${++seq}`,
        text: `Agent 想确认：「${truncate(claim.question.question, 60)}」`,
        actions: [
          { id: 'confirm', label: { zh: claim.labels[0], en: claim.labels[0] } },
          { id: 'deny', label: { zh: claim.labels[1], en: claim.labels[1] } },
        ],
        ttlMs: ASK_TTL_MS,
        source: 'schedule-bridge',
      })
      if (outcome === null) return next()
      // The buttons carry the question's real option labels, so the tapped
      // button IS the chosen answer regardless of option order.
      return {
        answers: [{
          id: claim.question.id,
          selected: [claim.labels[outcome === 'confirm' ? 0 : 1]],
        }],
      }
    }

    const onApproval = async (request, next) => {
      const sessionId = request?.agent?.session
      if (sessionId === undefined || !isWatched(sessionId)) return next()
      watched.set(sessionId, rewound())
      const reason = typeof request.reason === 'string' && request.reason !== ''
        ? `：${truncate(request.reason, 60)}`
        : ''
      const outcome = await askOnPet({
        id: `sched-ask-${++seq}`,
        text: `Agent 请求执行「${request.toolName ?? '操作'}」${reason}。`,
        actions: [
          { id: 'confirm', label: { zh: '确认', en: 'Allow' } },
          { id: 'deny', label: { zh: '拒绝', en: 'Deny' } },
        ],
        ttlMs: ASK_TTL_MS,
        source: 'schedule-bridge',
      })
      if (outcome === null) return next()
      return outcome === 'confirm' ? 'allowed-once' : 'rejected'
    }

    // Prepend: sit ahead of the platform's UI forwarder so watched sessions
    // surface on the pet first; everything else falls through untouched.
    const disposeQuestion = ctx.on('user-questions/request', onQuestion, { prepend: true })
    const disposeApproval = ctx.on('approval/request', onApproval, { prepend: true })
    return () => {
      disposeQuestion()
      disposeApproval()
    }
  }, 'schedule-bridge: session relay')

  ctx.effect(() => {
    const disposeWatch = vivarium.every(WATCH_LEAD_MS, () => {
      try {
        watchReminders()
      } catch (error) {
        ctx.logger.warn('schedule-bridge: reminder watch failed: %s', error.message)
      }
      const now = Date.now()
      for (const [sessionId, expiresAt] of watched) {
        if (expiresAt < now) watched.delete(sessionId)
      }
    })
    const disposeReport = vivarium.every(REPORT_INTERVAL_MS, () => {
      try {
        reportTasks()
      } catch (error) {
        ctx.logger.warn('schedule-bridge: task report failed: %s', error.message)
      }
    })
    return () => {
      disposeWatch()
      disposeReport()
    }
  }, 'schedule-bridge: timers')

  ctx.effect(() => {
    const dispose = service.subscribe(event => {
      try {
        if (config.statusSignals) {
          vivarium.emit({ type: 'sched.data.changed', payload: { tables: event.tables } })
        }
        reportTasks()
      } catch (error) {
        ctx.logger.warn('schedule-bridge: change handling failed: %s', error.message)
      }
    })
    return dispose
  }, 'schedule-bridge: subscription')

  watchReminders()
  reportTasks()
  ctx.logger.info('schedule-bridge: schedule ⇄ vivarium bridge active')
}
