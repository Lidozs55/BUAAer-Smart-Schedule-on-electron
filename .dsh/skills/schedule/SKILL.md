---
name: schedule
description: "日程、待办与来源导入统一使用 `schedule` CLI。首次使用先运行 `schedule --help` 发现命令；子命令用 `--help`，长教程用 `guide`。"
---

# 日程 CLI

本插件的 Agent 接口不是常驻工具，而是 `schedule` CLI。命令、参数、示例和副作用都随插件在线提供，按需发现，不占用固定上下文。

## 发现顺序

1. 先运行 `schedule --help`，看当前命名空间与指南目录。
2. 进入某一层：`schedule <命令> --help`；叶子命令的帮助才是参数与副作用的权威说明。
3. 较长教程用 `schedule guide <主题>`；主题列表在顶层帮助里。
4. 来源插件会贡献自己的命名空间与指南；只使用当前帮助里实际存在的命令。

命令不在 `PATH` 时，用宿主生成的启动器：

- Windows cmd：`%USERPROFILE%\.dsh\schedule-cli\schedule.cmd`
- Windows PowerShell：`& "$env:USERPROFILE\.dsh\schedule-cli\schedule.cmd"`
- macOS/Linux：`~/.dsh/schedule-cli/schedule`

若宿主使用自定义 `DSH_HOME`，启动器在同一目录下的 `schedule-cli/`；`SCHEDULE_CLI_HOME` 也能覆盖该目录。

## 执行底线

- 命令成功时输出一个 JSON 回执：`{ "ok": true, "command": "...", "value": ... }`。写入成功以回执为准，不再重复查询验证。
- 失败时输出 `{ "ok": false, "command": "...", "error": { code, message, details? } }`。`code=conflict` 时读 `details.conflicts`，说明原因并询问用户。
- 冲突默认拒绝。只有用户明确确认允许重叠后，才加 `--allow-conflicts` 重试；该参数本身不是用户授权，也不会覆盖已有安排。
- 修改、删除、完成操作复用本会话回执里的真实 `id`；否则先查询定位。同名或多个候选无法唯一匹配时先确认，不猜 id。
- 时间用带时区且含秒的 ISO 8601；全天条目按对应 `--help` 的格式传入。只问影响正确写入且无法确定的缺失信息。
- 可选用 `--remind-lead` 定制提醒提前量（分钟，`0`=准时提醒，`1440`=提前 1 天；`-1`=清除定制恢复默认；省略=保持原值/用默认）。通知依赖页面运行及通知设置，不承诺关闭页面后仍会通知。
- 批量操作优先用 `--input <file|->` 传 JSON，避免在命令行拼长内容；部分成功只重试失败项。
- 来源密码不写进普通命令行参数；按该来源 `--help` 的 stdin/env 方式提供，也不在回复中复述。
- 只通过 CLI 操作日程。不要为查询、写入或校验读取/搜索宿主内部存储、配置或凭据；CLI 不可用时说明宿主未运行或插件未启用，不要用文件或 HTTP 旁路补齐。
- CLI 不管理类别/颜色、学期起点、提醒配置、备份或清空全部数据；此类请求引导到日程设置。
