import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acquireSession, chinaClock, clearSession, extractLoginName, fetchTodayClasses,
  hasSession, matchClassForEntry, parseSigninClasses, performSignin,
  resolveRedirectUrl, sanitizeSigninMessage, signinDateString, signinEntry,
} from '../host/signin.js'

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const jar = { header: () => '', store() {} }

function entry(extra = {}) {
  return {
    id: 'e1', title: '软件工程', source: 'buaa',
    sourceKey: 'teaching:软件工程:2026-10-22:08:00',
    start: '2026-10-22T08:00:00+08:00', end: '2026-10-22T09:40:00+08:00',
    ...extra,
  }
}

test('iclass errors and successful sign-ins never expose upstream secrets', async t => {
  const originalFetch = globalThis.fetch
  const secret = 'SYNTHETIC_ICLASS_SECRET_MARKER'
  const rawMessage = `https://example.invalid/?opaque=${secret}`
  t.after(() => { globalThis.fetch = originalFetch; clearSession() })
  let mode = 'login'
  globalThis.fetch = async url => {
    const target = new URL(url)
    if (target.port === '8346') return new Response(null, {
      status: 302, headers: { Location: 'https://iclass.buaa.edu.cn:8346/?loginName=test-only' },
    })
    if (target.pathname === '/app/user/login.action') return mode === 'login'
      ? json({ STATUS: 500, ERRMSG: rawMessage })
      : json({ STATUS: 0, result: { id: 'test-user', sessionId: 'test-session' } })
    if (target.pathname === '/app/course/get_stu_course_sched.action') {
      if (mode === 'classes-network') throw new Error(rawMessage)
      return json({ STATUS: 500, ERRMSG: mode === 'classes-auth' ? `未登录 ${rawMessage}` : rawMessage })
    }
    if (target.pathname === '/app/common/get_timestamp.action') {
      if (mode === 'timestamp-network') throw new Error(rawMessage)
      return json({ timestamp: '1690000000' })
    }
    if (target.pathname === '/eschool/app/course/stu_scan_sign.action') {
      if (mode === 'sign-network') throw new Error(rawMessage)
      return json({
        STATUS: mode === 'sign-success' ? 0 : 500,
        result: { stuSignStatus: mode === 'sign-success' ? '1' : '0' },
        ERRMSG: mode === 'sign-auth' ? `未登录 ${rawMessage}`
          : mode === 'sign-already' ? `已签到 ${rawMessage}` : rawMessage,
      })
    }
    throw new Error('Unexpected iclass request')
  }
  const credentials = { jar, username: 'security-test', password: 'test-only' }
  const safeError = (code, message) => error => {
    assert.equal(error.code, code)
    assert.equal(error.message, message)
    assert.equal(String(error).includes(secret), false)
    assert.equal(JSON.stringify(error).includes(secret), false)
    return true
  }
  await assert.rejects(acquireSession(credentials), safeError('auth', 'iclass 登录失败'))
  mode = 'classes-data'
  await acquireSession(credentials)
  await assert.rejects(fetchTodayClasses(), safeError('data', 'iclass 课表读取失败'))
  mode = 'classes-network'
  await assert.rejects(fetchTodayClasses(), safeError('network', 'iclass 课表读取失败，请稍后重试'))
  mode = 'classes-auth'
  await assert.rejects(fetchTodayClasses(), safeError('auth', 'iclass 登录状态失效，请先手动同步一次'))
  assert.equal(hasSession(), false)
  mode = 'sign-success'
  await acquireSession(credentials)
  for (const [nextMode, expected] of [
    ['sign-success', { success: true, message: '签到成功', status: 1 }],
    ['sign-failure', { success: false, message: '签到失败，请稍后重试', status: 0 }],
    ['sign-already', { success: false, message: '您今天已经签到过了', status: 0 }],
  ]) {
    mode = nextMode
    assert.deepEqual(await performSignin('test-course'), expected)
  }
  mode = 'timestamp-network'
  await assert.rejects(performSignin('test-course'), safeError('network', '获取服务器时间失败，请稍后重试'))
  mode = 'sign-network'
  await assert.rejects(performSignin('test-course'), safeError('network', '签到请求失败，请稍后重试'))
  mode = 'sign-auth'
  assert.deepEqual(await performSignin('test-course'), {
    success: false, message: '签到会话已失效，请先手动同步一次', status: 0,
  })
  assert.equal(hasSession(), false)
  assert.equal(sanitizeSigninMessage(true, rawMessage), '签到成功')
})

