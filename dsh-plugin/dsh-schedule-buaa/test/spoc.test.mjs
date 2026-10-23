import assert from 'node:assert/strict'
import test from 'node:test'
import { createDecipheriv } from 'node:crypto'
import {
  clearSession, encryptParam, extractLoginTokens, fetchAssignments, mapSubmissionStatus, normalizeDateTime,
  normalizeScore, parseAssignments, refreshAssignments, resolveRoleCode, sessionSnapshot,
} from '../host/spoc.js'

const KEY = Buffer.from('inco12345678ocni', 'utf8')
const IV = Buffer.from('ocni12345678inco', 'utf8')

function decryptParam(value) {
  const decipher = createDecipheriv('aes-128-cbc', KEY, IV)
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(Buffer.from(value, 'base64')), decipher.final()])
  return plain.toString('utf8').replace(/\0+$/, '')
}

test('SPOC failure envelopes never expose upstream messages or URLs', async t => {
  const originalFetch = globalThis.fetch
  const secret = 'SYNTHETIC_SPOC_SECRET_MARKER'
  t.after(() => { globalThis.fetch = originalFetch; clearSession() })
  const credentials = {
    jar: { header: () => '', store() {} }, username: 'security-test', password: 'test-only',
  }
  const operations = [
    ['/spocnewht/sys/casLogin', 'casLogin'],
    ['/spocnewht/inco/ht/queryOne', 'queryOne'],
    ['/spocnewht/jxkj/queryKclb', 'queryKclb'],
    ['/spocnewht/inco/ht/queryListByPage', 'queryListByPage'],
  ]
  for (const [path, operation] of operations) {
    for (const [failure, code, message] of [
      [{ msg: `登录失效 https://example.invalid/?token=${secret}` }, 'auth', `SPOC ${operation} 登录状态失效`],
      [{ msg: `服务失败 https://example.invalid/?opaque=${secret}` }, 'data', `SPOC ${operation} 失败`],
      [{ msg_en: `failure ${secret}` }, 'data', `SPOC ${operation} 失败`],
      [{ msg: { diagnostic: secret } }, 'data', `SPOC ${operation} 失败`],
    ]) {
      clearSession()
      let rejectEnvelope = operation === 'casLogin'
      globalThis.fetch = async url => {
        const pathname = new URL(url).pathname
        if (pathname === '/spocnewht/cas') return new Response(null, {
          status: 302, headers: { Location: 'https://spoc.buaa.edu.cn/spocnew/cas?token=test-only' },
        })
        if (rejectEnvelope && pathname === path) return new Response(JSON.stringify({ code: 500, ...failure }))
        const content = pathname === '/spocnewht/sys/casLogin' ? { jsdm: '2' }
          : pathname === '/spocnewht/inco/ht/queryOne' ? { mrxq: '2026-2027-1' }
            : pathname === '/spocnewht/jxkj/queryKclb' ? [] : { list: [], hasNextPage: false }
        return new Response(JSON.stringify({ code: 200, content }))
      }
      if (!rejectEnvelope) {
        await fetchAssignments(credentials)
        rejectEnvelope = true
      }
      const result = operation === 'casLogin' ? fetchAssignments(credentials) : refreshAssignments()
      if (operation === 'queryKclb' && code === 'data') {
        const feed = await result
        assert.deepEqual(feed.assignments, [])
        assert.equal(JSON.stringify(feed).includes(secret), false)
        continue
      }
      await assert.rejects(result, error => {
        assert.equal(error.code, code)
        assert.equal(error.message, message)
        assert.equal(String(error).includes(secret), false)
        assert.equal(JSON.stringify(error).includes(secret), false)
        return true
      })
    }
  }
})

test('SPOC transport errors cannot expose credential-bearing URLs', async t => {
  const credentials = mockSpoc(t, () => ({ list: [], hasNextPage: false }))
  const workingFetch = globalThis.fetch
  const marker = 'SYNTHETIC_TRANSPORT_SECRET'
  globalThis.fetch = async () => { throw new Error(`request failed ?token=${marker}`) }
  await assert.rejects(fetchAssignments(credentials), error => error.code === 'network' && !error.message.includes(marker))
  globalThis.fetch = workingFetch
  await fetchAssignments(credentials)
  globalThis.fetch = async () => { throw new Error(`request failed ?token=${marker}`) }
  await assert.rejects(refreshAssignments(), error => error.code === 'network' && !error.message.includes(marker))
})

