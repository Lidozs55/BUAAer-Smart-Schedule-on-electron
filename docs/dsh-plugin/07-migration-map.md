# 07 · 现有功能 → DSH 扩展点映射

> 依据：对本仓库 `electron/`、`backend/`、`frontend/` 的逐文件清点。表格里的"现有资产"可以直接按名字去读源码。
> 结论先行：**不要 1:1 搬运**。现有实现是「Electron 壳 + Flask HTTP 服务 + Vue SPA + SQLite + 轮询」，DSH 插件是「同进程 Host 服务 + 工具 + Client 槽位页面 + 存储 domain + durable 定时」。分层会变，功能保留。

---

## 1. 形态对照

| 现在的层次 | 落地到 DSH |
|---|---|
| Flask（`backend/app.py` + `routes/*` + `services/*`）运行在 5000 端口，靠 HTTP 被前端调用 | **Host 半的服务方法**：同进程直接调用，没有 HTTP、没有端口、没有 CORS。数量级上，现有 8 个蓝图 ≈ 1 个 `apply()` 里注册的几个服务与工具 |
| Vue 3 SPA（`frontend/src`，Vite 5173 / `frontend/dist`） | **Client 半**：在宿主 Web UI 的槽位里渲染 React 组件；页面选择见 `03-client-ui.md` |
| Pinia store（`frontend/src/store/index.js`） | 组件本地状态 + 通过 Remote 从 Host 读**投影后的值**（见 `04-data-and-state.md`）；跨会话共享的数据留在 Host |
| SQLite（`backend/instance/app.db`，SQLAlchemy，4 张表） | `ctx.storage` / `ctx.storage.domain`（KV domain，可落 JSON 或 SQLite 后端），见 `04-data-and-state.md` |
| 60 s 轮询 + 浏览器 `Notification`（`frontend/src/services/notification.js`） | `ctx.schedule` 的 durable 提醒 + `ctx.jobs` 的可见后台任务，见 `05-time-and-background.md` |
| Electron 主进程（托盘、悬浮窗、窗口控制、杀进程） | **大部分没有对应物**（见 §5）；DSH 是 Web UI + 可选 Desktop 壳，插件插不进操作系统的托盘/悬浮窗 |
| `.env` 里的 LLM 配置 + dashscope/openai SDK 直连 | `ctx.llm`（provider-neutral seam，用户已在模型设置里配好）或把理解类需求交给 Agent 工具 |

**推荐拆法**：一个 bundle，两个半。
Host 半 = 领域服务（课程/任务/日历条目读写、BUAA 同步、提醒登记）+ Agent 工具（`06`）+ 定时（`05`）+ 存储（`04`）。
Client 半 = 一个日历/任务页面（`03`），只做展示与交互，所有写操作都走 Host 服务。

---

## 2. 后端路由 → DSH 落点