test('loginName parsing keeps base64 plus signs and follows encoded values', () => {
  assert.equal(extractLoginName('https://iclass.buaa.edu.cn:8346/?loginName=abc%2Bdef&type=jumpMyCenter'), 'abc+def')
  assert.equal(extractLoginName('https://x/?LOGINNAME=abc+def#/MyCenter'), 'abc+def')
  assert.equal(extractLoginName('https://x/?type=jumpMyCenter'), null)
  assert.equal(extractLoginName('https://x/?loginName=&type=jumpMyCenter'), null)
  assert.equal(extractLoginName('not a url'), null)
  assert.equal(resolveRedirectUrl('https://iclass.buaa.edu.cn:8346/?type=jumpMyCenter', '/?loginName=x'), 'https://iclass.buaa.edu.cn:8346/?loginName=x')
  assert.equal(resolveRedirectUrl('https://x/a', '//y/b'), 'https://y/b')
  assert.equal(resolveRedirectUrl('https://x/a', ''), null)
})

test('class rows tolerate string/number flags and match by name + China wall time', () => {
  const classes = parseSigninClasses({
    STATUS: 0,
    result: [
      { id: 'c1', courseName: '软件 工程', classBeginTime: '2026-10-22 08:00:00', classEndTime: '2026-10-22 09:40:00', signStatus: '0' },
      { id: 'c2', courseName: '大学物理', classBeginTime: '2026-10-22T10:00:00', classEndTime: '2026-10-22T11:40:00', signStatus: 1 },
    ],
  })
  assert.deepEqual(classes[0], {
    courseId: 'c1', courseName: '软件 工程',
    classBeginTime: '2026-10-22 08:00:00', classEndTime: '2026-10-22 09:40:00', signStatus: 0,
  })
  assert.equal(classes[1].signStatus, 1)
  assert.equal(matchClassForEntry(classes, entry())?.courseId, 'c1')
  assert.equal(matchClassForEntry(classes, entry({ title: '软件工程', end: '2026-10-22T09:40:00+08:00' }))?.courseId, 'c1')
  assert.equal(matchClassForEntry(classes, entry({ title: '不存在' })), null)
  assert.equal(matchClassForEntry(classes, entry({ end: '2026-10-22T09:45:00+08:00' }))?.courseId, 'c1')
})

test('China dates and check-in messages are stable regardless of host timezone', () => {
  assert.deepEqual(chinaClock('2026-10-21T16:30:00Z'), { date: '2026-10-22', time: '00:30' })
  assert.equal(signinDateString(new Date('2026-10-21T16:30:00Z')), '20261022')
  assert.equal(sanitizeSigninMessage(true, ''), '签到成功')
  assert.equal(sanitizeSigninMessage(true, '签到成功'), '签到成功')
  assert.equal(sanitizeSigninMessage(false, '您已签到'), '您今天已经签到过了')
  assert.equal(sanitizeSigninMessage(false, '未开始'), '当前还未到签到时间')
  assert.equal(sanitizeSigninMessage(false, '不是上课时间'), '当前不是上课时间，无法签到')
  assert.equal(sanitizeSigninMessage(false, '已结束'), '本次签到已结束')
  assert.equal(sanitizeSigninMessage(false, '范围外'), '当前不在可签到范围内')
  assert.equal(sanitizeSigninMessage(false, '用户不存在'), '签到账号不存在，请联系管理员')
  assert.equal(sanitizeSigninMessage(false, '课程不存在'), '未找到对应课程，请刷新后重试')
  assert.equal(sanitizeSigninMessage(false, '<html>oops</html>'), '签到失败，请稍后重试')
})

