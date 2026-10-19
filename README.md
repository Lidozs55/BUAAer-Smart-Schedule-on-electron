# BUAAer 智能日程

专为北航学生设计的日程管理工具：课程表同步、任务截止、日历条目、到期提醒。当前主开发线是 **DSH（DeepSeek Harness）Cordis 插件**形态——作为宿主内的 bundle 运行，无独立后端/端口/鉴权。

> **状态（2026-10-20）**：插件已拆成「日程核心 + 来源适配器」：`@lidozs55/dsh-schedule`
> 负责通用日程数据/UI/提醒/工具，`@buaaer/dsh-schedule-buaa` 通过注入 `scheduleCore`
> 提供北航 SSO 同步与旧库导入。桌宠桥 `@lidozs55/dsh-schedule-bridge` 保持 v1
> （提醒气泡 + 状态信号，`docs/dsh-plugin/09`）。旧 Electron 实现暂时保留，待插件完全稳定后删除。

## 仓库结构

```
dsh-plugin/dsh-schedule/           # 日程核心 @lidozs55/dsh-schedule（Host + Client）
dsh-plugin/dsh-schedule-buaa/   # 北航来源适配器 @buaaer/dsh-schedule-buaa（依赖核心）
dsh-plugin/dsh-schedule-bridge/    # 桌宠桥 @lidozs55/dsh-schedule-bridge（host-only，docs 09）
docs/dsh-plugin/                   # 开发文档（架构基线 / DSH 平台参考 / 任务记录）
scripts/export-legacy-db.mjs       # 旧 SQLite 库 → JSON 导出（一次性迁移用）
electron/ backend/ frontend/ 与根级旧脚本  # 旧 Electron 实现（意图参照，docs/dsh-plugin/00 §7，验收后删除）
```

## 安装与使用

1. 安装进 DSH 宿主：依次安装 `dsh-plugin/dsh-schedule`、`dsh-plugin/dsh-schedule-buaa`
   （可选桌宠桥 `dsh-plugin/dsh-schedule-bridge`）。链接安装后改源码重启宿主即生效。
2. 侧边栏出现「日程」入口；设置里只有一节「日程设置」：学期起点、数据导入导出，
   以及北航来源追加的学号/教务同步/旧库导入卡片。其他学校/来源可按
   `docs/dsh-plugin/11-source-plugins.md` 的契约新增适配器（同样追加到这个设置页）。
3. 旧数据迁移：`node scripts/export-legacy-db.mjs` 导出 JSON → 会话内 `/buaa-import <路径>`
   或在「日程设置 → 旧版数据导入」图形导入。

## 文档

- **架构与决策基线**：`docs/dsh-plugin/00-architecture.md`
- **新增日程来源**：`docs/dsh-plugin/11-source-plugins.md`
- DSH 插件开发参考（平台契约、服务/UI/数据/工具速查）：同目录 `01`–`06`、`08`
- 桌宠桥设计（已落地 v1）：`docs/dsh-plugin/09-vivarium-bridge.md`
- UI 意图对齐返工记录（已完成）：`docs/dsh-plugin/10-ui-parity-rework.md`

## 核心行为约定

- 课程按「第 1-16 周」式周期规则存储，任意教学周**现算**出现（不物化行）。
- 显示日 = 04:00 → 次日 04:00（凌晨 0–4 点属于前一格日；客户端几何在 `client.gridmath.js`，宿主锚点在 `host/semester.js`，各只此一份）。
- 修改任务/条目的唯一实现是 Host 领域服务；UI 与 Agent 工具（`sched_*`）调同一方法。
- 插件内零 LLM 调用：自然语言建日程 = 在会话内让 Agent 调工具。
- 学号等来源状态由来源插件持久化在核心 domain 的 `sourceState`；教务密码只作当次调用入参，绝不落盘。
- 提醒由 `ctx.schedule` durable 承担，投递回绑定会话；桌宠气泡是增强表面（桥插件），关掉桥提醒不受影响。