| 现有资产 | 现职责 | DSH 落点 | 迁移要点 |
|---|---|---|---|
| `GET /api/health` | Electron 用它等后端起来 | 删除 | 同进程，没有"等后端启动"这回事 |
| `POST/GET /api/auth/buaa_id`（`routes/auth.py`） | 单例 `User.buaa_id` 读写 | Host 服务方法 + Config/存储记录 | 学号属于**用户数据**，存 storage domain，不要放插件代码 |
| `GET /api/courses/`、`POST/PUT/DELETE /api/courses/<id>` | 课程 CRUD | Host 服务 + 工具（`buaaer_course_*`） | 课程是"周期规则 + 例外日期"（现有 `day_of_week`、`week_range`、`date`），domain 记录要保留这个语义 |
| `POST /api/courses/sync_buaa`、`/sync_buaa/<date>` | 抓北航教务 7 天课表后**先删全表再插入** | Host 服务 + 一个工具 + 一个后台 job | ⚠️ 现有是破坏性写（`save_courses` 先 `Course.query.delete()`），迁移改成按学期/按周 upsert；同步是长任务，用 `ctx.jobs` 让它可观察、可取消 |
| `POST /api/courses/init_session`、`/check_login`、`/process_login_callback`、`GET /fetch_course_schedule`、`POST /destroy_session` | BUAA SSO 会话管理（进程内 `requests.Session`，30 分钟空闲过期） | Host 服务内部状态 + `ctx.credentials` | SSO 会话不是用户可见数据，放插件内存在层即可；**密码绝不落盘**（现在也没落盘，保持住）。若要缓存凭据，用 `ctx.credentials` 而不是 `.env` |
| `GET/POST /api/entries[...]`（`routes/entries.py`） | 日历条目 CRUD；`<date>` 会 **+1 天**并返回 7 天窗口 | Host 服务 + 工具 | 时间语义必须重写：现有把**本地时间当 UTC 存**（`parse_datetime_local()`），迁移统一用带时区的 ISO 8601 或明确 UTC+8。日期窗口的 +1 天偏移是历史事故，不要继承 |
| `GET/POST/PUT/DELETE /api/tasks/`、`/<id>/complete`、`/<id>/uncomplete` | 任务 CRUD 与完成状态（完成时改 `Entry.color` 并给标题加 `[任务已完成]`） | Host 服务 + 工具 | "完成任务顺手改日历条目样式"应显式建模成一次事务式操作；不要靠改标题字符串表达状态 |
| `POST /api/llm/parse/text`、`/parse/voice`、`/parse/image`、`/parse/clipboard` | 拼 prompt 调 LLM 解析自然语言 → **后端直接建 Task+Entry** | 见 §4「智能输入」 | 现在的接口"解析即落库"，语义模糊；迁移后解析与写入分开 |
| `POST /api/llm/generate/entries_from_task` | 由任务生成日历条目 | Host 服务 + 工具 | 这是"排期"逻辑，可作为服务方法被 UI 与 Agent 共用（`06` §3） |
| `POST /api/schedule/check_conflict`、`/auto_schedule`、`/find_available_slots` | 冲突检测/自动排期（`find_available_slots` 恒返回空数组） | Host 服务 | ⚠️ `services/schedule_manager.py` 读了 `Course.user_id` 与 `Task.estimated_time`，而模型里**没有这两列**——这两条路径现在就是坏的。迁移时按新模型重写 |
| `POST /api/schedule/schedule_break` | 插入一条绿色休息条目 | Host 服务/工具 | 保留为"建议"动作，不要自动写库 |
| `POST /api/settings/api_key`、`/llm_config`、`/test_connection` | 把 LLM key 明文写进 `.env`，测试连接带 5 次/分钟限流（限流键写死成 `'default'`） | `ctx.llm` + `Config` + `ctx.credentials` | 不再由插件维护 LLM key：用宿主模型配置。确实需要自建 key 的第三方调用，用 `ctx.credentials` 存，不要写 `.env` |
| `GET|POST /api/reminders/upcoming` | **读形状的接口会删除过期任务**，返回提醒列表 | `ctx.schedule`（可选能力，需启用「自动化任务」bundle，见 `05` §4） | 现有的"提醒"其实只是 getter；真正的提醒要在 DSH 侧用 durable 提醒实现 |
| `GET /api/mobile/info`、`POST /api/mobile/set_cpolar_authtoken` | 生成二维码、写 `~/.cpolar/authtoken`、拉起 cpolar | **删除** | 见 §5 |
| `GET /`、`/<path>`、`/mobile*`、`/assets/*`、`/svg/*`、`/sound/*` | 静态托管与 Vite 代理 | **删除** | Client 半由 DSH 的 client module system 提供给页面；静态资源随包走 `exports` |

---

## 3. 前端组件 → Client 半

| 现有资产 | 现职责 | DSH 落点 | 迁移要点 |
|---|---|---|---|
| `App.vue`（1826 行） | 壳：顶栏、页面切换、窗口控制、二维码/设置浮层、多个定时器 | 拆分 | 窗口控制（`window.electronAPI.*`）**没有对应物**；页面切换交给宿主布局；浮层改成插件页面/设置页 |
| `components/CalendarView.vue`（2090 行，FullCalendar 周视图） | 日历主视图、拖拽改期、撤销/重做（上限 5 步）、周末着色、工具栏 | **`main` 槽位（keyed / root，自取 key）+ `sidebar.panellist` 图标（同 id）**，见 `03` §3.2 | FullCalendar 是 React/Vue 通用库，React 侧可用；但**不要**去改宿主 DOM（现在会 `document.querySelector('.fc-toolbar-title')`）——标题由你自己的组件渲染 |
| `pages/MobileHome.vue` + `components/mobile/*` | 手机端 4 个 tab | **删除** | 手机端 SPA 与 `web.electronAPI`/假 IP 是同一条历史线；DSH 的 Web UI 有自己的响应式行为，不要另起一套 |
| `components/TaskSidebar.vue`（1165 行） | 任务列表、进度环、24h 内提醒、增改弹窗 | 插件页面的一块（或独立面板） | `confirm()/alert()` 换成宿主风格的对话框（自己实现，见 `03` 的禁 require 规则） |
| `components/EventEditModal.vue`、`BatchAddModal.vue` | 事件编辑、批量重复任务 | 插件页面组件 | 批量添加是纯前端循环调用 `entriesAPI.addEntry`；迁移后一次远程调用批量写入更合适 |
| `components/SettingsPanel.vue`（1095 行） | BUAA 学号/密码/同步、提醒设置、主题色、精力周期、LLM 配置 | `settings.section` 槽位 + `Config` | 主题色/深色交给宿主主题 token，不要再维护自己的 `--primary-color` 变量体系 |
| `components/SmartInput.vue`、`ClipboardQueue.vue` | 文本/语音/图片/剪贴板输入 → LLM 解析 → 确认创建 | 见 §4 | 剪贴板用浏览器 Clipboard API；语音用宿主语音 seam；图片 OCR 见 §4 |
| `src/services/api.js` | axios 封装 9 个命名空间 | 删除 | 换成 Client 半对 Host 的 Remote 调用（`03`） |
| `src/services/notification.js` | 60 s 轮询 + Web Notification | 删除 | 换成 `ctx.schedule`（`05`） |
| `src/store/index.js`（Pinia 6 个 store） | 全局状态 | 组件状态 + Host 投影 | 跨会话数据不要留在浏览器内存里 |

