/**
 * Host half of @buaaer/dsh-schedule-buaa — the BUAA JW source adapter.
 *
 * Hard dependency: `scheduleCore` (the generic schedule core). This bundle
 * owns the BUAA-specific parts (student id, SSO login, JW endpoints, SPOC
 * assignments, parsing) and writes dated teaching/exam entries plus exam and
 * homework tasks through the core service. Removing it leaves the core and its
 * data untouched.
 *
 * One sync = one whole term: the JW timetable endpoint returns every cell of
 * the semester with its own week information, so there is no window, no
 * paging, and nothing to extrapolate. SPOC is a second application behind the
 * same CAS; its unsubmitted assignments become homework tasks, and its
 * memory-only session lets the host refresh deadlines while it runs.
 */
import { registerBuaaApi } from './host/api.js'
import { runSpocPoll, runSync } from './host/sync.js'
import { registerBuaaCommands } from './host/commands.js'
import {
  clearSession, fetchAssignments, hasSession, refreshAssignments, sessionSnapshot,
} from './host/spoc.js'
import {
  acquireSession, clearSession as clearSigninSession, hasSession as hasSigninSession,
  sessionSnapshot as signinSessionSnapshot, signinEntry,
} from './host/signin.js'

const SPOC_POLL_MS = 30 * 60_000

export const inject = ['scheduleCore', 'connection', 'scheduleCommands', 'timer']

export async function apply(ctx) {
  const service = ctx.scheduleCore
  // The session is module memory in spoc.js: credentials stay call-scoped, and
  // the token never reaches the store, the API payload or the CLI receipt.
  const spoc = { fetchAssignments, refreshAssignments, hasSession, sessionSnapshot, clearSession }
  // iclass has its own memory-only login session (userId/sessionId); the
  // remote check-in button uses it after the call-scoped password is gone.
  const signin = {
    acquireSession,
    clearSession: clearSigninSession,
    hasSession: hasSigninSession,
    sessionSnapshot: signinSessionSnapshot,
    signinEntry,
  }
  let syncing = false
  let active = true
  const deps = {
    service, spoc, signin,
    isSyncing: () => syncing,
    runSync: async creds => {
      if (syncing) throw Object.assign(new Error('正在同步，请稍后重试'), { code: 'busy' })
      syncing = true
      try {
        return await runSync({ service, spoc, signin, isActive: () => active }, creds)
      } finally {
        if (!active) {
          clearSession()
          clearSigninSession()
        }
        syncing = false
      }
    },
  }

  ctx.effect(() => () => {
    active = false
    clearSession()
    clearSigninSession()
  }, 'buaa-schedule: memory sessions')

  ctx.effect(() => registerBuaaCommands(ctx.scheduleCommands, deps), 'buaa-schedule: commands')
  ctx.effect(() => registerBuaaApi(ctx, deps), 'buaa-schedule: api')

  // Homework deadlines move, so SPOC is re-read while the host is alive. There
  // is no password here: after a restart the session is gone and this tick is
  // a no-op until one manual sync rebuilds it.
  ctx.effect(() => ctx.timer.interval(async () => {
    if (!active || syncing) return
    syncing = true
    try {
      await runSpocPoll({ service, spoc })
    } catch {
      ctx.logger.warn('buaa-schedule: SPOC poll failed')
    } finally {
      syncing = false
    }
  }, SPOC_POLL_MS), 'buaa-schedule: SPOC poll')

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'buaa-schedule',
      order: 1001,
      text: () => [
        '北航教务导入插件已启用：用 `schedule buaa sync` 一次导入整学期课表、考试与 SPOC 未提交作业；先运行 `schedule buaa --help`。',
        '密码仅当次使用、不保存：用 --password-stdin 或 --password-env，不要写进普通命令行参数；学期起点已保存在日程设置里则不必重复给。',
        '导入是整学期快照：课表自带的周次即最终周次，重复导入会替换此前的教学与考试日程，未排课的空缺不会被外推。',
        'SPOC 作业按「课程 + 作业名」对账为 homework 待办并更新截止时间；已提交的作业不生成待办，用户手建的同名任务只校正 due。',
        'SPOC 会话只存在于宿主进程内存：重启后需再手动同步一次，之后的 30 分钟轮询才会继续；关闭 SPOC 开关会同时清除会话。',
        '手动同步也会建立 iclass 课堂签到会话（同样只在内存）：当天北航课程条目的「远程签到」按钮用它提交签到；会话失效或宿主重启后需再手动同步一次。',
        '本插件生成锁定的课程与考试条目，并保留考试待办；课程用当前 course 类别、考试用 exam，类别已删除时归 other，不恢复已删除类别。锁定仅防快捷拖动，仍可显式编辑或删除。',
        '导入以 CLI 的统计回执为准，不再手工补建同批条目或读取内部文件校验；不要在回复中复述密码。',
      ].join('\n'),
    }), 'buaa-schedule: prompt section')
  }

  ctx.logger.info('buaa-schedule: BUAA source adapter active')
}