test('SPOC query parameters use AES-128-CBC with zero padding', () => {
  const plain = JSON.stringify({ pageNum: 1, xnxq: '2026-2027-1' })
  const encrypted = encryptParam(plain)
  assert.equal(Buffer.from(encrypted, 'base64').length % 16, 0)
  assert.equal(decryptParam(encrypted), plain)
  assert.equal(decryptParam(encryptParam('abcd')), 'abcd')
})

test('SPOC token comes from the callback path, never from the CAS entry', () => {
  assert.deepEqual(
    extractLoginTokens('https://spoc.buaa.edu.cn/spocnew/cas?token=abc&refreshToken=r1'),
    { token: 'abc', refreshToken: 'r1' },
  )
  assert.deepEqual(
    extractLoginTokens('https://spoc.buaa.edu.cn/spocnew/cas?token=abc'),
    { token: 'abc', refreshToken: null },
  )
  assert.equal(extractLoginTokens('https://spoc.buaa.edu.cn/spocnewht/cas?token=abc'), null)
  assert.equal(extractLoginTokens('https://spoc.buaa.edu.cn/spocnew/cas?token='), null)
  assert.equal(extractLoginTokens('not a url'), null)
})

test('deadlines normalize to UTC ISO; zone-less values mean China time', () => {
  assert.equal(normalizeDateTime('2026-11-10 23:59:00'), '2026-11-10T15:59:00.000Z')
  assert.equal(normalizeDateTime('2026-11-10T23:59:00+08:00'), '2026-11-10T15:59:00.000Z')
  assert.equal(normalizeDateTime('2026-11-10'), '2026-11-10T15:59:59.000Z')
  assert.equal(normalizeDateTime(''), null)
  assert.equal(normalizeDateTime('下周'), null)
})

test('submission flags and scores tolerate the school flag and readable text', () => {
  assert.equal(mapSubmissionStatus('1'), 'submitted')
  assert.equal(mapSubmissionStatus('已提交'), 'submitted')
  assert.equal(mapSubmissionStatus('0'), 'unsubmitted')
  assert.equal(mapSubmissionStatus(''), 'unsubmitted')
  assert.equal(mapSubmissionStatus('补交'), 'unknown')
  assert.equal(normalizeScore('95.5 分'), '95.5')
  assert.equal(normalizeScore(''), null)
  assert.equal(normalizeScore('待批'), '待批')
})

test('role code resolves from the school response or its list form', () => {
  assert.equal(resolveRoleCode({ jsdm: '2' }), '2')
  assert.equal(resolveRoleCode({ rolecode: '1' }), '1')
  assert.equal(resolveRoleCode({ jsdmList: [{ jsdm: '3' }] }), '3')
  assert.equal(resolveRoleCode({}), null)
})

test('assignment parsing drops submitted and undated rows, keeps course metadata', () => {
  const rows = [
    {
      zyid: 'a1', sskcid: 'c1', kcmc: '高等数学', zymc: '第三章习题',
      zykssj: '2026-10-20 08:00:00', zyjzsj: '2026-10-30 23:59:00', tjzt: '0', mf: '100',
    },
    {
      zyid: 'a2', sskcid: 'c1', kcmc: '高等数学', zymc: '第四章习题',
      zykssj: '2026-10-21 08:00:00', zyjzsj: '2026-10-25 23:59:00', tjzt: '1', mf: '100',
    },
    {
      zyid: 'a3', sskcid: 'c2', kcmc: '大学物理', zymc: '实验报告',
      zykssj: '2026-10-22 08:00:00', zyjzsj: '', tjzt: '0', mf: '',
    },
    null,
  ]
  const courses = new Map([['c1', { kcid: 'c1', kcmc: '高等数学', skjs: '张老师' }]])
  const parsed = parseAssignments(rows, courses)

  assert.equal(parsed.submitted, 1)
  assert.equal(parsed.skipped, 2)
  assert.equal(parsed.assignments.length, 1)
  assert.deepEqual(parsed.assignments[0], {
    assignmentId: 'a1',
    courseId: 'c1',
    courseName: '高等数学',
    teacherName: '张老师',
    title: '第三章习题',
    start: '2026-10-20T00:00:00.000Z',
    due: '2026-10-30T15:59:00.000Z',
    score: '100',
    status: 'unsubmitted',
    statusText: '未提交',
  })
})

