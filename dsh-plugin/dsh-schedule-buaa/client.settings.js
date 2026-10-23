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
    const api = require('@buaaer/dsh-schedule-buaa/client.api.js')

    const zh = {
      'settings.title': '北航教务导入',
      'settings.buaaId': '学号',
      'settings.save': '保存',
      'settings.saved': '已保存',
      'settings.password': '统一认证密码',
      'settings.passwordHint': '仅用于本次导入，不保存。',
      'settings.homework': '作业同步', 'settings.signin': '远程签到',
      'settings.sync': '立即导入',
      'settings.needId': '请先填写并保存学号',
      'settings.needPassword': '请填写统一认证密码',
      'settings.needTermStart': '请先设置学期起点（第一周周一）',
      'settings.syncing': '正在登录教务并导入…',
      'settings.term': '导入学期',
      'settings.unset': '学期起始日期未设置',
      'settings.done': '导入完成：日程 {entries} 条（新增 {created}、更新 {updated}、移除 {cleared}），覆盖第 {weeks} 周，考试 {exams} 条',
      'settings.overwrite': '导入将替换本学期课表与考试。',
      'settings.examFailed': '考试安排未能读取：{message}',
      'settings.spocEnabled': '同步 SPOC 未提交作业',
      'settings.spocOn': '已开启 SPOC 作业同步',
      'settings.spocOff': '已关闭 SPOC 作业同步',
      'settings.spocDisabled': '已关闭；不影响课表与考试导入。',
      'settings.spocNoSession': '请导入一次以启用；应用重启后需重新导入。',
      'settings.spocSession': '已连接 · {term}',
      'settings.spocLast': '上次同步：{time}',
      'settings.spocNever': '尚未同步',
      'settings.spocDone': 'SPOC 作业：新增 {created}、更新 {updated}、移除 {removed}，已提交 {submitted} 条不生成待办',
      'settings.spocFailed': 'SPOC 作业同步失败：{message}',
      'settings.spocSkipped': 'SPOC 同步已跳过（设置或会话已变更）',
      'settings.signinSession': '已就绪 · {user}',
      'settings.signinNoSession': '导入后可用；应用重启后需重新导入。',
      'settings.signinFailed': '远程签到会话建立失败：{message}',
      'settings.signinDone': '远程签到已就绪：当天北航课程条目里可直接签到',
    }

    const en = {
      'settings.title': 'BUAA JW import',
      'settings.buaaId': 'Student ID',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.password': 'SSO password',
      'settings.passwordHint': 'Used for this import only. Never saved.',
      'settings.homework': 'Homework sync', 'settings.signin': 'Remote check-in',
      'settings.sync': 'Import now',
      'settings.needId': 'Save a student ID first',
      'settings.needPassword': 'Enter the SSO password',
      'settings.needTermStart': 'Set "Term start (Monday of week 1)" above first',
      'settings.syncing': 'Logging in and importing…',
      'settings.term': 'Import term',
      'settings.unset': 'Term start is not set',
      'settings.done': 'Imported {entries} schedule entries ({created} new, {updated} updated, {cleared} removed), weeks {weeks}, {exams} exams',
      'settings.overwrite': 'Replaces this term’s imported classes and exams.',
      'settings.examFailed': 'Exam list could not be read: {message}',
      'settings.spocEnabled': 'Also sync unsubmitted SPOC homework',
      'settings.spocOn': 'SPOC homework sync is on',
      'settings.spocOff': 'SPOC homework sync is off',
      'settings.spocDisabled': 'Off. Classes and exams still import.',
      'settings.spocNoSession': 'Import once to enable. Import again after restarting the app.',
      'settings.spocSession': 'Connected · {term}',
      'settings.spocLast': 'Last sync: {time}',
      'settings.spocNever': 'never',
      'settings.spocDone': 'SPOC homework: {created} new, {updated} updated, {removed} removed; {submitted} submitted items skipped',
      'settings.spocFailed': 'SPOC homework sync failed: {message}',
      'settings.spocSkipped': 'SPOC sync skipped (settings or session changed)',
      'settings.signinSession': 'Ready · {user}',
      'settings.signinNoSession': 'Available after import. Import again after restarting the app.',
      'settings.signinFailed': 'Remote check-in session could not be established: {message}',
      'settings.signinDone': 'Remote check-in is ready on today\'s BUAA course entries',
    }

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

      const toggleSpoc = async enabled => {
        setBusy(true)
        try {
          setState(await api.setSpocEnabled(enabled))
          setStatus({ ok: true, text: enabled ? t('settings.spocOn') : t('settings.spocOff') })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      const spocSession = state?.spocSession
      const spocHint = state?.spocEnabled === false
        ? t('settings.spocDisabled')
        : spocSession === null || spocSession === undefined
          ? t('settings.spocNoSession')
          : t('settings.spocSession')
            .replace('{user}', spocSession.username ?? '')
            .replace('{term}', spocSession.termName || spocSession.termCode || '—')

      const signinSession = state?.signinSession
      const signinHint = signinSession === null || signinSession === undefined
        ? t('settings.signinNoSession')
        : t('settings.signinSession').replace('{user}', signinSession.username ?? '')

      return h('section', { className: 'bsch-settings-section', 'aria-labelledby': 'bsch-buaa-heading' },
        h('h3', { className: 'bsch-settings-heading', id: 'bsch-buaa-heading' }, t('settings.title')),
        h('div', { className: 'bsch-setting-row' },
          h('label', { className: 'bsch-setting-label', htmlFor: 'bsch-buaa-id' }, t('settings.buaaId')),
          h('div', { className: 'bsch-settings-inline' },
            h('input', {
              id: 'bsch-buaa-id', className: 'bsch-input', value: state?.buaaId ?? '', placeholder: '23xxxxxx',
              onChange: e => setState(current => ({ ...current, buaaId: e.target.value })),
            }),
            h('button', { className: 'bsch-btn', disabled: busy, onClick: () => void saveId() }, t('settings.save')))),
        h('div', { className: 'bsch-setting-row' },
          h('span', { className: 'bsch-setting-label' }, t('settings.term')),
          h('div', { className: 'bsch-setting-control bsch-setting-value' }, state?.termLabel || t('settings.unset'))),
        h('div', { className: 'bsch-setting-row' },
          h('label', { className: 'bsch-setting-label', htmlFor: 'bsch-buaa-password' }, t('settings.password')),
          h('div', { className: 'bsch-setting-control' },
            h('input', {
              id: 'bsch-buaa-password', 'aria-describedby': 'bsch-buaa-password-hint',
              className: 'bsch-input', type: 'password', value: password, autoComplete: 'off',
              onChange: e => setPassword(e.target.value),
            }),
            h('div', { className: 'bsch-hint', id: 'bsch-buaa-password-hint' }, t('settings.passwordHint')))),
        h('div', { className: 'bsch-setting-row' },
          h('span', { className: 'bsch-setting-label' }, t('settings.homework')),
          h('div', { className: 'bsch-setting-control' },
            h('label', { className: 'bsch-setting-toggle' },
              h('input', {
                className: 'bsch-check', type: 'checkbox', checked: state?.spocEnabled !== false, disabled: busy,
                onChange: e => void toggleSpoc(e.target.checked),
              }), h('span', null, t('settings.spocEnabled'))),
            h('div', { className: 'bsch-hint' }, spocHint),
            state?.spocEnabled === false ? null : h('div', { className: 'bsch-hint' },
              t('settings.spocLast').replace('{time}', state?.spocLastSyncAt ? formatTime(state.spocLastSyncAt) : t('settings.spocNever'))),
            state?.spocError ? h('div', { className: 'bsch-hint bsch-error', role: 'alert' },
              t('settings.spocFailed').replace('{message}', state.spocError)) : null)),
        h('div', { className: 'bsch-setting-row' },
          h('span', { className: 'bsch-setting-label' }, t('settings.signin')),
          h('div', { className: 'bsch-setting-control bsch-setting-value' },
            h('div', { className: 'bsch-hint' }, signinHint),
            state?.signinError ? h('div', { className: 'bsch-hint bsch-error', role: 'alert' },
              t('settings.signinFailed').replace('{message}', state.signinError)) : null)),
        h('div', { className: 'bsch-settings-actions' },
          h('span', { className: 'bsch-hint' }, t('settings.overwrite')),
          h('button', {
            className: 'bsch-btn is-primary', disabled: busy, onClick: () => void sync(),
          }, t('settings.sync'))),
        status !== null ? h('div', {
          role: status.ok ? 'status' : 'alert', className: `bsch-hint bsch-settings-status${status.ok ? '' : ' bsch-error'}`,
        }, status.text) : null)
    }

    const formatTime = value => {
      const parsed = new Date(value)
      return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value
    }

    const finishText = (t, summary) => {
      let text = t('settings.done')
        .replace('{entries}', String(summary.entries.total))
        .replace('{created}', String(summary.entries.created))
        .replace('{updated}', String(summary.entries.updated))
        .replace('{cleared}', String(summary.entries.cleared))
        .replace('{weeks}', summary.weeksCovered.join('、'))
        .replace('{exams}', String(summary.exams.total))
        + (summary.exams.failed ? `；${t('settings.examFailed').replace('{message}', summary.exams.failed)}` : '')
      if (summary.spoc !== undefined) {
        text += typeof summary.spoc.skipped === 'string'
          ? `；${t('settings.spocSkipped')}`
          : summary.spoc.failed
            ? `；${t('settings.spocFailed').replace('{message}', summary.spoc.failed)}`
            : `；${t('settings.spocDone')
            .replace('{created}', String(summary.spoc.created))
            .replace('{updated}', String(summary.spoc.updated))
            .replace('{removed}', String(summary.spoc.removed))
            .replace('{submitted}', String(summary.spoc.submitted))}`
      }
      if (summary.signin !== undefined) {
        text += summary.signin.failed
          ? `；${t('settings.signinFailed').replace('{message}', summary.signin.failed)}`
          : `；${t('settings.signinDone')}`
      }
      return text
    }

    return { SettingsSection, zh, en }
  },
})