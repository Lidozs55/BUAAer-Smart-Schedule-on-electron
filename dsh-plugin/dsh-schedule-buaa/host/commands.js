/**
 * `schedule buaa` command namespace.
 *
 * A source plugin contributes only its own namespace, help and handler. The
 * core registry supplies parsing, validation, discovery and transport.
 */
const OUTPUT_NOTES = [
  '导入是整学期快照：课表自带的周次就是最终周次；重复导入会替换此前由本来源写入的教学与考试日程，未排课的空缺不外推。',
  '生成锁定的 course/exam 条目，并保留考试待办；课程用当前 course 类别、考试用 exam，类别已删除时归 other。',
  'SPOC 未提交作业对账为 homework 待办（按「课程 + 作业名」匹配），已提交的作业不生成待办；SPOC 失败只作为警告，不影响课表与考试。',
  'SPOC 会话只在宿主进程内存中，重启后需再手动同步一次；关闭设置里的 SPOC 开关会清除该会话。',
  '同一次同步建立 iclass 内存签到会话，当天北航课程条目的「远程签到」按钮可使用；建立失败只警告，不影响教务导入。',
  '密码只用于当次调用，不落盘、不写日志；不要把它放进普通命令行参数。',
  '以本命令的统计回执为准，不要手工补建同批条目，也不要读取内部文件校验。',
]

export function registerBuaaCommands(registry, deps) {
  const dispose = registry.register({
    name: 'buaa',
    summary: '北航教务整学期课表、考试与 SPOC 作业导入',
    description: '从北航统一认证与教务端点一次拉取整学期课表、考试，并通过同一次登录读取 SPOC 未提交作业，写入核心日程。仅在启用北航来源插件时可用。',
    usage: 'schedule buaa <sync> [选项]',
    commands: [
      {
        name: 'sync',
        summary: '导入整学期课表、考试与 SPOC 作业',
        description: '一次登录 + 两个教务请求 + SPOC 作业分页；课表按教务自带周次写成带日期的课程条目，考试同时保留为条目和待办，未提交作业生成 homework 待办。',
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
    summary: '整学期快照、SPOC 作业、密码输入、类别与锁定语义',
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
      '- 同一次登录会读取 SPOC 当前学期作业；未提交作业写成 `homework` 待办，身份键是「课程 + 作业名」，截止时间变化会更新 `due`。已提交作业不生成待办。',
      '- SPOC 作业的删除只限本源、当前学期；分页不完整或 SPOC 当前学期与导入学期不一致时不对账，保留已有待办。',
      '- SPOC 会话仅存内存，宿主重启后需再同步一次，设置卡开关关闭时立即清除会话。',
      '- 同步还会建立 iclass 内存会话；当天北航课程条目的「远程签到」按钮按课程名称和北京时间匹配校方当天排课，已签到直接返回，不重复提交。修改学号或卸载来源插件会清除内存会话。',
      '- 课程使用 `course` 类别、考试使用 `exam`；类别已删除时归 `other`，不会复活已删除类别。',
      '- 课程与考试条目锁定（仅防页面快捷拖动），仍可显式编辑或删除。',
      '- 考试任务按「课程名 + 考试日期」对账；用户手建的同名任务只校正 due，标题/优先级/备注归用户。',
      '- 回执含本学期周次覆盖、条目与考试统计，以及 SPOC 作业的新增/更新/移除和已提交跳过数；以回执为准，不手工补建同批条目。',
      '',
      '失败：',
      '- 认证失败会返回 code=auth；检查学号/密码，不要重试到锁定。',
      '- 考试端点失败时保留原有考试并给出统计中的失败信息；课表部分仍按返回结果处理，如实报告。',
      '- SPOC 失败（接口变更、断网、角色信息缺失）只在回执的 spoc.failed 中报告，教务课表与考试照常导入；不要把 SPOC 失败当成整次导入失败。',
      '- iclass 登录失败只在 signin.failed 中报告；会话失效时先手动同步，签到按钮不会保存或索要密码。',
      '- 结果未知时先查目标学期窗口，再决定是否重试，避免重复。',
    ].join('\n'),
  })

  return () => {
    dispose()
    disposeGuide()
  }
}
