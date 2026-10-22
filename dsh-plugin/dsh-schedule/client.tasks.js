/**
 * Tasks tab: grouped list (overdue / today / this week / later /
 * completed) with an SVG progress ring and an editor dialog.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.tasks.js',
  factory: (require) => {
    const core = require('@lidozs55/dsh-schedule/client.core.js')
    const { React, h, field } = core
    const { useState, useMemo } = React
    const { Modal, ConfirmDialog } = core
    const { toLocalInput, zoneLocal, RemindLeadField, leadToSelect } = require('@lidozs55/dsh-schedule/client.editors.js')

    const TYPES = ['homework', 'exam', 'lecture', 'other']
    const PRIORITIES = ['high', 'medium', 'low']
    const DAY_MS = 86_400_000

    /** Overall completion ring with a percent center, like the original. */
    function ProgressRing({ done, total }) {
      const radius = 15
      const circumference = 2 * Math.PI * radius
      const progress = total === 0 ? 0 : done / total
      return h('svg', {
        className: 'bsch-ring', width: 40, height: 40,
        viewBox: '0 0 40 40', role: 'img', 'aria-label': `${done}/${total}`,
      },
      h('circle', {
        cx: 20, cy: 20, r: radius, fill: 'none',
        stroke: 'var(--dsw-alias-bg-layer-2)', 'stroke-width': 4,
      }),
      h('circle', {
        cx: 20, cy: 20, r: radius, fill: 'none',
        stroke: 'var(--dsw-alias-state-success-primary)', 'stroke-width': 4,
        'stroke-dasharray': String(circumference),
        'stroke-dashoffset': String(circumference * (1 - progress)),
        transform: 'rotate(-90 20 20)',
      }),
      h('text', { x: 20, y: 24, 'text-anchor': 'middle' }, `${Math.round(progress * 100)}%`))
    }

    function TaskEditor({ t, initial, api, onClose, onSaved }) {
      const [title, setTitle] = useState(initial?.title ?? '')
      const [taskType, setTaskType] = useState(initial?.taskType ?? 'homework')
      const [priority, setPriority] = useState(initial?.priority ?? 'medium')
      const [due, setDue] = useState(() => {
        if (initial?.due !== undefined) return toLocalInput(initial.due)
        // Legacy defaulted a new task's due to TODAY (end of day).
        const endOfToday = new Date()
        endOfToday.setHours(23, 59, 0, 0)
        return toLocalInput(endOfToday)
      })
      const [description, setDescription] = useState(initial?.description ?? '')
      const [lead, setLead] = useState(() => leadToSelect(initial?.remindLead))
      const [error, setError] = useState(null)
      const [confirming, setConfirming] = useState(false)

      const save = async () => {
        setError(null)
        try {
          const input = { title, taskType, priority, description, due: zoneLocal(due), remindLead: lead === '' ? null : Number(lead) }
          const saved = initial === null
            ? await api.createTask(input)
            : await api.updateTask(initial.id, input)
          onSaved(saved)
          onClose()
        } catch (cause) {
          setError(cause.message ?? String(cause))
        }
      }

      if (confirming) {
        return h(ConfirmDialog, {
          t, title: t('confirm.deleteTitle'),
          message: t('confirm.deleteTask').replace('{title}', initial?.title ?? ''),
          confirmLabel: t('confirm.ok'),
          onCancel: () => setConfirming(false),
          onConfirm: async () => {
            await api.deleteTask(initial.id)
            onSaved({ deleted: initial.id })
            onClose()
          },
        })
      }
      return h(Modal, { title: t(initial === null ? 'task.create' : 'task.edit'), onClose },
        field(t('task.title'), h('input', {
          className: 'bsch-input', value: title, autoFocus: true,
          onChange: e => setTitle(e.target.value),
        })),
        field(t('task.type'), h('select', {
          className: 'bsch-select', value: taskType,
          onChange: e => setTaskType(e.target.value),
        }, TYPES.map(type => h('option', { key: type, value: type }, t('type.' + type))))),
        field(t('task.due'), h('input', {
          className: 'bsch-input', type: 'datetime-local', value: due,
          onChange: e => setDue(e.target.value),
        })),
        field(t('task.priority'), h('select', {
          className: 'bsch-select', value: priority,
          onChange: e => setPriority(e.target.value),
        }, PRIORITIES.map(level => h('option', { key: level, value: level }, t('prio.' + level))))),
        h(RemindLeadField, { t, lead, setLead }),
        field(t('task.description'), h('textarea', {
          className: 'bsch-textarea', value: description, rows: 2,
          onChange: e => setDescription(e.target.value),
        })),
        error !== null ? h('div', { className: 'bsch-error' }, error) : null,
        h('div', { className: 'bsch-modal-actions' },
          initial !== null ? h('button', {
            className: 'bsch-btn is-danger', onClick: () => setConfirming(true),
          }, t('task.delete')) : null,
          h('button', { className: 'bsch-btn', onClick: onClose }, t('task.cancel')),
          h('button', {
            className: 'bsch-btn is-primary', disabled: title.trim() === '',
            onClick: () => void save(),
          }, t('task.save'))))
    }

    /**
     * @param {object} props - `{ t, api, refresh, tasks, today }`.
     */
    function TasksTab(props) {
      const { t, api, refresh, tasks, today } = props
      const [editing, setEditing] = useState(null) // null | {} | task
      const [busyId, setBusyId] = useState(null)
      const [statusFilter, setStatusFilter] = useState('all') // all | pending | done (P6)
      const [priorityFilter, setPriorityFilter] = useState('all') // all | high | medium | low

      const groups = useMemo(() => {
        const now = Date.now()
        const byDue = (a, b) => new Date(a.due).getTime() - new Date(b.due).getTime()
        const buckets = { overdue: [], today: [], week: [], later: [], done: [] }
        for (const task of tasks) {
          if (task.completed) { buckets.done.push(task); continue }
          const dueMs = new Date(task.due).getTime()
          const dueDay = task.due.slice(0, 10)
          if (dueMs < now) buckets.overdue.push(task)
          else if (dueDay === today) buckets.today.push(task)
          else if (dueMs <= now + 7 * DAY_MS) buckets.week.push(task)
          else buckets.later.push(task)
        }
        for (const list of Object.values(buckets)) list.sort(byDue)
        return buckets
      }, [tasks, today])

      const visible = useMemo(() => {
        const byStatus = statusFilter === 'all' ? groups
          : statusFilter === 'done' ? { ...groups, overdue: [], today: [], week: [], later: [] }
            : { ...groups, done: [] }
        if (priorityFilter === 'all') return byStatus
        return Object.fromEntries(Object.entries(byStatus).map(([bucket, list]) => [
          bucket, list.filter(task => task.priority === priorityFilter),
        ]))
      }, [groups, statusFilter, priorityFilter])

      const pendingCount = groups.overdue.length + groups.today.length + groups.week.length + groups.later.length

      const toggle = async task => {
        setBusyId(task.id)
        try {
          await api.setTaskCompleted(task.id, !task.completed)
          await refresh()
        } finally {
          setBusyId(null)
        }
      }

      const row = task => h('div', { key: task.id, className: `bsch-row${task.completed ? ' is-done' : ''}` },
        h('input', {
          type: 'checkbox', className: 'bsch-check', checked: task.completed,
          disabled: busyId === task.id, onChange: () => void toggle(task),
        }),
        h('span', { className: `bsch-prio is-${task.priority}`, title: t('prio.' + task.priority) }),
        h('div', { className: 'bsch-row-main', onClick: () => setEditing(task) },
          h('div', { className: 'bsch-row-title' }, task.title),
          h('div', { className: 'bsch-row-meta' },
            `${task.due.slice(5, 16).replace('T', ' ')} · ${t('type.' + task.taskType)}`),
          task.description ? h('div', { className: 'bsch-row-meta' }, task.description) : null),
        h('button', { className: 'bsch-btn', onClick: () => setEditing(task) }, t('task.edit')))

      const section = (label, list, visible = true) => visible && list.length > 0
        ? h('div', null, h('div', { className: 'bsch-group' }, label), list.map(row))
        : null

      return h('div', { className: 'bsch-list' },
        h('div', { className: 'bsch-progress' },
          h(ProgressRing, { done: groups.done.length, total: tasks.length }),
          h('span', { className: 'bsch-hint' }, t('task.progress')),
          h('span', { className: 'bsch-hint' },
            `${t('task.all')} ${pendingCount + groups.done.length} · ${t('task.pending')} ${pendingCount} · ${t('task.done')} ${groups.done.length}`),
          h('span', { className: 'bsch-spacer' }),
          h('select', {
            className: 'bsch-select', style: { width: 'auto' },
            value: statusFilter, onChange: e => setStatusFilter(e.target.value),
            'aria-label': t('task.filter'),
          },
            h('option', { value: 'all' }, t('task.all')),
            h('option', { value: 'pending' }, t('task.pending')),
            h('option', { value: 'done' }, t('task.done'))),
          h('select', {
            className: 'bsch-select', style: { width: 'auto' },
            value: priorityFilter, onChange: e => setPriorityFilter(e.target.value),
            'aria-label': t('task.priority'),
          },
            h('option', { value: 'all' }, t('task.allPriorities')),
            h('option', { value: 'high' }, t('prio.high')),
            h('option', { value: 'medium' }, t('prio.medium')),
            h('option', { value: 'low' }, t('prio.low'))),
          h('button', { className: 'bsch-btn is-primary', onClick: () => setEditing({}) },
            `+ ${t('task.create')}`)),
        tasks.length === 0 ? h('div', { className: 'bsch-queue-empty' }, t('task.empty')) : null,
        section(t('task.overdue'), visible.overdue),
        section(t('task.today'), visible.today),
        section(t('task.week'), visible.week),
        section(t('task.later'), visible.later),
        section(t('task.done'), visible.done),
        editing !== null ? h(TaskEditor, {
          t, initial: editing.id === undefined ? null : editing, api,
          onClose: () => setEditing(null), onSaved: refresh,
        }) : null)
    }

    return { TasksTab }
  },
})
