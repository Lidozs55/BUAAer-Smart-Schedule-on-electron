/**
 * Settings card of the BUAA source adapter: student id, password, import.
 * Registered into the core's `schedule.settings.blocks` slot, so it renders
 * inside the single 日程设置 page.
 *
 * The term anchor is deliberately NOT duplicated here — the core card above
 * already owns it. This card only reports which term that anchor resolves
 * to, so the user can see the import will target the right semester.
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
      setStudentId: buaaId => post('setStudentId', { buaaId }),
      sync: creds => post('sync', creds),
    }

    const zh = {
      'settings.title': '北航教务导入',
      'settings.buaaId': '学号',
      'settings.save': '保存',
      'settings.saved': '已保存',
      'settings.password': '统一认证密码（仅当次使用，不保存）',
      'settings.sync': '导入整学期课表',
      'settings.needId': '请先填写并保存学号',
      'settings.needPassword': '请填写统一认证密码',
      'settings.needTermStart': '请先在上方填写「学期起始日期（第一周周一）」',
      'settings.syncing': '正在登录教务并导入…',
      'settings.term': '导入学期',
      'settings.unset': '学期起始日期未设置',
      'settings.done': '导入完成：课程 {courses} 条（新增 {created}、更新 {updated}、移除 {cleared}），覆盖第 {weeks} 周，考试 {exams} 条',
      'settings.overwrite': '每次导入覆盖整份课表：教务里已删除的课程会随之移除。',
      'settings.examFailed': '考试安排未能读取：{message}',
    }

    const en = {
      'settings.title': 'BUAA JW import',
      'settings.buaaId': 'Student ID',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.password': 'SSO password (this call only, not stored)',
      'settings.sync': 'Import whole term',
      'settings.needId': 'Save a student ID first',
      'settings.needPassword': 'Enter the SSO password',
      'settings.needTermStart': 'Set "Term start (Monday of week 1)" above first',
      'settings.syncing': 'Logging in and importing…',
      'settings.term': 'Import term',
      'settings.unset': 'Term start is not set',
      'settings.done': 'Imported {courses} courses ({created} new, {updated} updated, {cleared} removed), weeks {weeks}, {exams} exams',
      'settings.overwrite': 'Each import replaces the whole timetable: courses removed from JW disappear here.',
      'settings.examFailed': 'Exam list could not be read: {message}',
    }

    const field = (labelText, input, hint) =>
      h('div', { className: 'bsch-field' },
        h('label', null, labelText),
        input,
        hint === undefined ? null : h('div', { className: 'bsch-hint' }, hint))

    // The core kernel's cross-surface pulse (client.core.js owns the
    // contract): mounted schedule views refresh the moment a bulk write
    // lands instead of waiting out their 20-second revision poll. This
    // chunk stays self-contained, so it dispatches the literal event name.
    const notifyDataChanged = () => {
      window.dispatchEvent(new CustomEvent('schedule:data-changed'))
    }

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

      const saveId = async () => {
        setBusy(true)
        try {
          setState(await api.setStudentId(state?.buaaId ?? ''))
          setStatus({ ok: true, text: t('settings.saved') })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      const sync = async () => {
        setBusy(true)
        setStatus({ ok: true, text: t('settings.syncing') })
        try {
          // The term anchor lives on the core card, so re-read it here: the
          // user may have edited it since this card last loaded.
          const current = await api.state()
          setState(current)
          if (current.buaaId === '') throw new Error(t('settings.needId'))
          if (current.termStart === '') throw new Error(t('settings.needTermStart'))
          if (password === '') throw new Error(t('settings.needPassword'))
          const summary = await api.sync({ buaaId: current.buaaId, password })
          notifyDataChanged()
          setPassword('')
          setState(await api.state())
          setStatus({ ok: true, text: finishText(t, summary) })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'bsch-card' },
        h('h3', null, t('settings.title')),
        field(t('settings.buaaId'), h('div', { className: 'bsch-rowline' },
          h('input', {
            className: 'bsch-input', value: state?.buaaId ?? '', placeholder: '23xxxxxx',
            onChange: e => setState(current => ({ ...current, buaaId: e.target.value })),
          }),
          h('button', { className: 'bsch-btn', disabled: busy, onClick: () => void saveId() },
            t('settings.save')))),
        h('div', { className: 'bsch-hint' },
          `${t('settings.term')}: ${state?.termLabel || t('settings.unset')}`),
        field(t('settings.password'), h('input', {
          className: 'bsch-input', type: 'password', value: password, autoComplete: 'off',
          onChange: e => setPassword(e.target.value),
        })),
        h('div', { className: 'bsch-hint' }, t('settings.overwrite')),
        h('div', { className: 'bsch-rowline' },
          h('span', { className: 'bsch-spacer' }),
          h('button', {
            className: 'bsch-btn is-primary', disabled: busy,
            onClick: () => void sync(),
          }, t('settings.sync'))),
        status !== null ? h('div', {
          className: `bsch-hint${status.ok ? '' : ' bsch-error'}`,
        }, status.text) : null)
    }

    const finishText = (t, summary) => t('settings.done')
      .replace('{courses}', String(summary.courses.total))
      .replace('{created}', String(summary.courses.created))
      .replace('{updated}', String(summary.courses.updated))
      .replace('{cleared}', String(summary.courses.cleared))
      .replace('{weeks}', summary.weeksCovered.join('、'))
      .replace('{exams}', String(summary.exams.total))

    return { SettingsSection, zh, en }
  },
})