---
name: schedule
description: "日程插件的操作细则：任务/日历条目的增删改查、教学周换算、类别与冲突处理。用户提到作业、考试、截止、排课、日程、课程表或从剪贴板建日程时使用。"
---

# 日程

- 两个工具：`sched_task`（任务/截止事项）、`sched_entry`（占时条目；课程出现用它查）。
- `action` 必填：task 为 `list|create|update|complete|delete`；entry 为 `list|create|update|delete|batch_create`。
- 时间一律带时区 ISO 8601（`2026-10-19T23:59:00+08:00`）。全天条目写 `all_day=true`，`start` 传当天日期。
- 任务看截止，条目不设截止；课程由 `buaa_course_sync` 同步产生，**不要手工建课程**。
- 查某周课程：`sched_entry` + `action=list` + `week_start`（该周周一 `YYYY-MM-DD`），返回 `occurrences`。周期规则已存库，不要自己按周几推算。
- `category`：`course|homework|exam|meeting|study|sports|other`。课程类必须 `course`，否则显示为灰色「其他」。
- 写入冲突会返回 `conflicts`：先把原因告诉用户，确认要重叠后再带 `allow_conflicts=true` 重试。
- 批量（剪贴板/列表）：逐条解析后用 `action=batch_create`；日期或时间不完整先问，不要猜；单条失败不影响其余。
- 改期用 `action=update`，不要删除重建；完成用 `action=complete`（`completed=false` 撤销）。
- 回复只给结果和冲突原因，不复述工具返回的 JSON。
