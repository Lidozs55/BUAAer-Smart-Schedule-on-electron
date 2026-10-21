# BUAAer 智能日程

专为北航学生设计的日程管理工具：课程表同步、任务截止、日历条目、到期提醒。当前主开发线是 **DSH（DeepSeek Harness）Cordis 插件**形态——作为宿主内的 bundle 运行，无独立后端/端口/鉴权。

> **状态（2026-10-21）**：插件已拆成「日程核心 + 来源适配器」：`@lidozs55/dsh-schedule`
> 负责通用日程数据/UI/提醒/工具，`@buaaer/dsh-schedule-buaa` 通过注入 `scheduleCore`
> 提供北航教务导入（一次拉整学期，学期起点决定周次→日期的换算）。二游前瞻
> `@lidozs55/dsh-schedule-gacha` 同样注入核心，只读 B 站官方公告，为原神/崩铁/绝区零/
> 鸣潮/终末地/异环各维护「版本前瞻直播 + 版本更新」两条日程。桌宠桥
> `@lidozs55/dsh-schedule-bridge` 已到设计 v2（提醒气泡覆盖任务/上课/条目 + 任务状态上报，`docs/dsh-plugin/09`）。
> 旧 Electron 实现已于同日全部删除，仓库只剩插件形态。

## 仓库结构

```
dsh-plugin/dsh-schedule/           # 日程核心 @lidozs55/dsh-schedule（Host + Client）
dsh-plugin/dsh-schedule-buaa/      # 北航来源适配器 @buaaer/dsh-schedule-buaa（依赖核心）
dsh-plugin/dsh-schedule-gacha/     # 二游前瞻来源 @lidozs55/dsh-schedule-gacha（依赖核心，docs 12）
dsh-plugin/dsh-schedule-bridge/    # 桌宠桥 @lidozs55/dsh-schedule-bridge（host-only，docs 09）
docs/dsh-plugin/                   # 开发文档（架构基线 / DSH 平台参考 / 任务记录）
package.json                       # 仓库元信息（各插件包自带 package.json）
```

## 安装与使用

1. 安装进 DSH 宿主：依次安装 `dsh-plugin/dsh-schedule`、`dsh-plugin/dsh-schedule-buaa`
   （可选桌宠桥 `dsh-plugin/dsh-schedule-bridge`、二游前瞻 `dsh-plugin/dsh-schedule-gacha`）。
   链接安装后改源码重启宿主即生效。
2. 侧边栏出现「日程」入口；设置里只有一节「日程设置」：学期起点、数据导入导出与清空，
   以及北航来源追加的学号/密码导入卡片、二游前瞻追加的六款游戏开关。
   其他学校/来源可按 `docs/dsh-plugin/11-source-plugins.md` 的契约新增适配器（同样追加到这个设置页）。
3. 北航课表导入：在「日程设置」填学期起始日期（第一周周一），再到北航卡片填学号与统一认证
   密码点「导入整学期课表」。每学期做一次；密码仅当次使用、不保存。
4. 二游前瞻（可选）：打开对应游戏的开关即可，插件每 6 小时从 B 站官方账号刷新版本更新与
   前瞻直播时间；终末地节奏不固定，可在卡片里点「让 Agent 核对」并登记每周三的周检。
5. Agent 细则放在 `.dsh/skills/schedule/SKILL.md`：DSH 会自动发现，日程相关会话按需加载
   （也可直接输入 `/schedule` 调用）。其他工作区使用时可复制到用户级 skills 目录
   （`$DSH_HOME/skills/`，默认 `~/.dsh/skills/`）。

## 文档

- **架构与决策基线**：`docs/dsh-plugin/00-architecture.md`
- **新增日程来源**：`docs/dsh-plugin/11-source-plugins.md`
- **二游前瞻来源**（B 站公告解析、六游戏推算、Agent 写入）：`docs/dsh-plugin/12-gacha-preview.md`
- DSH 插件开发参考（平台契约、服务/UI/数据/工具速查）：同目录 `01`–`06`、`08`
- 桌宠桥设计（已落地 v2）：`docs/dsh-plugin/09-vivarium-bridge.md`
- UI 意图对齐返工记录（已完成）：`docs/dsh-plugin/10-ui-parity-rework.md`

## 核心行为约定

- 课程按「第 1-16 周」式周期规则存储，任意教学周**现算**出现（不物化行）。
- 显示日 = 04:00 → 次日 04:00（凌晨 0–4 点属于前一格日；客户端几何在 `client.gridmath.js`，宿主锚点在 `host/semester.js`，各只此一份）。
- 修改任务/条目的唯一实现是 Host 领域服务；UI 与 Agent 工具（`sched_*`）调同一方法。
- 插件内零 LLM 调用：自然语言建日程 = 在会话内让 Agent 调工具。
- 学号等来源状态由来源插件持久化在核心 domain 的 `sourceState`；教务密码只作当次调用入参，绝不落盘，也不缓存会话。
- 北航导入是整学期快照：课表自带的周次即最终周次，重复导入替换整份课表（教务里删掉的课会消失）。
- 任务提醒由 `ctx.schedule` durable 承担并投递回绑定会话；上课/条目提醒由核心派生集交给桌宠气泡（当前唯一投递面，桥缺席时不送达）。桌宠桥对任务提醒只是增强表面，关掉桥任务提醒不受影响。