---

## 4. 两个重点功能的落点

### 4.1 智能输入（自然语言 → 条目）

现状：`routes/llm.py` 拼 prompt（含"已占用的时间片"）、调用 dashscope/openai、`json.loads` 后**直接在服务端建库**；`_get_occupied_slots()` 还会回调自己的 `http://127.0.0.1:5000/api/entries/<date>`。

迁移建议：

1. 拆成两个动作：**解析**（纯函数/LLM 调用，返回候选条目）+ **写入**（服务方法，接收候选列表并做冲突校验）。两者都能被 UI 与 Agent 调用。
2. "已占用时间片"从本地存储直接读，不要自调 HTTP。
3. 让模型理解自然语言这件事，优先交给 **Agent 工具**（用户说"把这堆东西加进日程"时，Agent 直接调用你的写入工具），而不是插件里再维护一套 prompt + LLM 客户端。确需确定性解析（离线、批量剪贴板）时，用 `ctx.llm` 的 seam：`resolveCallConfig` / `prepareCall` / `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`（先 inspect 确认当前 profile 的 provider 与可用模型）。
4. 语音：宿主有语音 seam（`speechToText` / `speechController`）。用之前 inspect 确认是否启用，不要自己接第三方 ASR。
5. 图片 OCR：现有依赖 Python 的 EasyOCR。DSH 侧没有等价 seam，可选路径：(a) 把 Python 侧当**子进程**保留（`ctx.subprocess`）；(b) 让 Agent 走"读图 + 理解"的能力；(c) 暂时砍掉该入口。**不要**把 Python 解释器塞进插件进程。

### 4.2 BUAA 教务同步

现状：`services/buaa_api.py` 抓 `detail.do?rq=<date>&lxdm=student` 与 `exams.do?termCode=<…>`，SSO 走 `sso.buaa.edu.cn` 表单（从 HTML 里刮 `execution`），请求头写死 Chrome/142 UA、`Referer: byxt.buaa.edu.cn`、`X-Requested-With`、`fetch-api: true`、一串 `sec-ch-ua*`；学期码规则：8–12 月 `{Y}-{Y+1}-1`，1–2 月 `{Y-1}-{Y}-1`，其余 `{Y}-{Y+1}-2`。

迁移建议：

- 直接改写成 Host 服务里的 `fetch` 调用（同进程 Node），**把头与学期码规则原样保留**——这些是学校侧的要求，不是历史包袱。
- 同步注册为**工具**（`buaaer_course_sync`）且实现为**后台 job**（`ctx.jobs`）：7 次逐日请求、每次间隔约 0.2 s，正好符合"长任务、可观察、可取消"。
- 登录凭据：学号/密码只在这次同步调用里使用，**不持久化**；需要长期凭据（例如 LLM key）走 `ctx.credentials`。
- 解析结果按学期/按周做 upsert，保留"第几周"的语义，不要沿用"删全表再插入"。

---

## 5. 明确不要迁移的东西

