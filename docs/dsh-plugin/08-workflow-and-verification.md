# 08 · 开发、安装、验收流程与禁忌

> 这一篇是"动手时的操作手册"。所有结论都指向同一个原则：**运行时的回答才算证据**——`plugin_manager` 的返回值、`cordis_inspect_query` 的现场结果、已连接页面里的真实渲染。

---

## 1. 开发循环（六步）

```
写包文件 → 自检 → install_bundle → 读返回值 → inspect 核对 → 在页面/工具里真跑一遍
   ↑                                                                    │
   └──────────────────────── 有缺陷就在同一个包里改 ────────────────────┘
```

一次只推进一条最小可用路径：先把"能被安装、能被看到"实现出来，再谈细节与美观。

---

## 2. 前置条件

| 项 | 要求 | 备注 |
|---|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` | DSH 根清单的 `engines` |
| pnpm | 11.7.0 | 只在 DSH checkout / profile 安装链路里需要；**不要**在 profile 目录手动跑 |
| 构建工具 | 手写 bundle **不需要** | `index.js` / `client.js` 就是产物；只有编译型源码才需要 Client 构建链 |
| DSH 版本 | 本机 checkout `@deepseek-ai/dsh-root@0.2.0-rc.2` | DSH 处于 developer preview，**随时会有破坏性变更**；升级后必须重新 inspect 核对 |

环境变量（profile 启动的 Harness 里才有）：`DSH_PROFILE`（profile 名）、`DSH_PROFILE_DIR`（其目录，`node_modules` 只放 profile 安装的 bundle）。这两个值在**没有** profile 启动的 Harness 里不存在——不要据此猜路径。

### 2.1 scratch web 宿主（本插件的本地验证环，2026-10-17 实测通过）

不污染真实 profile 的隔离验证方式，改完插件代码后的标准回路：

```bash
# 1) 用临时 home 起 web 宿主（隔离 DSH 配置与数据）
DSH_HOME=<空临时目录> dsh web

# 2) 另开终端，同一 DSH_HOME 下把 bundle 链接安装进 web profile
DSH_HOME=<同上> dsh plugin --profile web add <dsh-plugin/dsh-schedule 绝对路径>
DSH_HOME=<同上> dsh plugin --profile web add <dsh-plugin/buaaer-schedule-buaa 绝对路径>
```

- 先装核心再装来源适配器；来源插件 `inject: ['buaaerSchedule']`，核心缺失时会 park。

- `dsh web` 监听 3080 端口，控制台会打印一条**带 token 的完整 URL**——必须打开那条 URL（裸 `http://127.0.0.1:3080` 过不了鉴权）。
- 打开后侧边栏应出现「日程/剪贴板」入口；宿主半激活失败会打在启动日志里（fiber 状态 `failed`，`loading` 卡死 = apply 未返回）。
- 链接安装指向源码目录：改插件源码后**重启 scratch 宿主**即生效（不需要重新 add）。
- 用完停掉宿主、删除临时目录。不要把测试数据写进真实 profile。

排查数据通道时可用两个探针区分故障层：`/connect` 有响应而 `/api/buaaer-schedule` 404 = connection 激活竞态或路由未注册（见 `00` §4.3）；两者都 404 = 宿主/鉴权层问题。

---

## 3. 包内自检（安装前必须做完）

1. **JSON 合法**：`package.json` 可被解析；`name` 唯一；`exports` 指向真实存在的文件。
2. **YAML 合法**：`cordis.patch.yml` 是数组，每项是映射；`insert` 下每个 row 有 `id` 与 `name`。
3. **导出形态单一**：要么 `export function apply`（可带 `export const inject` / `export const Config`），要么 `export default <Service 类>`；**不要混用**。
4. **Client 半**：`client.js` 里的 `window.__ModuleLoader__.load({ id })` 中 `id` **必须等于包名**；`dsh.client` 段存在且 `platform: "web"`。
5. **注册都带清理**：`apply` 内每个注册都包在 `ctx.effect(...)` / `ctx.on(...)` 里。
6. **没有裸副作用**：模块顶层不要做 IO、不要读全局状态；Client 的 factory 必须无副作用。
7. **可选依赖判空**：`ctx.get('x')` 之后有判空分支，或写进 `inject` 让插件在该 profile 里安静地不激活。

---

## 4. 安装与启用

```
plugin_manager { action: "install_bundle", target: "<bundle 目录绝对路径>" }
```

- `target` 用**绝对路径**，不要用相对路径或通配。
- 若返回 `pendingBuilds`，**先向用户说明这些安装脚本会执行什么**，得到明确同意后才在再次调用时传 `approvedBuilds`。
- 不要把返回的失败/pending 当成可忽略的噪声；也不要自己用 shell 复现 `install_bundle` 的步骤（写 profile `package.json`、跑 pnpm、选 bundle 都由它负责）。

其它动作：`list_plugins` / `set_plugin` / `list_bundles` / `set_bundle` / `remove_bundle`。

> 每个 `plugin_manager` 动作在没有完全权限时都需要审批。**只在结果会决定下一步时**才调用；能用 `cordis_inspect_query` 回答的问题（它不需要审批）就不要去翻列表。

---

## 5. 读返回值决定"是否上线"

| 返回值 | 含义 | 你要做什么 |
|---|---|---|
| `application: applied` | 变更已生效 | 继续验收 |
| `warnings: [...]` | 有告警 | 逐条读；常见于 patch 目标不匹配被跳过 |
| `failed` | 激活失败 | 必须排查（依赖缺失、Config 校验失败、导出形态错误……） |
| `overridden` | 更高优先级的 patch 层赢了 | 你的覆盖没生效，检查 profile 里是否有更高优先层 |
| `restart-required` | **变更没有上线** | 需要重启才能加载（典型：替换已安装包的代码） |