test('manual sync acquires an iclass session and the entry action signs the matching row', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
    clearSession()
  })
  clearSession()

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    calls.push({ target, init })
    if (target === 'https://iclass.buaa.edu.cn:8346/?type=jumpMyCenter') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://iclass.buaa.edu.cn:8346/?loginName=abc%2Bdef&type=jumpMyCenter#/MyCenter' },
      })
    }
    if (target.startsWith('https://iclass.buaa.edu.cn:8347/app/user/login.action')) {
      assert.match(target, /phone=abc%2Bdef/)
      return json({ STATUS: 0, result: { id: 'user-1', sessionId: 'session-1' } })
    }
    if (target.startsWith('https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action')) {
      assert.equal(init.headers.sessionId, 'session-1')
      assert.match(target, /dateStr=20261022/)
      return json({
        STATUS: '0',
        result: [{
          id: 'course-1', courseName: '软件工程', classBeginTime: '08:00',
          classEndTime: '09:40', signStatus: '0',
        }],
      })
    }
    if (target === 'http://iclass.buaa.edu.cn:8081/app/common/get_timestamp.action') {
      return json({ timestamp: '1690000000' })
    }
    if (target.startsWith('http://iclass.buaa.edu.cn:8081/eschool/app/course/stu_scan_sign.action')) {
      assert.equal(init.method, 'POST')
      assert.equal(init.headers.sessionId, 'session-1')
      assert.match(target, /courseSchedId=course-1/)
      assert.match(target, /timestamp=1690000000/)
      assert.equal(init.body, 'id=user-1')
      return json({ STATUS: 0, result: { stuSignStatus: '1' }, ERRMSG: '签到成功' })
    }
    throw new Error(`unexpected request ${target}`)
  }

  await acquireSession({ jar, username: '23370001', password: 'test-only' })
  assert.equal(hasSession(), true)
  const classes = await fetchTodayClasses({ now: new Date('2026-10-22T02:00:00Z') })
  assert.equal(classes.length, 1)
  assert.deepEqual(await performSignin('course-1'), { success: true, message: '签到成功', status: 1 })

  const result = await signinEntry(entry(), { now: new Date('2026-10-22T02:00:00Z') })
  assert.equal(result.success, true)
  assert.equal(result.courseId, 'course-1')
  assert.equal(result.courseName, '软件工程')
})

test('an already-signed row short-circuits without submitting again; a non-today entry is refused', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    clearSession()
  })
  clearSession()

  let signCalls = 0
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target === 'https://iclass.buaa.edu.cn:8346/?type=jumpMyCenter') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://iclass.buaa.edu.cn:8346/?loginName=abc&type=jumpMyCenter' },
      })
    }
    if (target.startsWith('https://iclass.buaa.edu.cn:8347/app/user/login.action')) {
      return json({ STATUS: 0, result: { id: 'user-1', sessionId: 'session-1' } })
    }
    if (target.startsWith('https://iclass.buaa.edu.cn:8347/app/course/get_stu_course_sched.action')) {
      return json({
        STATUS: 0,
        result: [{
          id: 'course-1', courseName: '软件工程', classBeginTime: '08:00',
          classEndTime: '09:40', signStatus: 1,
        }],
      })
    }
    if (target.startsWith('http://iclass.buaa.edu.cn:8081/')) {
      signCalls += 1
      throw new Error('should not reach sign endpoints')
    }
    throw new Error(`unexpected request ${target}`)
  }

  await acquireSession({ jar, username: '23370001', password: 'test-only' })
  const result = await signinEntry(entry(), { now: new Date('2026-10-22T02:00:00Z') })
  assert.equal(result.success, true)
  assert.equal(result.message, '您今天已经签到过了')
  assert.equal(signCalls, 0)

  await assert.rejects(
    signinEntry(entry(), { now: new Date('2026-10-23T02:00:00Z') }),
    /只能签到今天的课程/,
  )
})