| 现状 | 为什么不要 | 替代 |
|---|---|---|
| Electron 托盘菜单、双击托盘显示窗口 | 插件插不进操作系统托盘 | 宿主侧边栏/面板入口 |
| 悬浮窗（`float-window.html`，置顶 + 透明度 + 每 60 s 轮询） | 同上；且它直接 `require('electron')`、`innerHTML` 拼未转义标题 | 宿主浮层槽位或右侧面板（先 inspect 再选） |
| 无边框窗口控制（最小化/最大化/关闭/IPC） | 属于桌面壳，不属于插件 | 无（宿主自带窗口） |
| `taskkill /F /IM python.exe /T`、`pkill -9 -f backend_server` | 会杀掉用户机器上**所有** Python 进程 | 只管理自己起的东西，并在 `ctx.effect` 里清理 |
| 无 `requestSingleInstanceLock` 的双实例行为、`0.0.0.0:5000` 监听、固定端口 | 单进程、无端口是 DSH 的默认 | 无 |
| cpolar 内网穿透、二维码远程访问、`~/.cpolar/authtoken` 明文写入 | 由宿主/部署负责远程访问 | 宿主自带的访问方式（见官方 `docs/user/guide/network-proxy.zh.md` 等） |
| `/mobile` 手机端 SPA、`MobileSettings` 里的假 IP/假同步 | 是演示代码，不是功能 | 无 |
| `.env` 里的 LLM key 与 `dashscope`/`openai` SDK 直连、`.env` 就地改写 | 宿主已有模型配置 | `ctx.llm` 或工具交回 Agent |
| `frontend/public/sound/`、`/sound/<path>` 路由（目录不存在）、`icon-light-*` 图标名（文件不存在） | 已经是坏引用 | 清理掉 |
| README 里描述的 JWT 鉴权、SPOC 作业同步、四象限视图、专注模式、头像上传、Chart.js 可视化 | **代码里并不存在**（README 与实现已漂移） | 立项前先按本文件核对真实实现，不要照 README 排期 |

---

## 6. 迁移时顺手要修的既有缺陷

按"会被新代码继承"的危险程度排序：

1. **时区**：`entries.py` 把本地时间 `replace(tzinfo=None)` 当 UTC 存，`to_dict()` 又不带时区；前端用 `toISOString().split('T')[0]`（UTC 日期）。新实现统一一种语义并在存储层写清注释。
2. **日期窗口 +1 天**：`GET /api/entries/<date>` 内部 `date + 1 day` 再取 7 天，调用方还得自己减一天（`SettingsPanel`、`MobileCalendar` 都在减）。新接口的语义必须自洽。
3. **读接口有删除副作用**：`GET|POST /api/reminders/upcoming` 会删掉所有已过期任务；`POST /api/courses/save_courses` 会清空课程表。危险写操作要改名/拆开。
4. **模型与代码不匹配**：`course.user_id`、`task.estimated_time` 被读取但不存在于模型 → 冲突检测/自动排期必然报错。
5. **限流键写死 `'default'`**：5 次/分钟对**所有**客户端合并生效，且重启即失效。
6. **凭据**：`backend/.env` 明文存 LLM key；`~/.cpolar/authtoken` 明文；学号密码经 HTTP 明文传输（`0.0.0.0:5000`，无鉴权、无 TLS）。迁移后不得再现。
7. **未转义渲染**：`float-window.html` 用 `innerHTML` 拼条目标题。React 默认转义，但自造 `innerHTML` 的地方要盯住。
8. **`sys._MEIPASS` 判断**：打包用的是 Nuitka，而代码用 PyInstaller 的 `_MEIPASS` 判断"是否生产环境"；若保留 Python 子进程，这条要改对。
9. **静态资源缺文件**：见 §5 倒数第二行。

---

## 7. 建议的落地顺序（每步都能独立验收）

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 | bundle 骨架：能安装、能在宿主 UI 里渲染一个空日历页（Client 半 + 空 Host 半） | `install_bundle` 返回 `applied`；页面刷新后可见；控制台无 `slot entry crashed` |
| M1 | 存储 domain + 条目/任务读写服务 | 重启后数据仍在；工具与 UI 都能读到同一份数据 |
| M2 | Agent 工具（任务 CRUD、冲突检查、批量写入） | 只用工具跑一遍增删改查，且与 UI 行为一致 |
| M3 | durable 提醒（替换 60 s 轮询与 Web Notification） | 到点真的提醒；跨重启仍在 |
| M4 | BUAA 课程同步（工具 + 后台 job + upsert） | 同步可观察、可取消；失败留下可行动的原因 |
| M5 | 智能输入（解析/写入分离；语音与 OCR 另行决策） | 解析结果与写入结果分离可测；Agent 路径与 UI 路径结果一致 |

删旧实现不要早于对应阶段的验收：M1 之后再考虑停掉 Flask，M3 之后再拆 `notification.js`。
