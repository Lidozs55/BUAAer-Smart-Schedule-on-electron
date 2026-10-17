/**
 * CalendarPanel: the `main` panel behind key `buaaer-calendar` — a
 * narrow-layout shell with two inline tabs (日程 | 任务, decision R3).
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule/client.calendar.js',
  factory: (require) => {
    const core = require('@buaaer/dsh-schedule/client.core.js')
    const { React, h, dateToZonedIso, addDays, mondayOf, zonedAt } = core
    const { useState, useCallback } = React
    const { useScheduleData, useUndo, ConfirmDialog } = core
    const { WeekGrid } = require('@buaaer/dsh-schedule/client.weekgrid.js')
    const { EventEditor } = require('@buaaer/dsh-schedule/client.editors.js')
    const { TasksTab } = require('@buaaer/dsh-schedule/client.tasks.js')

    const DAY_MS = 86_400_000

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
      const { t, api, timer, refresh, data, undoApi } = props
      const [weekStart, setWeekStart] = useState(data?.weekStart ?? mondayOf(new Date().toISOString()))
      const weekly = useScheduleData(api, timer, weekStart)
      const snapshot = weekly.data ?? data
      const [editor, setEditor] = useState(null)
      const [conflictMove, setConflictMove] = useState(null)

      const completedIds = (snapshot?.tasks ?? [])
        .filter(task => task.completed && task.entryId !== null)
        .map(task => task.entryId)

      const refreshBoth = useCallback(async () => {
        await Promise.all([refresh(), weekly.refresh()])
      }, [refresh, weekly.refresh])

      const move = async (block, newStart, newEnd, allowConflicts = false) => {
        const before = { start: block.start, end: block.end }
        const after = { start: dateToZonedIso(newStart), end: dateToZonedIso(newEnd) }
        try {
          await api.moveEntry(block.id, after.start, after.end, { allowConflicts })
          undoApi.push({
            label: 'move',
            undo: async () => {
              await api.moveEntry(block.id, before.start, before.end, { allowConflicts: true })
              await refreshBoth()
            },
            redo: async () => {
              await api.moveEntry(block.id, after.start, after.end, { allowConflicts: true })
              await refreshBoth()
            },
          })
          await refreshBoth()
        } catch (cause) {
          if (cause.code === 'conflict') {
            setConflictMove({ block, after, conflicts: cause.details?.conflicts ?? [] })
          } else {
            window.console.error(cause)
          }
        }
      }

      return h('div', { className: 'bsch-body' },
        h('div', { className: 'bsch-toolbar' },
          h('button', { className: 'bsch-btn', onClick: () => setWeekStart(addDays(weekStart, -7)) }, '‹'),
          h('button', { className: 'bsch-btn', onClick: () => setWeekStart(addDays(weekStart, 7)) }, '›'),
          h('button', { className: 'bsch-btn', onClick: () => setWeekStart(mondayOf(new Date().toISOString())) }, t('toolbar.today')),
          snapshot?.termWeek != null
            ? h('span', { className: 'bsch-badge' }, `${t('week.prefix')} ${snapshot.termWeek} ${t('week.suffix')}`.trim())
            : h('span', { className: 'bsch-badge' }, t('week.unknown')),
          h('span', { className: 'bsch-spacer' }),
          undoApi.canUndo ? h('button', { className: 'bsch-btn', onClick: () => void undoApi.undo() }, t('toolbar.undo')) : null,
          h('button', { className: 'bsch-btn is-primary', onClick: () => setEditor({ draft: {} }) }, `+ ${t('toolbar.newEntry')}`)),
        h(UpcomingStrip, { t, tasks: snapshot?.tasks ?? [], today: snapshot?.today }),
        weekly.error !== null
          ? h('div', { className: 'bsch-list' },
              h('span', { className: 'bsch-error' }, t('state.error').replace('{message}', weekly.error)),
              h('button', { className: 'bsch-btn', onClick: () => void weekly.refresh() }, t('state.retry')))
          : h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
              h(WeekGrid, {
                t, timer, weekStart, today: snapshot?.today,
                occurrences: snapshot?.occurrences ?? [],
                entries: snapshot?.entries ?? [],
                completedTaskIds: completedIds,
                onEditEntry: block => setEditor({ initial: block.raw }),
                onCreateAt: (day, minutes) => setEditor({
                  draft: { start: zonedAt(day, minutes), end: zonedAt(day, minutes + 60) },
                }),
                onMove: (block, newStart, newEnd) => void move(block, newStart, newEnd),
              })),
        editor !== null ? h(EventEditor, {
          t, api,
          initial: editor.initial ?? null,
          draft: editor.draft,
          onClose: () => setEditor(null),
          onSaved: refreshBoth,
        }) : null,
        conflictMove !== null ? h(ConfirmDialog, {
          t, title: t('conflict.title'),
          message: conflictMove.conflicts.map(conflict => conflict.reason).join('\n'),
          confirmLabel: t('conflict.proceed'),
          onCancel: () => setConflictMove(null),
          onConfirm: () => {
            const pending = conflictMove
            setConflictMove(null)
            void api.moveEntry(pending.block.id, pending.after.start, pending.after.end, { allowConflicts: true })
              .then(refreshBoth)
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

      return h('div', { className: 'bsch-panel' },
        h('div', { className: 'bsch-tabs' },
          h('button', {
            className: `bsch-tab${tab === 'schedule' ? ' is-active' : ''}`,
            onClick: () => setTab('schedule'),
          }, t('tab.schedule')),
          h('button', {
            className: `bsch-tab${tab === 'tasks' ? ' is-active' : ''}`,
            onClick: () => setTab('tasks'),
          }, t('tab.tasks'))),
        root.error !== null && root.data === null
          ? h('div', { className: 'bsch-list' },
              h('span', { className: 'bsch-error' }, t('state.error').replace('{message}', root.error)))
          : tab === 'schedule'
            ? h(ScheduleTab, {
                t, api: env.api, timer: env.timer, data: root.data,
                refresh: refreshAll, undoApi,
              })
            : h(TasksTab, {
                t, api: env.api, refresh: refreshAll,
                tasks: root.data?.tasks ?? [], today: root.data?.today,
              }))
    }

    return { CalendarPanel }
  },
})
