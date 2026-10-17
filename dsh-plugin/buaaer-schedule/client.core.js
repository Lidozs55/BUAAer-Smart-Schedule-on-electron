/**
 * Shared client kernel: locale dictionaries, the category→token map, the
 * `/api` client, data hooks, and the small UI atoms every page reuses.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule/client.core.js',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    const h = React.createElement

    const API_PATH = '/api/buaaer-schedule'

    // -- locale ---------------------------------------------------------------
    const zh = {
      'panel.calendar': '日程', 'panel.clipboard': '剪贴板', 'panel.settings': 'BUAAer 日程',
      'tab.schedule': '日程', 'tab.tasks': '任务',
      'toolbar.today': '回今天', 'toolbar.prev': '上一周', 'toolbar.next': '下一周',
      'toolbar.newEntry': '新建条目', 'toolbar.undo': '撤销',
      'week.prefix': '第', 'week.suffix': '教学周', 'week.unknown': '未设学期起点',
      'strip.upcoming': '24h 内到期', 'strip.empty': '近 24 小时没有到期任务',
      'grid.newAt': '新建于',
      'entry.title': '标题', 'entry.category': '类别', 'entry.start': '开始', 'entry.end': '结束',
      'entry.allDay': '全天', 'entry.description': '备注', 'entry.delete': '删除',
      'entry.save': '保存', 'entry.cancel': '取消', 'entry.edit': '编辑条目', 'entry.create': '新建条目',
      'task.title': '标题', 'task.type': '类别', 'task.due': '截止', 'task.priority': '优先级',
      'task.description': '备注', 'task.edit': '编辑任务', 'task.create': '新建任务',
      'task.delete': '删除', 'task.save': '保存', 'task.cancel': '取消',
      'task.overdue': '已过期', 'task.today': '今日', 'task.week': '本周', 'task.later': '以后',
      'task.done': '已完成', 'task.progress': '今日进度',
      'confirm.deleteTitle': '确认删除', 'confirm.deleteEntry': '删除条目「{title}」？此操作不可撤销。',
      'confirm.deleteTask': '删除任务「{title}」？此操作不可撤销。',
      'confirm.ok': '删除', 'confirm.cancel': '取消',
      'conflict.title': '时间冲突', 'conflict.proceed': '仍要保存',
      'clipboard.title': '剪贴板队列', 'clipboard.add': '添加一条', 'clipboard.send': '发送到新会话',
      'clipboard.hint': '把随手记下的待办排进队列；「发送到新会话」会把队列文本交给 Agent，由它解析并调用 buaaer 工具落库。',
      'clipboard.up': '上移', 'clipboard.down': '下移', 'clipboard.remove': '移除',
      'clipboard.empty': '队列为空。添加几条待办，或直接粘贴后拆分。',
      'clipboard.split': '按行拆分粘贴',
      'clipboard.sent': '已发送到新会话',
      'clipboard.sendFail': '发送失败：{message}',
      'settings.buaaId': '学号', 'settings.termStart': '学期起点（第一周周一）',
      'settings.termCode': '当前学期码', 'settings.saved': '已保存',
      'settings.syncTitle': '教务同步', 'settings.password': '密码（仅当次使用）',
      'settings.sync': '立即同步', 'settings.syncStarted': '同步已开始，进度见作业面板',
      'settings.syncDone': '同步完成：{summary}',
      'settings.dataTitle': '数据', 'settings.export': '导出 JSON', 'settings.import': '导入 JSON',
      'settings.imported': '导入完成：{summary}', 'settings.importFail': '导入失败：{message}',
      'state.error': '出错了：{message}', 'state.loading': '加载中…', 'state.retry': '重试',
      'cat.course': '课程', 'cat.homework': '作业', 'cat.exam': '考试', 'cat.meeting': '会议',
      'cat.study': '自习', 'cat.sports': '运动', 'cat.other': '其他',
      'type.homework': '作业', 'type.exam': '考试', 'type.lecture': '听课', 'type.other': '其他',
      'prio.high': '高', 'prio.medium': '中', 'prio.low': '低',
    }
    const en = {
      'panel.calendar': 'Schedule', 'panel.clipboard': 'Clipboard', 'panel.settings': 'BUAAer Schedule',
      'tab.schedule': 'Schedule', 'tab.tasks': 'Tasks',
      'toolbar.today': 'Today', 'toolbar.prev': 'Prev week', 'toolbar.next': 'Next week',
      'toolbar.newEntry': 'New entry', 'toolbar.undo': 'Undo',
      'week.prefix': 'Week', 'week.suffix': '', 'week.unknown': 'No term start set',
      'strip.upcoming': 'Due in 24h', 'strip.empty': 'Nothing due in the next 24 hours',
      'grid.newAt': 'New at',
      'entry.title': 'Title', 'entry.category': 'Category', 'entry.start': 'Start', 'entry.end': 'End',
      'entry.allDay': 'All day', 'entry.description': 'Notes', 'entry.delete': 'Delete',
      'entry.save': 'Save', 'entry.cancel': 'Cancel', 'entry.edit': 'Edit entry', 'entry.create': 'New entry',
      'task.title': 'Title', 'task.type': 'Type', 'task.due': 'Due', 'task.priority': 'Priority',
      'task.description': 'Notes', 'task.edit': 'Edit task', 'task.create': 'New task',
      'task.delete': 'Delete', 'task.save': 'Save', 'task.cancel': 'Cancel',
      'task.overdue': 'Overdue', 'task.today': 'Today', 'task.week': 'This week', 'task.later': 'Later',
      'task.done': 'Completed', 'task.progress': 'Today',
      'confirm.deleteTitle': 'Confirm deletion', 'confirm.deleteEntry': 'Delete entry "{title}"? This cannot be undone.',
      'confirm.deleteTask': 'Delete task "{title}"? This cannot be undone.',
      'confirm.ok': 'Delete', 'confirm.cancel': 'Cancel',
      'conflict.title': 'Time conflict', 'conflict.proceed': 'Save anyway',
      'clipboard.title': 'Clipboard queue', 'clipboard.add': 'Add item', 'clipboard.send': 'Send to new session',
      'clipboard.hint': 'Queue things you jot down; "Send to new session" hands the queue text to the Agent, which parses it and writes via the buaaer tools.',
      'clipboard.up': 'Move up', 'clipboard.down': 'Move down', 'clipboard.remove': 'Remove',
      'clipboard.empty': 'Queue is empty. Add items, or paste and split by lines.',
      'clipboard.split': 'Split paste by lines',
      'clipboard.sent': 'Sent to a new session',
      'clipboard.sendFail': 'Send failed: {message}',
      'settings.buaaId': 'Student ID', 'settings.termStart': 'Term start (Monday of week 1)',
      'settings.termCode': 'Current term code', 'settings.saved': 'Saved',
      'settings.syncTitle': 'JW sync', 'settings.password': 'Password (this call only)',
      'settings.sync': 'Sync now', 'settings.syncStarted': 'Sync started; see the jobs panel',
      'settings.syncDone': 'Sync done: {summary}',
      'settings.dataTitle': 'Data', 'settings.export': 'Export JSON', 'settings.import': 'Import JSON',
      'settings.imported': 'Import done: {summary}', 'settings.importFail': 'Import failed: {message}',
      'state.error': 'Error: {message}', 'state.loading': 'Loading…', 'state.retry': 'Retry',
      'cat.course': 'Course', 'cat.homework': 'Homework', 'cat.exam': 'Exam', 'cat.meeting': 'Meeting',
      'cat.study': 'Study', 'cat.sports': 'Sports', 'cat.other': 'Other',
      'type.homework': 'Homework', 'type.exam': 'Exam', 'type.lecture': 'Lecture', 'type.other': 'Other',
      'prio.high': 'High', 'prio.medium': 'Medium', 'prio.low': 'Low',
    }

    // The one place entry categories map to theme tokens (§4.3).
    const CATEGORY_TOKEN = {
      course: 'var(--dsw-alias-brand-primary)',
      homework: 'var(--dsw-alias-state-warn-primary)',
      exam: 'var(--dsw-alias-state-error-primary)',
      meeting: 'var(--dsw-alias-state-idle-primary)',
      study: 'var(--dsw-alias-state-idle-primary)',
      sports: 'var(--dsw-alias-state-idle-primary)',
      other: 'var(--dsw-alias-state-idle-primary)',
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

    /** Local calendar day of an ISO datetime, `YYYY-MM-DD`. */
    const isoDay = iso => dateKey(new Date(iso))

    /** Monday of the local week containing a Date or ISO datetime. */
    const mondayOf = value => {
      const date = new Date(value)
      date.setDate(date.getDate() - (date.getDay() + 6) % 7)
      return dateKey(date)
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
        snapshot: weekStart =>
          doFetch(`${API_PATH}?weekStart=${encodeURIComponent(weekStart)}`).then(parseResult),
        createEntry: (input, opts) => post('createEntry', { input, ...opts }),
        updateEntry: (id, patch, opts) => post('updateEntry', { id, patch, ...opts }),
        moveEntry: (id, start, end, opts) => post('moveEntry', { id, start, end, ...opts }),
        deleteEntry: id => post('deleteEntry', { id }),
        batchCreateEntries: (inputs, opts) => post('batchCreateEntries', { inputs, ...opts }),
        createTask: input => post('createTask', { input }),
        updateTask: (id, patch) => post('updateTask', { id, patch }),
        setTaskCompleted: (id, completed) => post('setTaskCompleted', { id, completed }),
        deleteTask: id => post('deleteTask', { id }),
        setMeta: patch => post('setMeta', { patch }),
        startSync: creds => post('startSync', creds),
        exportData: () => post('export', {}),
        importPayload: payload => post('import', { payload }),
      }
    }

    // -- hooks ------------------------------------------------------------------
    /** Load the weekly snapshot, refresh on week change, mutation, and a
     *  20-second revision poll (no push channel exists for plugin data). */
    function useScheduleData(api, timer, weekStart) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const weekRef = useRef(weekStart)
      weekRef.current = weekStart

      const refresh = useCallback(async () => {
        try {
          const snapshot = await api.snapshot(weekRef.current)
          setError(null)
          setData(prev => (prev !== null && prev.revision === snapshot.revision ? prev : snapshot))
        } catch (cause) {
          setError(cause.message ?? String(cause))
        }
      }, [api])

      useEffect(() => { void refresh() }, [refresh, weekStart])
      useEffect(() => {
        if (!timer) return undefined
        return timer.interval(() => { void refresh() }, 20_000)
      }, [timer, refresh])

      return { data, error, refresh }
    }

    /** Undo stack capped at 5 (§3.6): entries are {undo, redo, label}. */
    function useUndo(refresh) {
      const [stack, setStack] = useState([])
      const busy = useRef(false)
      const push = useCallback(entry => {
        setStack(prev => [...prev, entry].slice(-5))
      }, [])
      const undo = useCallback(async () => {
        if (busy.current) return
        const entry = stack[stack.length - 1]
        if (entry === undefined) return
        busy.current = true
        try {
          await entry.undo()
          setStack(prev => prev.slice(0, -1))
          await refresh()
        } finally {
          busy.current = false
        }
      }, [stack, refresh])
      return { push, undo, canUndo: stack.length > 0 }
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
      dateToZonedIso, isoDay, mondayOf, addDays, zonedAt,
      createApi, ApiError, useScheduleData, useUndo,
      Modal, ConfirmDialog, field,
    }
  },
})
