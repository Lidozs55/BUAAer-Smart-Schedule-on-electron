/**
 * `schedule buaa` command namespace.
 *
 * A source plugin contributes only its own namespace, help and handler. The
 * core registry supplies parsing, validation, discovery and transport.
 */
const OUTPUT_NOTES = [
  '导入是整学期快照：课表自带的周次就是最终周次；重复导入会替换此前由本来源写入的教学与考试日程，未排课的空缺不外推。',
  '生成锁定的 course/exam 条目，并保留考试待办；课程用当前 course 类别、考试用 exam，类别已删除时归 other。',
  '密码只用于当次调用，不落盘、不写日志；不要把它放进普通命令行参数。',
  '以本命令的统计回执为准，不要手工补建同批条目，也不要读取内部文件校验。',
]

export function registerBuaaCommands(registry, deps) {
  const dispose = registry.register({
    name: 'buaa',
    summary: '北航教务整学期课表与考试导入',
    description: '从北航统一认证与教务端点一次拉取整学期课表、考试，写入核心日程。仅在启用北航来源插件时可用。',
    usage: 'schedule buaa <sync> [选项]',
    commands: [
      {
        name: 'sync',
        summary: '导入整学期课表与考试安排',
        description: '一次登录 + 两个整学期请求；课表按教务自带周次写成带日期的课程条目，考试同时保留为条目和待办。',
        timeoutMs: 180_000,
        options: {
          'buaa-id': {
            type: 'string',
            description: '学号；省略则使用设置里保存的学号',
          },
          'term-start': {
            type: 'string',
            description: '学期起始日期 YYYY-MM-DD（第一周周一）；省略则使用日程设置里已保存的值',
          },
          password: {
            type: 'string',
            hidden: true,
            description: '由 --password-stdin 或 --password-env 注入；不作为普通参数使用',
          },
        },
        examples: [
          'schedule buaa sync --password-stdin < password.txt',
          'SCHEDULE_BUAA_PASSWORD=*** schedule buaa sync --password-env SCHEDULE_BUAA_PASSWORD --buaa-id 25371416',
          'schedule buaa sync --term-start 2026-09-07 --password-env SCHEDULE_BUAA_PASSWORD',
        ],
        notes: OUTPUT_NOTES,
        async run(input) {
          return deps.runSync({
            buaaId: input['buaa-id'],
            password: input.password,
            ...(input['term-start'] === undefined ? {} : { termStart: input['term-start'] }),
          })
        },
      },
    ],
  }, { owner: 'buaa' })

  const disposeGuide = registry.registerGuide({
    name: 'buaa',
    title: '北航教务导入',
    summary: '整学期快照、密码输入、类别与锁定语义',
    body: [
      '命令：`schedule buaa sync`（先运行 `schedule buaa sync --help`）。',
      '',
      '前提：',
      '- 已在日程设置或 `--term-start` 给出学期起点（第一周周一）。',
      '- 已保存学号，或本次传 `--buaa-id`。',
      '- 统一认证密码只用于当次登录：优先 `--password-stdin`，其次 `--password-env NAME`；不要写成 `--password ***`。',
      '',
      '行为：',
      '- 一次请求拿整学期课表；每个格子自带星期、时间和周次，按真实周次生成带日期的条目。',
      '- 重复导入是整学期快照：稳定来源键保留条目 id，缺席条目只从本来源删除；未排课的空缺不会被外推。',
      '- 课程使用 `course` 类别、考试使用 `exam`；类别已删除时归 `other`，不会复活已删除类别。',
      '- 课程与考试条目锁定（仅防页面快捷拖动），仍可显式编辑或删除。',
      '- 考试任务按「课程名 + 考试日期」对账；用户手建的同名任务只校正 due，标题/优先级/备注归用户。',
      '- 回执含本学期周次覆盖、条目新增/更新/移除与考试统计；以回执为准，不手工补建同批条目。',
      '',
      '失败：',
      '- 认证失败会返回 code=auth；检查学号/密码，不要重试到锁定。',
      '- 考试端点失败时保留原有考试并给出统计中的失败信息；课表部分仍按返回结果处理，如实报告。',
      '- 结果未知时先查目标学期窗口，再决定是否重试，避免重复。',
    ].join('\n'),
  })

  return () => {
    dispose()
    disposeGuide()
  }
}