test('sessionless reads fail with an actionable message instead of retrying credentials', async () => {
  clearSession()
  await assert.rejects(fetchTodayClasses(), /会话不存在/)
  await assert.rejects(performSignin('course-1'), /会话不存在/)
})

function mockLogin(t) {
  const original = globalThis.fetch
  let logins = 0
  clearSession()
  t.after(() => { globalThis.fetch = original; clearSession() })
  globalThis.fetch = async url => {
    if (new URL(url).port === '8346') return new Response(null, {
      status: 302, headers: { Location: 'https://iclass.buaa.edu.cn:8346/?loginName=test' },
    })
    logins += 1
    return json({ STATUS: 0, result: { id: 'user-a', sessionId: `session-${logins}` } })
  }
  return { count: () => logins, credentials: { jar, username: 'student-a', password: 'test-only' } }
}

test('iclass login transport failures never expose credential-bearing URLs', async t => {
  const h = mockLogin(t)
  globalThis.fetch = async () => { throw new Error('failed ?sessionId=SYNTHETIC_TRANSPORT_SECRET') }
  await assert.rejects(acquireSession(h.credentials), error => error.code === 'network'
    && !error.message.includes('SYNTHETIC_TRANSPORT_SECRET'))
  assert.equal(hasSession(), false)
})

test('each manual sync reacquires iclass instead of trusting a possibly expired session', async t => {
  const h = mockLogin(t)
  await acquireSession(h.credentials)
  await acquireSession(h.credentials)
  assert.equal(h.count(), 2)
})

test('overlapping iclass logins cannot return the first account session to another user', async t => {
  const h = mockLogin(t)
  const pending = acquireSession(h.credentials)
  await assert.rejects(acquireSession({ ...h.credentials, username: 'student-b' }), { code: 'busy' })
  await pending
  assert.equal(hasSession(), true)
})

test('clearing iclass during login rejects the obsolete result', async t => {
  const h = mockLogin(t)
  const pending = acquireSession(h.credentials)
  clearSession()
  await assert.rejects(pending, { code: 'cancelled' })
  assert.equal(hasSession(), false)
})

test('a late iclass auth failure cannot clear a replacement account session', async t => {
  const h = mockLogin(t)
  await acquireSession(h.credentials)
  const loginFetch = globalThis.fetch
  let release
  globalThis.fetch = (url, init) => String(url).includes('/get_stu_course_sched.action')
    ? new Promise(resolve => { release = resolve })
    : loginFetch(url, init)
  const pending = fetchTodayClasses()
  const rejected = assert.rejects(pending, { code: 'auth' })
  await acquireSession({ ...h.credentials, username: 'student-b' })
  release(new Response(null, { status: 401 }))
  await rejected
  assert.equal(hasSession(), true)
})

test('an account switch while reading the timestamp never submits attendance', async t => {
  const h = mockLogin(t)
  await acquireSession(h.credentials)
  const loginFetch = globalThis.fetch
  let release
  let signCalls = 0
  globalThis.fetch = (url, init) => {
    if (String(url).includes('/get_timestamp.action')) return new Promise(resolve => { release = resolve })
    if (String(url).includes('/stu_scan_sign.action')) { signCalls += 1; throw new Error('must not submit') }
    return loginFetch(url, init)
  }
  const pending = performSignin('course-a')
  const rejected = assert.rejects(pending, { code: 'cancelled' })
  await acquireSession({ ...h.credentials, username: 'student-b' })
  release(json({ timestamp: '123' }))
  await rejected
  assert.equal(signCalls, 0)
  assert.equal(hasSession(), true)
})