其它已知语义：

- 新装 bundle 可能经 HMR 直接激活。
- **替换**已安装的包必须重启才会加载新的 JS 模块代。
- **slot id 没变，不能推断浏览器代码已更新**——浏览器产物是独立的一代，改了 Client 半要重建并刷新页面。
- 新增的 row 用 `cordis_inspect_query`（`Config.listConfigs` 过滤 `name`）确认，比翻插件列表更直接。

---

## 6. 验收清单

### 6.1 Host 能力

- [ ] 用 inspect 看到预期的服务/工具/命令/Config（`Service` / `Tool` / `Config` 三个 provider）。
- [ ] 通过 **Agent 工具**真的执行一次，检查返回结构、失败路径、取消路径（打断后不能留下写了一半的状态）。
- [ ] 涉及持久化的，重启后数据仍在且能重建（见 `04-data-and-state.md`）。

### 6.2 Client UI

- [ ] 在**已连接的**页面里刷新后看到渲染结果（页面地址以当前会话给出的为准；不要另起服务器）。
- [ ] 明暗两套主题都读得通；样式只用 `--dsw-*` 主题 token，不写死颜色。
- [ ] 控制台没有 `slot entry crashed in '<slot>'`。
- [ ] 与同类宿主页面比对：间距、字号、行模式、圆角（圆角按 `docs/ui-radius.zh.md` 的统一规范）。
- [ ] 可见文案走 Client locale 服务，不要在组件里写死中文/英文。
- [ ] 卸载/禁用后页面干净（没有残留的 DOM、监听、定时器）。

### 6.3 验收的诚实性

- 安装成功 + 槽位注册**不等于**用户能看到。报告结论时要区分"已验证"和"未能验证"。
- 没有浏览器控制时：只做 JavaScript 语法、清单校验、live Client 槽位检查，并**明确说明**视觉验证不可用。
- 不要为了拿到截图而：另起浏览器、改 `HOME`、翻个人浏览器 profile、搜 token、改钥匙串、找/写光栅化工具、把 SVG 抠成预览图、用 mock 页面冒充运行中的插件。
- 为测试起的子进程/临时资源，用自己独占的目录、设超时、结束时清理；一个失败的可选预览不能演变成"环境修复"，也不能挡住安装。
- 测试期间改过的用户设置/状态，测完要还原。

---

## 7. 排查表

| 现象 | 优先怀疑 |
|---|---|
| 安装报 `failed` | `Config` 校验失败；`inject` 的服务在该 profile 不存在；导出形态混用（`export default` 丢了 `inject`） |
| row 在列表里有但能力不存在 | `disabled` 为真；`overridden`；bundle 选择未生效 |
| 改了代码没变化 | 替换已安装包需要重启；Client 半需要重建产物 + 刷新页面 |
| 页面某块空白，控制台有 `slot entry crashed` | 组件抛错（常见：`require` 了 DSH Client 包、读了不存在的 props、访问了别的插件的 DOM） |
| 样式不跟随主题 | 用了字面颜色或自造变量，而不是 `--dsw-*` token |
| 工具在 schema 里看不到 | `ctx.tools.restrict()` 把它裁掉了；或注册发生在错误 scope；或插件没激活 |
| 定时提醒不触发 | 用的是 `agent.inject()`（不唤醒）而不是 `agent.followup()`；或定时器随插件卸载被清掉了；或 `schedule` 能力未启用（可选 bundle） |
| 明暗切换后局部错乱 | 用了 iframe 承载页面（拿不到宿主主题） |

---

## 8. 变更的影响面与回滚

- 插件是 **profile 级**的：安装/启停影响该 profile 下的**所有**会话，并且重启后依然存在。动手前想清楚这一点。
- 回滚手段：`set_plugin` 关掉具体 row → `set_bundle` 关掉整个 bundle → `remove_bundle` 卸载。
- 用户写在 `cordis.patch.yml` 里的配置层在插件升级后仍保留，所以**可调值一定走 `Config`**，不要把默认值硬编码进代码再让用户改代码。

---

## 9. 禁忌（汇总，逐条都是踩过的坑）

1. ❌ 手写 profile 的 `package.json` / `cordis.patch.yml`；❌ 在 profile 目录跑 pnpm；❌ 在 `$DSH_HOME` 下建包。
2. ❌ 用 `export default` 导出函数/类却指望 `export const inject` 生效。
3. ❌ 给 Session 日志追加新的事件 `type`。
4. ❌ 在 Client 半 `require` 任何 `@deepseek-ai/dsh-client-*` 包（含 `dsh-client-ui-primitives`）；`dsh.client.inject` 只用于排序激活。
5. ❌ 用 iframe 承载插件页面；❌ 替换应用根；❌ 向 `document.body` 追加第二个应用；❌ 读写别的插件的 DOM/样式。
6. ❌ 轮询 `agent/status`；❌ 用 `session/event` + 全量重扫代替 `ctx.sessionProjections`。
7. ❌ 用 `system-prompt/assemble` 增删工具或提示文字。
8. ❌ 直接把业务逻辑写在 UI 或工具里（应当只有一个 Host service 实现）。
9. ❌ 为了截图/预览编造验证（mock 页面、光栅化脚本、另起服务器）。
10. ❌ 把默认配置写死在代码里而不给 `Config`。
