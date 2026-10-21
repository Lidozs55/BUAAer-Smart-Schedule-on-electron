/**
 * CalendarPanel: the `main` panel behind key `schedule-calendar` — a
 * narrow-layout shell with three inline tabs (日程 | 任务 | 剪贴板,
 * decisions R3 + R8-rework). The week window anchor lives HERE (docs/10
 * P8) so it survives tab switches: the window is "anchor day .. +6",
 * anchored on today (before 04:00, yesterday), not on Monday.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.calendar.js',
  factory: (require) => {
    const core = require('@lidozs55/dsh-schedule/client.core.js')
    const grid = require('@lidozs55/dsh-schedule/client.gridmath.js')
    const { React, h, addDays, zonedAt, pad2, dateKey } = core
    const { useState, useCallback, useEffect } = React
    const { useScheduleData, useUndo, ConfirmDialog } = core
    const { WeekGrid } = require('@lidozs55/dsh-schedule/client.weekgrid.js')
    const { EventEditor, BatchEditor } = require('@lidozs55/dsh-schedule/client.editors.js')
    const { TasksTab } = require('@lidozs55/dsh-schedule/client.tasks.js')
    const { ClipboardTab } = require('@lidozs55/dsh-schedule/client.clipboard.js')

    const DAY_MS = 86_400_000
    const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

    // -- quick-jump mini calendar (legacy 快速跳转小日历) ----------------------
    const MC_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

    const shiftMonth = (cursor, delta) => {
      const date = new Date(cursor.year, cursor.month + delta, 1)
      return { year: date.getFullYear(), month: date.getMonth() }
    }

    /** Month grid with up to three actual category-color dots per day. */
    function MiniCalendar({ t, api, onJump, categories }) {
      const now = new Date()
      const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })
      const [dayCategories, setDayCategories] = useState({})

      useEffect(() => {
        let alive = true
        const first = new Date(cursor.year, cursor.month, 1)
        const last = new Date(cursor.year, cursor.month + 1, 0)
        // Monday anchors covering [first, last] under the 04:00 display day.
        const anchors = []
        let anchor = new Date(first.getFullYear(), first.getMonth(), first.getDate() - ((first.getDay() + 6) % 7))
        while (anchor <= last) {
          anchors.push(dateKey(anchor))
          anchor = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7)
        }
        Promise.all(anchors.map(week => api.snapshot(week).catch(() => null)))
          .then(snapshots => {
            if (!alive) return
            const byDay = {}
            // Adjacent windows overlap in their 0–4 tail; count each row once.
            const seen = new Set()
            for (const snapshot of snapshots) {
              for (const entry of snapshot?.entries ?? []) {
                if (seen.has(entry.id)) continue
                seen.add(entry.id)
                const key = grid.gridDay(entry.start)
                const id = core.categoryId(entry.category, categories)
                const ids = byDay[key] ??= []
                if (!ids.includes(id) && ids.length < 3) ids.push(id)
              }
            }
            setDayCategories(byDay)
          })
        return () => { alive = false }
      }, [api, cursor, categories])

      const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate()
      const leading = new Date(cursor.year, cursor.month, 1).getDay() // Sunday-first, like the original
      const todayKey = dateKey(new Date())
      const cells = [
        ...Array.from({ length: leading }, (_, i) =>
          h('div', { key: `e${i}`, className: 'bsch-mc-day is-empty' })),
        ...Array.from({ length: daysInMonth }, (_, i) => {
          const key = `${cursor.year}-${pad2(cursor.month + 1)}-${pad2(i + 1)}`
          const ids = dayCategories[key] ?? []
          return h('div', {
            key,
            className: [
              'bsch-mc-day',
              key === todayKey ? 'is-today' : '',
              ids.length ? 'has-dot' : '',
            ].filter(Boolean).join(' '),
            onClick: () => onJump(key),
          }, String(i + 1), h('span', { className: 'bsch-mc-dots' }, ids.map(id =>
            h('span', { key: id, className: 'bsch-mc-dot', title: core.categoryName(id, categories),
              style: { background: core.categoryColor(id, categories) } }))))
        }),
      ]
      return h('div', { className: 'bsch-mc' },
        h('div', { className: 'bsch-mc-head' },
          h('button', {
            className: 'bsch-btn', title: t('toolbar.prev'),
            onClick: () => setCursor(c => shiftMonth(c, -1)),
          }, '‹'),
          h('span', { className: 'bsch-mc-month' },
            t('minical.month')
              .replace('{year}', String(cursor.year))
              .replace('{month}', pad2(cursor.month + 1))),
          h('button', {
            className: 'bsch-btn', title: t('toolbar.next'),
            onClick: () => setCursor(c => shiftMonth(c, 1)),
          }, '›')),
        h('div', { className: 'bsch-mc-weekdays' },
          MC_WEEKDAYS.map(day => h('span', { key: day }, day))),
        h('div', { className: 'bsch-mc-grid' }, cells))
    }

    /** The week-range badge doubles as the quick-jump trigger (R10-1). */
    function QuickJump({ t, api, weekStart, onJump, categories }) {
      const [open, setOpen] = useState(false)
      const range = `${weekStart.slice(5)} ~ ${addDays(weekStart, 6).slice(5)}`
      return h('div', { className: 'bsch-popanchor' },
        h('button', {
          className: `bsch-badge bsch-badge-btn${open ? ' is-active' : ''}`,
          onClick: () => setOpen(value => !value),
          title: t('minical.title'),
        }, range),
        open ? h('div', { className: 'bsch-pop-mask', onClick: () => setOpen(false) }) : null,
        open ? h('div', { className: 'bsch-popover' },
          h(MiniCalendar, {
            t, api, categories,
            onJump: day => { setOpen(false); onJump(day) },
          })) : null)
    }

    function UpcomingStrip({ t, tasks, today }) {
      const now = Date.now()
      const dueMs = task => new Date(task.due).getTime()
      const upcoming = tasks
        .filter(task => !task.completed && dueMs(task) >= now && dueMs(task) <= now + DAY_MS)
        .sort((a, b) => dueMs(a) - dueMs(b)).slice(0, 6)
      if (upcoming.length === 0) {
        return h('div', { className: 'bsch-strip' },
          h('span', { className: 'bsch-hint' }, t('strip.empty')))
      }
      return h('div', { className: 'bsch-strip' },
        h('span', { className: 'bsch-hint' }, t('strip.upcoming')),
        upcoming.map(task => h('span', {
          key: task.id,
          className: `bsch-chip${task.due.slice(0, 10) === today ? ' is-urgent' : ''}`,
        }, `${task.title} · ${task.due.slice(5, 16).replace('T', ' ')}`)))
    }

    function ScheduleTab(props) {
      const { t, api, timer, refresh, data, undoApi, weekStart, setWeekStart } = props
      const weekly = useScheduleData(api, timer, weekStart)
      // Hold the previous week on screen until the target week's snapshot
      // has landed (user report 2026-10-20): everything below renders ONE
      // self-consistent `{anchor, rows}` pair — the snapshot carries its
      // own anchor — so a flip or quick jump never paints the new window
      // with the old week's rows (they bucket into nothing: a one-frame
      // blank that reads as a blink on identical consecutive weeks). The
      // root snapshot joins only when it IS the target week, keeping the
      // first paint on today instant; any other first visit waits out its
      // fetch like before. The swap is atomic by construction: the anchor
      // and the rows travel inside the same snapshot object.
      const snapshot = weekly.data
        ?? (data !== null && data.weekStart === weekStart ? data : null)
      const categories = snapshot?.global?.categories
      const viewWeek = snapshot?.weekStart ?? weekStart
      const [editor, setEditor] = useState(null)
      const [batch, setBatch] = useState(false)
      const [conflictBatch, setConflictBatch] = useState(null)

      // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (docs/10 P5).
      useEffect(() => {
        const onKey = event => {
          if (!(event.ctrlKey || event.metaKey)) return
          const key = event.key.toLowerCase()
          if (key !== 'z' && key !== 'y') return
          event.preventDefault()
          if (key === 'y' || event.shiftKey) void undoApi.redo()
          else void undoApi.undo()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [undoApi])

      const completedIds = (snapshot?.tasks ?? [])
        .filter(task => task.completed && task.entryId !== null)
        .map(task => task.entryId)

      const refreshBoth = useCallback(async () => {
        await Promise.all([refresh(), weekly.refresh()])
      }, [refresh, weekly.refresh])

      // Move is natively multi-item (R9-3): resize passes 1 item, selection
      // drag passes n — one code path. The host replies per item; applied
      // items share one undo step and conflicted ones land in a single
      // overwrite verdict dialog.
      const applyMoves = useCallback(async items => {
        const results = await api.moveEntry(items.map(item =>
          ({ id: item.id, start: item.after.start, end: item.after.end })))
        const applied = []
        const conflicted = []
        for (let i = 0; i < items.length; i++) {
          const result = results[i]
          if (result.ok) applied.push(items[i])
          else if (result.code === 'conflict') {
            conflicted.push({
              item: items[i],
              reasons: (result.conflicts ?? []).map(conflict => conflict.reason),
            })
          } else {
            window.console.error(result.message)
          }
        }
        if (applied.length > 0) {
          undoApi.push({
            label: 'move',
            undo: async () => {
              await api.moveEntry(applied.map(item =>
                ({ id: item.id, start: item.before.start, end: item.before.end })), { allowConflicts: true })
              await refreshBoth()
            },
            redo: async () => {
              await api.moveEntry(applied.map(item =>
                ({ id: item.id, start: item.after.start, end: item.after.end })), { allowConflicts: true })
              await refreshBoth()
            },
          })
        }
        await refreshBoth()
        if (conflicted.length > 0) setConflictBatch(conflicted)
        return {
          appliedIds: applied.map(item => item.id),
          failedIds: items.filter(item => !applied.includes(item)).map(item => item.id),
        }
      }, [api, undoApi, refreshBoth])

      // Delete key on a selection: remove all in one call, recreate on undo.
      // The full rows go into the undo closure so recreate keeps category/
      // desc/task link (entryInput picks the known fields; ids are reassigned).
      const deleteEntries = useCallback(async items => {
        const rows = items.map(item => item.raw)
        let liveIds = rows.map(row => row.id)
        await api.deleteEntry(liveIds)
        undoApi.push({
          label: 'delete',
          undo: async () => {
            const results = await api.batchCreateEntries(await core.currentCategoryInputs(api, rows), { allowConflicts: true })
            const restoredIds = results.filter(row => row.ok).map(row => row.id)
            const failed = results.find(row => !row.ok)
            if (failed) {
              // The undo step stays retryable; do not duplicate partial restores.
              if (restoredIds.length) await api.deleteEntry(restoredIds)
              await refreshBoth()
              throw new Error(failed.message ?? t('entry.restoreFailed'))
            }
            liveIds = restoredIds
            await refreshBoth()
          },
          redo: async () => {
            await api.deleteEntry(liveIds)
            await refreshBoth()
          },
        })
        await refreshBoth()
      }, [api, undoApi, refreshBoth])

      return h('div', { className: 'bsch-body' },
        h('div', { className: 'bsch-toolbar' },
          h('button', { className: 'bsch-btn', onClick: () => setWeekStart(addDays(weekStart, -7)) }, '‹'),
          h('button', { className: 'bsch-btn', onClick: () => setWeekStart(addDays(weekStart, 7)) }, '›'),
          h('button', { className: 'bsch-btn', onClick: () => setWeekStart(grid.anchorToday()) }, t('toolbar.today')),
          h(QuickJump, { t, api, categories, weekStart: viewWeek, onJump: day => setWeekStart(day) }),
          snapshot?.termWeek != null
            ? h('span', { className: 'bsch-badge' }, `${t('week.prefix')} ${snapshot.termWeek} ${t('week.suffix')}`.trim())
            : h('span', { className: 'bsch-badge' }, t('week.unknown')),
          h('span', { className: 'bsch-spacer' }),
          h('button', {
            className: 'bsch-btn', disabled: !undoApi.canUndo, onClick: () => void undoApi.undo(),
          }, `⤺ ${t('toolbar.undo')}`),
          h('button', {
            className: 'bsch-btn', disabled: !undoApi.canRedo, onClick: () => void undoApi.redo(),
          }, `⤻ ${t('toolbar.redo')}`),
          h('button', { className: 'bsch-btn', onClick: () => setBatch(true) }, t('toolbar.batch')),
          h('button', { className: 'bsch-btn is-primary', onClick: () => setEditor({ draft: {} }) }, `+ ${t('toolbar.newEntry')}`)),
        h(UpcomingStrip, { t, tasks: snapshot?.tasks ?? [], today: snapshot?.today }),
        undoApi.error ? h('div', { className: 'bsch-error', role: 'alert' }, undoApi.error) : null,
        weekly.error !== null
          ? h('div', { className: 'bsch-list' },
              h('span', { className: 'bsch-error' }, t('state.error').replace('{message}', weekly.error)),
              h('button', { className: 'bsch-btn', onClick: () => void weekly.refresh() }, t('state.retry')))
          : h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
              h(WeekGrid, {
                t, timer, weekStart: viewWeek, today: snapshot?.today,
                entries: snapshot?.entries ?? [],
                categories,
                completedTaskIds: completedIds,
                onEditEntry: block => setEditor({ initial: block.raw }),
                // startMin/endMin are grid-relative minutes (04:00 = 240).
                onCreateAt: (day, startMin, endMin) => setEditor({
                  draft: { start: zonedAt(day, startMin), end: zonedAt(day, endMin) },
                }),
                onJumpTo: day => setWeekStart(day),
                onMoveItems: items => applyMoves(items),
                onDeleteEntries: items => void deleteEntries(items),
              })),
        editor !== null ? h(EventEditor, {
          t, api, categories,
          initial: editor.initial ?? null,
          draft: editor.draft,
          undoApi,
          refresh: refreshBoth,
          onClose: () => setEditor(null),
          onSaved: refreshBoth,
        }) : null,
        batch ? h(BatchEditor, {
          t, api, undoApi, categories: snapshot?.global?.categories,
          refresh: refreshBoth,
          onClose: () => setBatch(false),
        }) : null,
        conflictBatch !== null ? h(ConfirmDialog, {
          t, title: t('conflict.title'),
          message: conflictBatch
            .map(({ item, reasons }) => `${item.raw?.title ?? item.id}\n${reasons.join('\n')}`)
            .join('\n'),
          confirmLabel: t('conflict.proceed'),
          onCancel: () => setConflictBatch(null),
          onConfirm: () => {
            const pending = conflictBatch
            setConflictBatch(null)
            void (async () => {
              await api.moveEntry(pending.map(({ item }) =>
                ({ id: item.id, start: item.after.start, end: item.after.end })), { allowConflicts: true })
              undoApi.push({
                label: 'move',
                undo: async () => {
                  await api.moveEntry(pending.map(({ item }) =>
                    ({ id: item.id, start: item.before.start, end: item.before.end })), { allowConflicts: true })
                  await refreshBoth()
                },
                redo: async () => {
                  await api.moveEntry(pending.map(({ item }) =>
                    ({ id: item.id, start: item.after.start, end: item.after.end })), { allowConflicts: true })
                  await refreshBoth()
                },
              })
              await refreshBoth()
            })()
          },
        }) : null)
    }

    /**
     * @param {object} props - slot props plus the registration's inject
     *   share: `env` = `{ api, timer }`.
     */
    function CalendarPanel(props) {
      const { t, env } = props
      const [tab, setTab] = useState('schedule')
      const root = useScheduleData(env.api, env.timer)
      const undoApi = useUndo(root.refresh)
      const refreshAll = useCallback(() => { void root.refresh() }, [root.refresh])
      // Trust a snapshot anchor only when it is a well-formed day key (P7:
      // a poisoned 'undefined' once produced aN-NaN headers).
      const [weekStart, setWeekStart] = useState(
        () => DAY_KEY_RE.test(root.data?.weekStart ?? '') ? root.data.weekStart : grid.anchorToday())

      return h('div', { className: 'bsch-panel' },
        h('div', { className: 'bsch-tabs' },
          h('button', {
            className: `bsch-tab${tab === 'schedule' ? ' is-active' : ''}`,
            onClick: () => setTab('schedule'),
          }, t('tab.schedule')),
          h('button', {
            className: `bsch-tab${tab === 'tasks' ? ' is-active' : ''}`,
            onClick: () => setTab('tasks'),
          }, t('tab.tasks')),
          h('button', {
            className: `bsch-tab${tab === 'clipboard' ? ' is-active' : ''}`,
            onClick: () => setTab('clipboard'),
          }, t('tab.clipboard'))),
        root.data === null && root.error === null
          ? h('div', { className: 'bsch-queue-empty' }, t('state.loading'))
          : root.error !== null && root.data === null
            ? h('div', { className: 'bsch-list' },
                h('span', { className: 'bsch-error' }, t('state.error').replace('{message}', root.error)))
            : tab === 'schedule'
              ? h(ScheduleTab, {
                  t, api: env.api, timer: env.timer, data: root.data,
                  refresh: refreshAll, undoApi, weekStart, setWeekStart,
                })
              : tab === 'tasks'
                ? h(TasksTab, {
                    t, api: env.api, refresh: refreshAll,
                    tasks: root.data?.tasks ?? [], today: root.data?.today,
                  })
                : h(ClipboardTab, { t, env }))
    }

    return { CalendarPanel }
  },
})
