#!/usr/bin/env node
/**
 * Export the legacy SQLite database (backend/instance/app.db) to the JSON
 * payload `/buaaer-import` consumes (decision D-4). Contract: `entries`
 * rows keep their `id` (task `entry_id` links resolve through it);
 * mapping and timezone fixes happen host-side in
 * `dsh-plugin/buaaer-schedule/host/import.js`.
 *
 * Usage:
 *   node scripts/export-legacy-db.mjs [path\to\app.db] [out.json]
 * Defaults: backend/instance/app.db → stdout (redirect or pass a path).
 *
 * Node's `node:sqlite` needs `--experimental-sqlite` on Node 22 (unflagged
 * from 23.4); the script prints the exact retry command when it hits the
 * flag error. Rows pass through verbatim.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const dbPath = resolve(process.argv[2] ?? 'backend/instance/app.db')
const outPath = process.argv[3]

if (!existsSync(dbPath)) {
  console.error(`找不到旧数据库：${dbPath}`)
  console.error('若旧数据在别的机器上，先在那台机器运行后端生成 backend/instance/app.db，再拷贝过来。')
  process.exit(1)
}

let db
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
} catch (error) {
  if (String(error.message).includes('experimental')) {
    console.error('node:sqlite 在该 Node 版本需要 flag。请改用：')
    console.error(`  node --experimental-sqlite scripts/export-legacy-db.mjs ${process.argv[2] ?? ''} ${outPath ?? ''}`)
    process.exit(1)
  }
  throw error
}

const all = sql => db.prepare(sql).all()

const payload = {
  exportedAt: new Date().toISOString(),
  source: 'legacy-sqlite',
  user: all('SELECT buaa_id FROM user LIMIT 1'),
  courses: all('SELECT course_name, teacher, classroom, start_time, end_time, day_of_week, week_range, date FROM course'),
  entries: all('SELECT id, title, description, entry_type, start_time, end_time FROM entries'),
  tasks: all('SELECT title, description, task_type, deadline, priority, completed, entry_id FROM task'),
}
db.close()

const json = JSON.stringify(payload, null, 2)
if (outPath === undefined) {
  process.stdout.write(json + '\n')
} else {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(resolve(outPath), json, 'utf8')
  console.error(`written: ${resolve(outPath)} (courses ${payload.courses.length}, entries ${payload.entries.length}, tasks ${payload.tasks.length})`)
}
