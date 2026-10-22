# 12 · 二游前瞻来源（`@lidozs55/dsh-schedule-gacha`）

> 一句话：读取 gacha-calendar 服务（gacha.modenc.top）格式化后的版本更新与前瞻时间，
> 为六款二游各维护**一条「版本前瞻直播」主日程**，版本更新时间只在来源卡显示；
> 其余日程一概不碰。

插件位置：`dsh-plugin/dsh-schedule-gacha/`，row id `gacha-schedule`，
`inject: ['scheduleCore', 'connection', 'scheduleCommands']`。日程条目真相仍在核心
`@lidozs55/dsh-schedule`（日程条目 + `sourceState.gacha`）；B 站采集、公告解析与
推算逻辑已迁移至独立服务 **gacha-calendar**（仓库
`The-Astral-Express-Family/gacha-calendar`，Go + GORM + SQLite + Vue），
本插件是其数据的一个宿主适配器（契约见 `11-source-plugins.md`）。

---

## 1. 跟踪对象

| id | 游戏 | 官方 mid | 版本节奏 | 前瞻惯例 |
|---|---|---|---|---|
| `genshin` | 原神 | `401742377` | 42 天 | 更新前一周的周五 19:30 |
| `hsr` | 崩坏：星穹铁道 | `1340190821` | 42 天 | 同上 |
| `zzz` | 绝区零 | `1636034895` | 42 天 | 同上 |
| `wuwa` | 鸣潮 | `1955897084` | 42 天 | 更新前一周的周五 19:30（官方多在周四/周五） |
| `endfield` | 明日方舟：终末地 | `1265652806` | 不固定（4/6/7 周） | 同上，需以公告阶段更新日为准 |
| `nte` | 异环 | `3546636978489848` | 42 天 | 更新前一周的周五 19:30 |

每款游戏可单独开关；关闭时只删除本插件写入的、带该游戏标记的条目。

---

## 2. 文件地图

| 文件 | 职责 |
|---|---|
| `index.js` | host 入口：注册 commands/api、首次 20 s 刷新、每 6 h 定时刷新、`systemPrompt` 段落 |
| `host/games.js` | 六款游戏的静态知识（mid、标题正则、标记函数）；采集与推算已移至服务 |
| `host/calendarApi.js` | gacha-calendar 服务 HTTP 客户端（games / posts / refresh / overrides） |
| `host/service.js` | 服务视图 → 插件 plan 映射（UTC RFC3339 → `+08:00` ISO）、条目对账、官方校正转发 |
| `host/state.js` | `SOURCE_ID = 'gacha'`，`sourceState` 归一化 |
| `host/commands.js` | CLI 命名空间 `schedule gacha list/refresh/posts/apply-official/watch` + guide |
| `host/api.js` | `/api/gacha-schedule`（设置卡读状态、开关、立即刷新） |
| `client.js` / `client.settings.js` | 注册 `schedule.settings.blocks` 卡片，复用核心 `bsch-*` 样式 |
| `test/` | 离线映射/对账/校正转发、周检与 CLI `posts` 测试（不联网） |

服务端点与配置：默认 `https://gacha.modenc.top`；可用
`globalThis.__GACHA_CALENDAR__ = { baseUrl, token }` 覆写（`token` 为管理令牌，
官方校正转发需要）。公告解析规则、推算优先级与校准数据的服务端实现见
gacha-calendar 仓库 `backend/internal/parse`（测试覆盖六种公告格式、滚动逻辑、
视频回推与 2026-10-21 六游戏实抓快照）。

---

## 3. 刷新流程（每款游戏）

1. `GET /api/games`：读取该游戏的状态与当前 active 预测
   （版本、更新窗口、前瞻窗口、置信度、依据、公告链接）。
2. `GET /api/posts?games=<id>&is_update_notice=1&page_size=1`：公告元数据
   （标题、发布时间、链接），用于来源卡与描述。
3. 服务时间（UTC RFC3339）映射为显式 `+08:00` ISO 落入 `sourceState`；
   天真无时区字符串一律拒绝，杜绝"本地时间存成 UTC"的旧 bug 回潮。
4. 对账：每款游戏最多一条前瞻核心条目；多余的本源条目（含先前写入的更新块）删除，
   用户手工与其他来源条目不动。版本更新时间仍参与显示，不写入主日程。
5. 服务端每 6 h 自行采集 B 站（专栏 → 摘要优先合并 → 前瞻视频/动态 → 纯规则推算），
   插件同样每 6 h 拉取格式化结果；启动时先用缓存计划对账，不必等待网络。

---

## 4. 推算与校正

推算优先级（服务端，`planNext`）：

1. 官方"版本结束时间 / 版本持续时间" → `official`
2. 终末地公告中 21–35 天后的"阶段内容更新" → `inferred`（证据可追溯）
3. 官方动态/公告中的"下一版本将于…上线/更新" → `official`
4. 当前更新时间 + 42 天并对齐星期几 → `inferred`；已结束的版本继续滚动（最多 16 次）
5. 前瞻：官方明确日期时间 → `official`；官方视频标题/发布日回推或
   "更新前 8–14 天的周五 19:30" → `inferred`

Agent 官方校正是**转发**：`schedule gacha apply-official` 本地校验（带时区 ISO、时段先后、
前瞻早于更新）后 `PUT /api/admin/overrides/:game`（Bearer token），
服务端将覆盖层合并进下一次预测并立即重算，插件随后重读合并结果——
网页端与所有宿主看到同一份校正。覆盖在"新公告发布时间晚于覆盖时间"时自动失效。

启动时先用缓存计划对账一次，不联网也会清除先前导入的更新块，并为前瞻补齐来源身份与锁定状态；
不必等待 6 h 缓存过期。后台每 6 h 跑一轮；设置卡“立即刷新”和 `schedule gacha refresh` 走同一队列，不会并发抓取。

