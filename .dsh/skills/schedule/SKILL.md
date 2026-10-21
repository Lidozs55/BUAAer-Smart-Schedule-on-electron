---
name: schedule
description: "日程插件的操作细则：任务/日历条目的增删改查、教学周换算、类别与冲突处理、二游前瞻条目。用户提到作业、考试、截止、排课、日程、课程表、二游前瞻或从剪贴板建日程时使用。"
---

# 日程

- 日程工具：`sched_task`（任务/截止事项）、`sched_entry`（所有占时条目）；二游前瞻用 `gacha_schedule`，北航导入用 `buaa_course_sync`。
- `action` 必填：task 为 `list|create|update|complete|delete`；entry 为 `list|create|update|delete|batch_create`。
- 时间一律带时区 ISO 8601（`2026-10-19T23:59:00+08:00`）。全天条目写 `all_day=true`，`start` 传当天日期。
- 任务看截止，条目看起止时间。北航整学期导入按教务实际周次生成带日期的普通条目；教学安排使用 `study`（学习），考试使用 `exam`，导入条目默认 `lock=true`，考试任务仍保留。
- 查某周：`sched_entry` + `action=list`，用带时区的 `from` / `to` 指定该周窗口（起点含、终点不含）；读取返回的 `entries`，无需自己外推教学周次。快照只有条目、任务与既有元数据。
- `category` 只接受 `homework|exam|meeting|study|sports|other`；导入与手建条目使用同一套分类和编辑操作。
- `location` 是可选地点字符串；工具参数可省略，更新时传空字符串清除（存储为 `null`）。`lock` 是布尔值，默认 `false`；它仅禁止鼠标左键快捷移动/缩放时间，**不禁止编辑、删除、右键菜单、工具改期或其他操作**。批量拖动排除锁定行，批量删除不排除。
- `source` / `sourceKey` 是可选来源归属与稳定身份，不是另一种条目类型；不要伪造来源来绕开来源插件的对账。
- 二游（原神/星穹铁道/绝区零/鸣潮/终末地/异环）主日程只收前瞻直播；版本更新时间只在来源卡显示。前瞻推算时 `lock=false`，官方明确时间时 `lock=true`。查询/刷新用 `gacha_schedule`，官方明确时间用 `apply_official` 按游戏写回；不要用 `sched_entry` 代替来源刷新，也不要创建重复前瞻。用户明确要求的普通编辑/删除并不因锁定而受限，但后续来源刷新可能重新对账。
- 写入冲突会返回 `conflicts`：先把原因告诉用户，确认要重叠后再带 `allow_conflicts=true` 重试。
- 批量（剪贴板/列表）：逐条解析后用 `action=batch_create`；日期或时间不完整先问，不要猜；单条失败不影响其余。
- 改期用 `action=update`，不要删除重建；任务完成用 `action=complete`（`completed=false` 撤销）。
- 提醒只有任务与条目两类，由核心无状态派生并交给页面通知/可选桌宠桥；不要为普通到期提醒创建唤醒 Agent 的自动化任务。
- 回复只给结果和冲突原因，不复述工具返回的 JSON。
