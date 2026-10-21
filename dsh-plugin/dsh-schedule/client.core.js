/**
 * Shared client kernel: locale dictionaries, the category→token map, the
 * `/api` client, data hooks, and the small UI atoms every page reuses.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.core.js',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    const h = React.createElement

    const API_PATH = '/api/schedule-core'

    // -- locale ---------------------------------------------------------------
    const zh = {
      'panel.calendar': '日程', 'panel.clipboard': '剪贴板', 'panel.settings': '日程设置',
      'tab.schedule': '日程', 'tab.tasks': '任务', 'tab.clipboard': '剪贴板',
      'toolbar.today': '回今天', 'toolbar.prev': '上一周', 'toolbar.next': '下一周',
      'toolbar.newEntry': '新建条目', 'toolbar.undo': '向后', 'toolbar.redo': '向前',
      'toolbar.batch': '批量',
      'minical.title': '快速跳转', 'minical.month': '{year}年{month}月',
      'batch.title': '批量新建日程', 'batch.repeat': '重复',
      'batch.daily': '每天', 'batch.weekly': '指定星期几', 'batch.weekdays': '重复的星期几',
      'batch.startDate': '开始日期', 'batch.endDate': '结束日期',
      'batch.startTime': '开始时间', 'batch.endTime': '结束时间',
      'batch.hint': '将在指定日期范围内按重复规则逐日创建日程。',
      'batch.count': '将创建 {count} 条日程',
      'batch.created': '批量创建完成：成功 {ok} 条，失败 {fail} 条',
      'batch.create': '批量创建', 'batch.creating': '创建中…',
      'batch.emptyRange': '请选择有效的日期范围与重复规则', 'batch.badRange': '结束时间需晚于开始时间',
      'week.prefix': '第', 'week.suffix': '教学周', 'week.unknown': '未设学期起点',
      'strip.upcoming': '24h 内到期', 'strip.empty': '近 24 小时没有到期任务',
      'grid.newEvent': '新建事件', 'grid.jumpTo': '跳到这天',
      'entry.title': '标题', 'entry.category': '类别', 'entry.start': '开始', 'entry.end': '结束',
      'entry.location': '地点', 'entry.lock': '禁止鼠标快捷拖动',
      'entry.lockHint': '仅限制左键拖动时间和时长；仍可编辑、删除或使用右键菜单。',
      'entry.allDay': '全天', 'entry.description': '备注', 'entry.delete': '删除',
      'entry.save': '保存', 'entry.cancel': '取消', 'entry.edit': '编辑条目', 'entry.create': '新建条目',
      'task.title': '标题', 'task.type': '类别', 'task.due': '截止', 'task.priority': '优先级',
      'task.description': '备注', 'task.edit': '编辑任务', 'task.create': '新建任务',
      'task.delete': '删除', 'task.save': '保存', 'task.cancel': '取消',
      'task.filter': '状态', 'task.all': '全部', 'task.pending': '待完成',
      'task.overdue': '已过期', 'task.today': '今日', 'task.week': '本周', 'task.later': '以后',
      'task.done': '已完成', 'task.progress': '今日进度',
      'task.empty': '暂无任务。点右上角「+ 新建任务」，或在日历空白处单击落一个草稿。',
      'confirm.deleteTitle': '确认删除', 'confirm.deleteEntry': '删除条目「{title}」？此操作不可撤销。',
      'confirm.deleteTask': '删除任务「{title}」？此操作不可撤销。',
      'confirm.ok': '删除', 'confirm.cancel': '取消',
      'conflict.title': '时间冲突', 'conflict.proceed': '仍要保存',
      'clipboard.title': '剪贴板队列', 'clipboard.add': '添加一条', 'clipboard.send': '发送到新会话',
      'clipboard.hint': '自动收录剪贴板文本；「发送到新会话」会把队列交给 Agent 解析并调用 sched 工具落库。',
      'clipboard.watching': '正在监听剪贴板（每 5 秒检测一次，重复内容不会重复入队）。',
      'clipboard.up': '上移', 'clipboard.down': '下移', 'clipboard.remove': '移除',
      'clipboard.empty': '队列为空。复制任意文字后会自动出现在这里。',
      'clipboard.split': '按行拆分粘贴',
      'clipboard.clear': '清空队列', 'clipboard.clearHint': '清空全部 {count} 条队列内容？',
      'clipboard.sent': '已发送到新会话',
      'clipboard.sendFail': '发送失败：{message}',
      'settings.termStart': '学期起点（第一周周一）',
      'settings.termHint': '用于计算教学周；留空则不显示周次。',
      'settings.saved': '已保存',
      'settings.dataTitle': '数据', 'settings.export': '导出 JSON', 'settings.import': '导入 JSON',
      'settings.imported': '导入完成：{summary}', 'settings.importFail': '导入失败：{message}',
      'settings.clearAll': '清除全部日程数据',
      'settings.clearAllHint': '删除全部条目与任务，不可撤销；学期起点与学号等设置保留。建议先导出备份。',
      'settings.clearAllConfirm': '清空', 'settings.clearedAll': '已清除 {count} 条日程数据',
      'settings.notifyTitle': '提醒通知',
      'settings.notifyHint': '页面打开时每 30 秒检查一次提醒；授权后使用浏览器通知，未授权时显示页面内提示。',
      'settings.notifyEnable': '启用浏览器通知',
      'settings.notifyGranted': '浏览器通知已启用',
      'settings.notifyDenied': '浏览器通知已被拒绝，请在浏览器设置中允许本站通知',
      'settings.notifyUnsupported': '当前环境不支持浏览器通知',
      'notify.taskTitle': '任务提醒', 'notify.entryTitle': '日程提醒',
      'notify.taskBody': '「{title}」将于 {time} 截止',
      'notify.entryBody': '「{title}」将于 {time} 开始{location}',
      'notify.entryAllDay': '「{title}」{date} 全天{location}',
      'notify.toastHint': '开启浏览器通知可在页面切到后台时收到提醒',
      'state.error': '出错了：{message}', 'state.loading': '加载中…', 'state.retry': '重试',
      'cat.homework': '作业', 'cat.exam': '考试', 'cat.meeting': '会议',
      'cat.study': '学习', 'cat.sports': '运动', 'cat.other': '其他',
      'type.homework': '作业', 'type.exam': '考试', 'type.lecture': '听课', 'type.other': '其他',
      'prio.high': '高', 'prio.medium': '中', 'prio.low': '低',
    }
    const en = {
      'panel.calendar': 'Schedule', 'panel.clipboard': 'Clipboard', 'panel.settings': 'Schedule settings',
      'tab.schedule': 'Schedule', 'tab.tasks': 'Tasks', 'tab.clipboard': 'Clipboard',
      'toolbar.today': 'Today', 'toolbar.prev': 'Prev week', 'toolbar.next': 'Next week',
      'toolbar.newEntry': 'New entry', 'toolbar.undo': 'Back', 'toolbar.redo': 'Forward',
      'toolbar.batch': 'Batch',
      'minical.title': 'Quick jump', 'minical.month': '{month}/{year}',
      'batch.title': 'Batch-create entries', 'batch.repeat': 'Repeat',
      'batch.daily': 'Every day', 'batch.weekly': 'Chosen weekdays', 'batch.weekdays': 'Weekdays to repeat',
      'batch.startDate': 'Start date', 'batch.endDate': 'End date',
      'batch.startTime': 'Start time', 'batch.endTime': 'End time',
      'batch.hint': 'Creates one entry per matching day inside the date range.',
      'batch.count': 'Will create {count} entries',
      'batch.created': 'Batch done: {ok} created, {fail} failed',
      'batch.create': 'Create all', 'batch.creating': 'Creating…',
      'batch.emptyRange': 'Pick a valid date range and repeat rule', 'batch.badRange': 'End time must be after start time',
      'week.prefix': 'Week', 'week.suffix': '', 'week.unknown': 'No term start set',
      'strip.upcoming': 'Due in 24h', 'strip.empty': 'Nothing due in the next 24 hours',
      'grid.newEvent': 'New event', 'grid.jumpTo': 'Jump to this day',
      'entry.title': 'Title', 'entry.category': 'Category', 'entry.start': 'Start', 'entry.end': 'End',
      'entry.location': 'Location', 'entry.lock': 'Prevent quick mouse dragging',
      'entry.lockHint': 'Only blocks left-button time and duration dragging; editing, deletion, and context actions stay available.',
      'entry.allDay': 'All day', 'entry.description': 'Notes', 'entry.delete': 'Delete',
      'entry.save': 'Save', 'entry.cancel': 'Cancel', 'entry.edit': 'Edit entry', 'entry.create': 'New entry',
      'task.title': 'Title', 'task.type': 'Type', 'task.due': 'Due', 'task.priority': 'Priority',
      'task.description': 'Notes', 'task.edit': 'Edit task', 'task.create': 'New task',
      'task.delete': 'Delete', 'task.save': 'Save', 'task.cancel': 'Cancel',
      'task.filter': 'Status', 'task.all': 'All', 'task.pending': 'Pending',
      'task.overdue': 'Overdue', 'task.today': 'Today', 'task.week': 'This week', 'task.later': 'Later',
      'task.done': 'Completed', 'task.progress': 'Today',
      'task.empty': 'No tasks yet. Use "+ New task" above, or click empty calendar space to draft an entry.',
      'confirm.deleteTitle': 'Confirm deletion', 'confirm.deleteEntry': 'Delete entry "{title}"? This cannot be undone.',
      'confirm.deleteTask': 'Delete task "{title}"? This cannot be undone.',
      'confirm.ok': 'Delete', 'confirm.cancel': 'Cancel',
      'conflict.title': 'Time conflict', 'conflict.proceed': 'Save anyway',
      'clipboard.title': 'Clipboard queue', 'clipboard.add': 'Add item', 'clipboard.send': 'Send to new session',
      'clipboard.hint': 'Copying text fills this queue automatically; "Send to new session" hands it to the Agent, which parses it and writes via the sched tools.',
      'clipboard.watching': 'Watching the clipboard (checked every 5s; identical text is queued once).',
      'clipboard.up': 'Move up', 'clipboard.down': 'Move down', 'clipboard.remove': 'Remove',
      'clipboard.empty': 'Queue is empty. Copy any text and it will appear here.',
      'clipboard.split': 'Split paste by lines',
      'clipboard.clear': 'Clear queue', 'clipboard.clearHint': 'Clear all {count} queued items?',
      'clipboard.sent': 'Sent to a new session',
      'clipboard.sendFail': 'Send failed: {message}',
      'settings.termStart': 'Term start (Monday of week 1)',
      'settings.termHint': 'Used to compute teaching weeks; leave empty to hide the week badge.',
      'settings.saved': 'Saved',
      'settings.dataTitle': 'Data', 'settings.export': 'Export JSON', 'settings.import': 'Import JSON',
      'settings.imported': 'Import done: {summary}', 'settings.importFail': 'Import failed: {message}',
      'settings.clearAll': 'Clear all schedule data',
      'settings.clearAllHint': 'Deletes every entry and task. This cannot be undone; the term anchor and student id are kept. Export a backup first.',
      'settings.clearAllConfirm': 'Clear', 'settings.clearedAll': 'Cleared {count} rows',
      'settings.notifyTitle': 'Reminder notifications',
      'settings.notifyHint': 'Checks reminders every 30 seconds while the app is open. Browser notifications need permission; otherwise an in-page toast is shown.',
      'settings.notifyEnable': 'Enable browser notifications',
      'settings.notifyGranted': 'Browser notifications are enabled',
      'settings.notifyDenied': 'Browser notifications are blocked; allow them in the browser site settings',
      'settings.notifyUnsupported': 'This environment does not support browser notifications',
      'notify.taskTitle': 'Task reminder', 'notify.entryTitle': 'Schedule reminder',
      'notify.taskBody': '"{title}" is due at {time}',
      'notify.entryBody': '"{title}" starts at {time}{location}',
      'notify.entryAllDay': '"{title}" is all day on {date}{location}',
      'notify.toastHint': 'Enable browser notifications to get reminders while the page is in the background',
      'state.error': 'Error: {message}', 'state.loading': 'Loading…', 'state.retry': 'Retry',
      'cat.homework': 'Homework', 'cat.exam': 'Exam', 'cat.meeting': 'Meeting',
      'cat.study': 'Study', 'cat.sports': 'Sports', 'cat.other': 'Other',
      'type.homework': 'Homework', 'type.exam': 'Exam', 'type.lecture': 'Lecture', 'type.other': 'Other',
      'prio.high': 'High', 'prio.medium': 'Medium', 'prio.low': 'Low',
    }

    // The one place entry categories map to theme tokens (§4.3). The
    // neutral categories brighten the idle gray toward label-primary:
    // raw idle gray sinks into dark backgrounds (user report 2026-10-19),
    // while the 16% block fill keeps white text readable.
    const NEUTRAL_TOKEN =
      'color-mix(in srgb, var(--dsw-alias-state-idle-primary) 45%, var(--dsw-alias-label-primary))'
    const CATEGORY_TOKEN = {
      homework: 'var(--dsw-alias-state-warn-primary)',
      exam: 'var(--dsw-alias-state-error-primary)',
      meeting: NEUTRAL_TOKEN,
      study: NEUTRAL_TOKEN,
      sports: 'var(--dsw-alias-state-success-primary)',
      other: NEUTRAL_TOKEN,
    }

    // -- time helpers (the one canonical copy; chunks import from here) --
    const pad2 = n => String(n).padStart(2, '0')
    const dateKey = date =>
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

    /** Format a Date as local wall time with an explicit zone offset. */
    function dateToZonedIso(date) {
      const off = -date.getTimezoneOffset()
      const sign = off >= 0 ? '+' : '-'
      const abs = Math.abs(off)
      const zone = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
      return `${dateKey(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:00${zone}`
    }

    const addDays = (key, days) => {
      const date = new Date(key + 'T12:00:00')
      date.setDate(date.getDate() + days)
      return dateKey(date)
    }

    /** Zoned ISO for a `YYYY-MM-DD` day plus minutes-from-midnight. */
    const zonedAt = (dayKey, minutes) => {
      const [y, m, d] = dayKey.split('-').map(Number)
      return dateToZonedIso(new Date(y, m - 1, d, 0, minutes))
    }

    // -- /api client ------------------------------------------------------------
    class ApiError extends Error {
      constructor(payload) {
        super(payload.message)
        this.code = payload.code
        this.details = payload.details
      }
    }

    async function parseResult(response) {
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (body && body.ok) return body.value
      throw new ApiError(body?.error ?? { code: 'http_' + response.status, message: `HTTP ${response.status}` })
    }

    function createApi(fetchImpl) {
      const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
      const post = (op, payload) => doFetch(API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...payload }),
      }).then(parseResult)
      return {
        // Omit the param when nullish — `encodeURIComponent(undefined)`
        // would smuggle the string "undefined" into the snapshot (P7).
        snapshot: weekStart => {
          const url = weekStart === null || weekStart === undefined
            ? API_PATH
            : `${API_PATH}?weekStart=${encodeURIComponent(weekStart)}`
          return doFetch(url).then(parseResult)
        },
        /** Reminder moments for the notification poller (server-derived). */
        reminders: () => doFetch(`${API_PATH}?view=reminders`).then(parseResult),
        createEntry: (input, opts) => post('createEntry', { input, ...opts }),
        updateEntry: (id, patch, opts) => post('updateEntry', { id, patch, ...opts }),
        moveEntry: (moves, opts) => post('moveEntry', { moves, ...opts }),
        deleteEntry: ids => post('deleteEntry', { ids }),
        batchCreateEntries: (inputs, opts) => post('batchCreateEntries', { inputs, ...opts }),
        createTask: input => post('createTask', { input }),
        updateTask: (id, patch) => post('updateTask', { id, patch }),
        setTaskCompleted: (id, completed) => post('setTaskCompleted', { id, completed }),
        deleteTask: id => post('deleteTask', { id }),
        setMeta: patch => post('setMeta', { patch }),
        exportData: () => post('export', {}),
        importData: payload => post('import', { payload }),
        clearAllData: () => post('clearAllData', {}),
      }
    }

    // -- cross-surface data pulse ----------------------------------------------
    // No push channel exists for plugin data (D-1), so a surface that
    // finishes a bulk write outside the calendar panel (a settings import
    // card, a source adapter's sync) pulses this same-window event; every
    // mounted useScheduleData refreshes immediately instead of waiting out
    // the 20-second revision poll. Unmounted panels need nothing — their
    // mount effect fetches fresh data anyway. Source adapters dispatch the
    // literal event name; this kernel owns the contract.
    const DATA_CHANGED_EVENT = 'schedule:data-changed'
    const notifyDataChanged = () => {
      window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT))
    }

    // -- hooks ------------------------------------------------------------------
    /** Load the weekly snapshot, refresh on week change, mutation, the
     *  `schedule:data-changed` pulse, and a 20-second revision poll (no push
     *  channel exists for plugin data). */
    function useScheduleData(api, timer, weekStart) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const weekRef = useRef(weekStart)
      weekRef.current = weekStart

      const refresh = useCallback(async () => {
        try {
          const snapshot = await api.snapshot(weekRef.current)
          // A response for an anchor the view has already left must not
          // take the grid over: rapid flips can land out of order, and the
          // displayed pair stays self-consistent only if the state tracks
          // the CURRENT anchor (the view holds the previous snapshot until
          // this anchor's own fetch lands). The anchor-less root snapshot
          // always echoes today's anchor and passes.
          if (weekRef.current != null && snapshot.weekStart !== weekRef.current) return
          setError(null)
          // Dedupe polls by revision — but a week switch re-fetches with an
          // unchanged revision, so the anchor must join the check or the
          // old week's rows would render against the new week's grid.
          setData(prev => (prev !== null
            && prev.revision === snapshot.revision
            && prev.weekStart === snapshot.weekStart
            ? prev
            : snapshot))
        } catch (cause) {
          setError(cause.message ?? String(cause))
        }
      }, [api])

      useEffect(() => { void refresh() }, [refresh, weekStart])
      useEffect(() => {
        const onDataChanged = () => { void refresh() }
        window.addEventListener(DATA_CHANGED_EVENT, onDataChanged)
        return () => window.removeEventListener(DATA_CHANGED_EVENT, onDataChanged)
      }, [refresh])
      useEffect(() => {
        if (!timer) return undefined
        return timer.interval(() => { void refresh() }, 20_000)
      }, [timer, refresh])

      return { data, error, refresh }
    }

    /** Undo/redo double stack, each capped at 5 (docs/10 P5): entries are
     *  `{undo, redo, label}`; a new push clears the redo stack.
     *
     *  The stacks live in a ref (state only mirrors them for rendering):
     *  mutations arrive from async UI callbacks (delete -> push after an
     *  await) and from keyboard handlers that may still hold the previous
     *  render's closure. Reading `stacks` from a closure let a push land
     *  between that render and the next Ctrl+Z, so the undo step saw an old
     *  (or empty) stack and the earlier operations became unreachable. */
    function useUndo(refresh) {
      const stacksRef = useRef({ undo: [], redo: [] })
      const [, bump] = useState(0) // re-render for canUndo/canRedo only
      const busy = useRef(false)
      const commit = useCallback(next => {
        stacksRef.current = next
        bump(value => value + 1)
      }, [])
      const push = useCallback(entry => {
        const current = stacksRef.current
        commit({ undo: [...current.undo, entry].slice(-5), redo: [] })
      }, [commit])
      const step = useCallback(async direction => {
        if (busy.current) return
        const from = stacksRef.current[direction]
        const entry = from[from.length - 1]
        if (entry === undefined) return
        busy.current = true
        try {
          await entry[direction]()
          const current = stacksRef.current
          // Remove THIS entry by identity, not "the current top": an async
          // operation may have been pushed while the undo was in flight, and
          // slicing the top would silently discard that newer step.
          const remove = list => {
            const index = list.lastIndexOf(entry)
            return index === -1
              ? list
              : [...list.slice(0, index), ...list.slice(index + 1)]
          }
          commit(direction === 'undo'
            ? { undo: remove(current.undo), redo: [...current.redo, entry].slice(-5) }
            : { undo: [...current.undo, entry].slice(-5), redo: remove(current.redo) })
          await refresh()
        } finally {
          busy.current = false
        }
      }, [commit, refresh])
      return {
        push,
        undo: useCallback(() => void step('undo'), [step]),
        redo: useCallback(() => void step('redo'), [step]),
        canUndo: stacksRef.current.undo.length > 0,
        canRedo: stacksRef.current.redo.length > 0,
      }
    }

    // -- UI atoms ----------------------------------------------------------------
    function Modal({ title, onClose, children }) {
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'bsch-modal-mask', onMouseDown: e => e.target === e.currentTarget && onClose() },
        h('div', { className: 'bsch-modal', role: 'dialog', 'aria-label': title },
          h('div', { className: 'bsch-modal-title' }, title),
          children))
    }

    function ConfirmDialog({ t, title, message, confirmLabel, onConfirm, onCancel }) {
      return h(Modal, { title, onClose: onCancel },
        h('div', null, message),
        h('div', { className: 'bsch-modal-actions' },
          h('button', { className: 'bsch-btn', onClick: onCancel }, t('confirm.cancel')),
          h('button', { className: 'bsch-btn is-danger', onClick: onConfirm }, confirmLabel)))
    }

    const field = (labelText, input) =>
      h('div', { className: 'bsch-field' }, h('label', null, labelText), input)

    return {
      React, h, useState, useEffect, useRef, useCallback,
      zh, en, CATEGORY_TOKEN,
      pad2, dateKey, dateToZonedIso, addDays, zonedAt,
      createApi, ApiError, useScheduleData, useUndo, notifyDataChanged,
      Modal, ConfirmDialog, field,
    }
  },
})
