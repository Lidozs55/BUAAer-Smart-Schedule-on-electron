/**
 * BUAA entry action: remote classroom check-in on today's teaching entries.
 *
 * The core declares `schedule.entry.actions` and renders it inside the entry
 * editor with `{ entry }` as owner props. This chunk registers one action for
 * entries created by the BUAA source. It deliberately does not decide which
 * iclass row to sign: the host looks the entry up, matches today's iclass rows
 * by course name + time, and only then submits. A stale or forged entry id
 * therefore cannot point the button at an arbitrary course.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule-buaa/client.signin.js',
  factory: (require) => {
    const React = require('react')
    const { useState } = React
    const h = React.createElement
    const api = require('@buaaer/dsh-schedule-buaa/client.api.js')

    const zh = {
      'signin.action': '远程签到',
      'signin.busy': '签到中…',
      'signin.hint': '使用手动同步建立的 iclass 会话；仅当天课程可用，结果以学校系统为准。',
      'signin.success': '签到成功',
      'signin.failed': '签到失败',
    }

    const en = {
      'signin.action': 'Remote check-in',
      'signin.busy': 'Checking in…',
      'signin.hint': "Uses the iclass session from the last manual sync; available for today's classes only.",
      'signin.success': 'Checked in',
      'signin.failed': 'Check-in failed',
    }

    const dateFormat = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    })

    const chinaDateKey = value => {
      const date = value instanceof Date ? value : new Date(value)
      if (!Number.isFinite(date.getTime())) return ''
      const parts = {}
      for (const part of dateFormat.formatToParts(date)) parts[part.type] = part.value
      return `${parts.year}-${parts.month}-${parts.day}`
    }

    /** Only today's BUAA teaching entries can check in; other sources are untouched. */
    const canCheckin = entry => entry !== null && typeof entry === 'object'
      && entry.source === 'buaa'
      && typeof entry.sourceKey === 'string'
      && entry.sourceKey.startsWith('teaching:')
      && chinaDateKey(entry.start) !== ''
      && chinaDateKey(entry.start) === chinaDateKey(new Date())

    function SigninAction(props) {
      const { t, entry } = props
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(null)

      if (!canCheckin(entry)) return null

      const submit = async () => {
        setBusy(true)
        setStatus(null)
        try {
          const result = await api.signin(entry.id)
          setStatus({
            ok: result?.success !== false,
            text: result?.message || t(result?.success === false ? 'signin.failed' : 'signin.success'),
          })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message ?? String(cause) })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'bsch-field' },
        h('div', { className: 'bsch-rowline' },
          h('button', {
            className: 'bsch-btn is-primary', type: 'button', disabled: busy,
            onClick: () => void submit(),
          }, busy ? t('signin.busy') : t('signin.action')),
          h('span', { className: 'bsch-hint' }, t('signin.hint'))),
        status !== null ? h('div', {
          className: `bsch-hint${status.ok ? '' : ' bsch-error'}`,
          role: status.ok ? 'status' : 'alert',
        }, status.text) : null)
    }

    return { SigninAction, canCheckin, chinaDateKey, zh, en }
  },
})
