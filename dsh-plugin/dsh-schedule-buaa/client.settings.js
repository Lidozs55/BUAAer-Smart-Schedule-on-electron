/**
 * Settings cards of the BUAA source adapter: student id, JW sync, and the
 * legacy Electron dump import. Registered into the core's
 * `schedule.settings.blocks` slot, so they render inside the single
 * 日程设置 page (the core owns the term anchor and JSON export/import).
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule-buaa/client.settings.js',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    const API_PATH = '/api/buaa-schedule'

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

    const post = (op, payload) => globalThis.fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...payload }),
    }).then(parseResult)

    const api = {
      state: () => globalThis.fetch(API_PATH).then(parseResult),
      setMeta: patch => post('setMeta', { patch }),
      checkSession: () => post('checkSession', {}),
      startSync: creds => post('startSync', creds),
      importPayload: payload => post('import', { payload }),
    }

    const zh = {
      'settings.title': '北航教务导入',
      'settings.syncTitle': '教务同步',
      'settings.buaaId': '学号',
      'settings.termCode': '当前学期码',
      'settings.password': '统一认证密码（仅当次使用，不保存）',
      'settings.save': '保存',
      'settings.saved': '已保存',
      'settings.checkSession': '检查登录',
      'settings.sync': '立即同步',
      'settings.syncStarted': '同步已开始，进度见作业面板',
      'settings.syncDone': '同步完成：{summary}',
      'settings.legacyTitle': '旧版数据导入',
      'settings.legacyHint': '导入旧 Electron 版导出的 JSON（scripts/export-legacy-db.mjs 的产物）。当前格式的备份请用上方的「数据」。',
      'settings.import': '选择 JSON',
      'settings.imported': '导入完成：{summary}',
      'settings.importFail': '导入失败：{message}',
      'settings.needId': '请先填写并保存学号',
    }

    const en = {
      'settings.title': 'BUAA JW import',
      'settings.syncTitle': 'JW sync',
      'settings.buaaId': 'Student ID',
      'settings.termCode': 'Current term code',
      'settings.password': 'SSO password (this call only, not stored)',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.checkSession': 'Check login',
      'settings.sync': 'Sync now',
      'settings.syncStarted': 'Sync started; see the jobs panel',
      'settings.syncDone': 'Sync done: {summary}',
      'settings.legacyTitle': 'Legacy data import',
      'settings.legacyHint': 'Imports the JSON exported by the old Electron app (scripts/export-legacy-db.mjs). Use "Data" above for current-format backups.',
      'settings.import': 'Choose JSON',
      'settings.imported': 'Import done: {summary}',
      'settings.importFail': 'Import failed: {message}',
      'settings.needId': 'Save a student ID first',
    }

    const field = (labelText, input) =>
      h('div', { className: 'bsch-field' }, h('label', null, labelText), input)

    function SettingsSection(props) {
      const { t } = props
      const [state, setState] = useState(null)
      const [status, setStatus] = useState(null)
      const [password, setPassword] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => { void load() }, [])
      async function load() {
        try {
          setState(await api.state())
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        }
      }

      const saveMeta = async () => {
        setBusy(true)
        try {
          setState(await api.setMeta({ buaaId: state?.buaaId ?? '' }))
          setStatus({ ok: true, text: t('settings.saved') })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      const checkSession = async () => {
        setBusy(true)
        setStatus(null)
        try {
          const result = await api.checkSession()
          setStatus({ ok: result.ok, text: result.message })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      const sync = async () => {
        if ((state?.buaaId ?? '') === '') {
          setStatus({ ok: false, text: t('settings.needId') })
          return
        }
        setBusy(true)
        setStatus(null)
        try {
          const result = await api.startSync({ password })
          setStatus({
            ok: true,
            text: result.jobId !== undefined
              ? t('settings.syncStarted')
              : t('settings.syncDone').replace('{summary}', summarize(result.summary)),
          })
          setPassword('')
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      const importJson = async event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return
        setBusy(true)
        try {
          const counts = await api.importPayload(JSON.parse(await file.text()))
          setStatus({
            ok: true,
            text: t('settings.imported').replace('{summary}',
              `课程 ${counts.courses.created}，条目 ${counts.entries.created}（跳过 ${counts.entries.skipped}），任务 ${counts.tasks.created}（跳过 ${counts.tasks.skipped}）`),
          })
        } catch (cause) {
          setStatus({ ok: false, text: t('settings.importFail').replace('{message}', cause.message) })
        } finally {
          setBusy(false)
        }
      }

      // Cards, not a section: the core renders this block inside its own
      // 日程设置 page and supplies the `bsch-*` styling.
      return h(React.Fragment, null,
        h('div', { className: 'bsch-card' },
          h('h3', null, t('settings.title')),
          field(t('settings.buaaId'), h('input', {
            className: 'bsch-input', value: state?.buaaId ?? '', placeholder: '23xxxxxx',
            onChange: e => setState({ ...state, buaaId: e.target.value }),
          })),
          h('div', { className: 'bsch-rowline' },
            h('span', { className: 'bsch-hint' }, `${t('settings.termCode')}: ${state?.termCode || '—'}`),
            h('span', { className: 'bsch-spacer' }),
            h('button', {
              className: 'bsch-btn is-primary', disabled: busy,
              onClick: () => void saveMeta(),
            }, t('settings.save')))),
        h('div', { className: 'bsch-card' },
          h('h3', null, t('settings.syncTitle')),
          field(t('settings.password'), h('input', {
            className: 'bsch-input', type: 'password', value: password, autoComplete: 'off',
            onChange: e => setPassword(e.target.value),
          })),
          h('div', { className: 'bsch-rowline' },
            h('button', { className: 'bsch-btn', disabled: busy, onClick: () => void checkSession() },
              t('settings.checkSession')),
            h('span', { className: 'bsch-spacer' }),
            h('button', {
              className: 'bsch-btn is-primary', disabled: busy || password === '',
              onClick: () => void sync(),
            }, t('settings.sync')))),
        h('div', { className: 'bsch-card' },
          h('h3', null, t('settings.legacyTitle')),
          h('div', { className: 'bsch-hint' }, t('settings.legacyHint')),
          h('div', { className: 'bsch-rowline' },
            h('span', { className: 'bsch-spacer' }),
            h('label', { className: 'bsch-btn' },
              t('settings.import'),
              h('input', {
                type: 'file', accept: 'application/json', style: { display: 'none' },
                onChange: e => void importJson(e),
              })))),
        status !== null ? h('div', {
          className: `bsch-hint${status.ok ? '' : ' bsch-error'}`,
        }, status.text) : null)
    }

    const summarize = summary =>
      `${summary.daysFetched}/7 天，课程 ${summary.courses.total} 条，考试 ${summary.exams.total} 条`

    return { SettingsSection, zh, en }
  },
})