test('assignments are sorted by deadline, then course and title', () => {
  const row = (title, due, course = '课程') => ({ kcmc: course, zymc: title, zyjzsj: due, tjzt: '0' })
  const parsed = parseAssignments([
    row('乙', '2026-11-02 12:00:00'),
    row('甲', '2026-11-01 12:00:00'),
    row('丙', '2026-11-01 13:00:00', '另一门'),
  ])
  assert.deepEqual(parsed.assignments.map(item => item.title), ['甲', '丙', '乙'])
})

function mockSpoc(t, assignmentPage) {
  const original = globalThis.fetch
  clearSession()
  t.after(() => { globalThis.fetch = original; clearSession() })
  globalThis.fetch = async url => {
    const target = new URL(url)
    const json = content => new Response(JSON.stringify({ code: 200, content }))
    if (target.pathname === '/spocnewht/cas') {
      return new Response(null, { status: 302, headers: {
        Location: 'https://spoc.buaa.edu.cn/spocnew/cas?token=test-token',
      } })
    }
    if (target.pathname === '/spocnewht/sys/casLogin') return json({ jsdm: '2' })
    if (target.pathname === '/spocnewht/inco/ht/queryOne') return json({ mrxq: '2026-2027-1' })
    if (target.pathname === '/spocnewht/jxkj/queryKclb') return json([])
    if (target.pathname === '/spocnewht/inco/ht/queryListByPage') return json(assignmentPage())
    throw new Error('Unexpected SPOC request')
  }
  return { jar: { header: () => '', store() {} }, username: 'student-a', password: 'test-only' }
}

test('malformed assignment pages are not authoritative empty snapshots', async t => {
  let page
  const credentials = mockSpoc(t, () => page)
  for (page of [null, {}, { list: null }, { list: [], hasNextPage: true }]) {
    await assert.rejects(fetchAssignments(credentials), { code: 'data' })
  }
})

test('pagination exhaustion refuses partial feeds instead of allowing task deletion', async t => {
  let requests = 0
  const credentials = mockSpoc(t, () => {
    requests += 1
    return { list: [{ tjzt: '1' }], hasNextPage: true, pages: 101 }
  })
  await assert.rejects(fetchAssignments(credentials), { code: 'data' })
  assert.equal(requests, 100)
})

test('a complete empty assignment page remains a valid snapshot', async t => {
  const credentials = mockSpoc(t, () => ({ list: [], hasNextPage: false, pages: 0 }))
  const result = await fetchAssignments(credentials)
  assert.deepEqual(result.assignments, [])
})

test('failed login for a different account cannot retain the previous SPOC session', async t => {
  const credentials = mockSpoc(t, () => ({ list: [], hasNextPage: false }))
  await fetchAssignments(credentials)
  assert.equal(sessionSnapshot().username, 'student-a')
  globalThis.fetch = async () => { throw new Error('network unavailable') }
  await assert.rejects(fetchAssignments({ ...credentials, username: 'student-b' }))
  assert.equal(sessionSnapshot(), null)
  await assert.rejects(refreshAssignments(), { code: 'auth' })
})

test('overlapping account logins never share the other account session', async t => {
  const credentials = mockSpoc(t, () => ({ list: [], hasNextPage: false }))
  const first = fetchAssignments(credentials)
  await assert.rejects(fetchAssignments({ ...credentials, username: 'student-b' }), { code: 'busy' })
  await first
  assert.equal(sessionSnapshot().username, 'student-a')
})

test('clearing SPOC during login rejects the obsolete result instead of loading a feed', async t => {
  const credentials = mockSpoc(t, () => ({ list: [], hasNextPage: false }))
  const pending = fetchAssignments(credentials)
  clearSession()
  await assert.rejects(pending, { code: 'cancelled' })
  assert.equal(sessionSnapshot(), null)
})
