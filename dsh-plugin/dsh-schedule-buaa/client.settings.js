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
      'settings.password': '统一认证密码（仅当次使用，不保存）',
      'settings.sync': '导入课表、考试与 SPOC 作业',
      'settings.needId': '请先填写并保存学号',
      'settings.needPassword': '请填写统一认证密码',
      'settings.needTermStart': '请先在上方填写「学期起始日期（第一周周一）」',
      'settings.syncing': '正在登录教务并导入…',
      'settings.term': '导入学期',
      'settings.unset': '学期起始日期未设置',
      'settings.done': '导入完成：日程 {entries} 条（新增 {created}、更新 {updated}、移除 {cleared}），覆盖第 {weeks} 周，考试 {exams} 条',
      'settings.overwrite': '每次导入替换整学期教学与考试日程：教务里已删除的安排会随之移除。',
      'settings.examFailed': '考试安排未能读取：{message}',
      'settings.spocEnabled': '同步 SPOC（智学北航）未提交作业',
      'settings.spocOn': '已开启 SPOC 作业同步',
      'settings.spocOff': '已关闭 SPOC 作业同步，并清除内存中的会话',
      'settings.spocDisabled': 'SPOC 同步已关闭；课表与考试仍会正常导入。',
      'settings.spocNoSession': 'SPOC 会话未建立：手动同步一次后生效；宿主重启后需再同步一次。',
      'settings.spocSession': 'SPOC 会话：{user} · {term}（仅保存在内存中）',
      'settings.spocLast': '上次 SPOC 同步：{time}',
      'settings.spocNever': '尚未同步',
      'settings.spocDone': 'SPOC 作业：新增 {created}、更新 {updated}、移除 {removed}，已提交 {submitted} 条不生成待办',
      'settings.spocFailed': 'SPOC 作业同步失败：{message}',
      'settings.spocSkipped': 'SPOC 同步已跳过（设置或会话已变更）',
      'settings.signinSession': '远程签到会话：{user}（仅保存在内存中）',
      'settings.signinNoSession': '远程签到会话未建立：手动同步一次后生效；宿主重启后需再同步一次。',
      'settings.signinFailed': '远程签到会话建立失败：{message}',
      'settings.signinDone': '远程签到已就绪：当天北航课程条目里可直接签到',
    }

    const en = {
      'settings.title': 'BUAA JW import',
      'settings.buaaId': 'Student ID',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.password': 'SSO password (this call only, not stored)',
      'settings.sync': 'Import schedule, exams and SPOC homework',
      'settings.needId': 'Save a student ID first',
      'settings.needPassword': 'Enter the SSO password',
      'settings.needTermStart': 'Set "Term start (Monday of week 1)" above first',
      'settings.syncing': 'Logging in and importing…',
      'settings.term': 'Import term',
      'settings.unset': 'Term start is not set',
      'settings.done': 'Imported {entries} schedule entries ({created} new, {updated} updated, {cleared} removed), weeks {weeks}, {exams} exams',
      'settings.overwrite': 'Each import replaces all teaching and exam entries from JW.',
      'settings.examFailed': 'Exam list could not be read: {message}',
      'settings.spocEnabled': 'Also sync unsubmitted SPOC homework',
      'settings.spocOn': 'SPOC homework sync is on',
      'settings.spocOff': 'SPOC homework sync is off; the in-memory session was cleared',
      'settings.spocDisabled': 'SPOC sync is off; schedule and exams still import normally.',
      'settings.spocNoSession': 'No SPOC session: run one manual sync. A host restart requires another sync.',
      'settings.spocSession': 'SPOC session: {user} · {term} (memory only)',
      'settings.spocLast': 'Last SPOC sync: {time}',
      'settings.spocNever': 'never',
      'settings.spocDone': 'SPOC homework: {created} new, {updated} updated, {removed} removed; {submitted} submitted items skipped',
      'settings.spocFailed': 'SPOC homework sync failed: {message}',
      'settings.spocSkipped': 'SPOC sync skipped (settings or session changed)',
      'settings.signinSession': 'Remote check-in session: {user} (memory only)',
      'settings.signinNoSession': 'No remote check-in session: run one manual sync. A host restart requires another sync.',
      'settings.signinFailed': 'Remote check-in session could not be established: {message}',
      'settings.signinDone': 'Remote check-in is ready on today\'s BUAA course entries',
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
        h('div', { className: 'bsch-rowline' },
          h('label', {
            style: {
              display: 'flex', alignItems: 'center', gap: '6px',
              cursor: busy ? 'default' : 'pointer',
            },
          },
          h('input', {
            className: 'bsch-check', type: 'checkbox',
            checked: state?.spocEnabled !== false,
            disabled: busy,
            onChange: e => void toggleSpoc(e.target.checked),
          }),
          h('span', null, t('settings.spocEnabled')))),
        h('div', { className: 'bsch-hint' }, spocHint),
        state?.spocEnabled === false ? null : h('div', { className: 'bsch-hint' },
          t('settings.spocLast').replace('{time}', state?.spocLastSyncAt
            ? formatTime(state.spocLastSyncAt)
            : t('settings.spocNever'))),
        state?.spocError ? h('div', { className: 'bsch-hint bsch-error' },
          t('settings.spocFailed').replace('{message}', state.spocError)) : null,
        h('div', { className: 'bsch-hint' }, signinHint),
        state?.signinError ? h('div', { className: 'bsch-hint bsch-error' },
          t('settings.signinFailed').replace('{message}', state.signinError)) : null,
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