---

## 5. 日程条目的归属

主日程只收前瞻直播；每款游戏最多一条本源条目，归属由来源身份与描述标记记录：

```
[gacha:<game>][kind:preview]
```

- 条目统一使用普通 `category: 'other'`、可空 `location` 与布尔 `lock`；不另设来源专用类型或编辑器。
- `lock=false`：推算时间；`lock=true`：官方明确公布了直播日期时间（含 Agent 校正）。
  锁只限制鼠标左键快捷移动/缩放，**不禁止**普通编辑、删除或右键操作。
- 标题形如 `原神 7.2 版本前瞻直播`；说明保留版本、依据和公告链接；推算值注明「推算」。
- 前瞻过去 2 天以上不再创建；下次刷新滚动到新版本。关闭游戏时删除本源前瞻条目。

---

## 6. Agent 命令 `schedule gacha`

唯一写入口仍是"游戏 id + 明确时刻"，Agent 在结构上改不到用户的其他日程。

| 子命令 | 参数 | 行为 |
|---|---|---|
| `list` | — | 六款游戏的状态、版本、更新/前瞻时间、依据、公告链接 |
| `refresh` | `--game <id>`（可省略） | 从服务拉取最新格式化状态（服务自身另每 6 h 采集一次） |
| `posts` | `--game <id>`、`--page`、`--page-size`、`--type` | 分页读取服务保存的原始公告/动态/视频（标题、UTC 发布时间、原文入口），供核对 |
| `apply-official` | `--game <id>` + `--update-start` / `--preview-start`（`+08:00` ISO）+ 可选 `--update-end`、`--preview-end`、`--version`、`--note` | 校验后转发到服务覆盖层；`--clear` 清除覆盖回到公告规则 |
| `watch` | `--session <id>`（开启）；`--no-enabled` 取消（无需会话 id） | 用平台「自动化任务」能力登记/取消每周三 10:00 的 Agent 核对 |

覆盖层规则：

- 覆盖优先于规则结果，但**新公告晚于覆盖时间**时自动失效（避免旧修正压住新事实）。
- 只写一个时间也可以：另一个沿用规则；维护结束时间缺省按游戏惯例窗口补。更新覆盖只更新来源状态/卡片，前瞻覆盖才影响主日程条目。
- 校验：`update_end > update_start`、`preview_end > preview_start`、`preview_start < update_start`。

`watch` 使用平台「自动化任务」能力；未启用时命令返回降级说明，6 小时后台刷新与
`needsRefresh()` 照常工作。周检 prompt 明确要求先 `list`、再逛官方账号、最后按游戏写回。
会话 id 来自 `--session`、`SCHEDULE_SESSION_ID` 或 `DSH_SESSION_ID`；设置卡生成的 prompt 会注入实际 session id。

`index.js` 给 `systemPrompt` 注入来源说明；查公告与官方时间写回优先使用 `schedule gacha`，
读原文用 `schedule gacha posts`，不要另建重复条目。普通条目编辑/删除仍可用，来源刷新可能覆盖这些修改。

---

## 7. 设置卡

`client.settings.js` 注册进核心的 `schedule.settings.blocks`（`order: 20`），不新开页面：

- 六行游戏开关 + 每行的版本/更新/前瞻摘要，推算值前加 `≈`。
- "立即刷新"从服务拉取格式化结果；卡片轮询 `refreshing`，结束后广播 `schedule:data-changed`。
- "让 Agent 核对"创建普通会话并投递核对 prompt；失败信息就地展示。

---

## 8. 验证

离线：

```
node --test dsh-plugin/dsh-schedule-gacha/test/*.test.mjs
```

覆盖服务视图映射（UTC → `+08:00`）、对账、锁定与可编辑字段保留、
服务中断保底、覆盖转发与失败面。公告解析与推算规则的服务端测试见
gacha-calendar 仓库（`go test ./...`，含 2026-10-21 六游戏实抓校准快照）。

服务端实抓快照（2026-10-21，六款全部 `ok`，与插件时代输出一致）：

| 游戏 | 推算下一版本 | 更新时间 | 前瞻时间 | 更新依据 |
|---|---|---|---|---|
| 原神 | 7.2 | 2026-11-04 06:00 | 2026-10-23 19:30 | 42 天节奏 |
| 崩铁 | 4.7 | 2026-11-11 06:00 | 2026-10-30 19:30 | 版本结束时间 |
| 绝区零 | 3.4 | 2026-12-02 06:00 | 2026-11-20 19:30 | 版本结束时间 + 滚动 |
| 鸣潮 | 3.8 | 2026-11-11 04:00 | 2026-10-30 19:30 | 42 天节奏 |
| 终末地 | — | 2026-11-12 06:00 | 2026-10-30 19:30 | 公告阶段内容更新日 |
| 异环 | 1.5 | 2026-11-05 06:00 | 2026-10-23 19:30 | 42 天节奏 |

---

## 9. 已知限制

- **依赖服务可用性**：gacha-calendar 不可达时插件保留上一次成功的 plan 与条目，
  不写猜测值；恢复后自动追上。需完全离线时回退旧版本插件。
- **终末地没有数值版本号**：条目只写"版本更新"；前瞻视频按标题关键词匹配。
- **B 站风控会变**：服务端的端点/`Referer`/限流阈值可能无预告调整，采集失败只影响
  服务端更新，不影响插件已有条目。
- **前瞻日期在官方公布前只能推算**：卡片与描述都会标注"（推算）"，周检 Agent
  负责在有官方预告后写回。预告通常集中在周三，故周检定在周三 10:00。
