# BUAAer 智能日程

> **当前状态（2026-10-17）**：本仓库正在从「Electron + Flask + Vue 桌面应用」迁移为 **DSH（DeepSeek Harness）Cordis 插件**。新实现已写完、尚未在宿主中验收；旧实现保留至验收通过后删除。

## 迁移后的形态（当前主开发线）

```
dsh-plugin/
├── buaaer-schedule/                 # 主插件 @buaaer/dsh-schedule（Host + Client）
│   ├── index.js                     # Host：domain + 服务 + 工具 + 命令 + /api 通道
│   ├── host/…                       # semester/conflicts/sso/sync 等模块
│   ├── client.js                    # Client 入口（分块装载）
│   └── client.*.js                  # 日历/任务/剪贴板/设置各分块
└── buaaer-schedule-reminders/       # 次级提醒插件 @buaaer/dsh-schedule-reminders
```

- 安装：`plugin_manager { action: "install_bundle", target: "<dsh-plugin/buaaer-schedule 绝对路径>" }`（次级插件同理）。
- 设计/范围/拍板与验收台账：**`docs/dsh-plugin/00-migration-checklist.md`**（唯一执行台账）；DSH 插件开发参考：同目录 `01`–`08`。
- 旧库迁移：`node scripts/export-legacy-db.mjs` 导出 JSON → 会话内 `/buaaer-import <路径>`（或设置页图形导入）。
- 旧实现（`electron/`、`backend/`、`frontend/` 等）在对应验收通过前**保留不动**；下方文档描述的是旧形态，仅供考古。

---

# 旧实现文档（Electron 桌面版，迁移期保留）

一个专为北航学生设计的智能日历系统，集成了课程管理、任务安排、智能输入和 LLM 辅助功能，帮助学生高效管理时间和任务。

## 项目简介

北航智能日历系统是一个全栈Web应用，旨在为北航学生提供一个集成化的时间管理平台。系统结合了传统日历功能与AI智能助手，能够自动解析任务描述、生成日程安排，并提供个性化的时间管理建议。

## 技术栈

### 桌面应用

- **框架**: Electron 36.x
- **打包工具**: electron-builder 26.x
- **安全**: 已修复所有已知高危漏洞

### 后端

- **框架**: Flask 2.0+
- **数据库**: SQLAlchemy (SQLite)
- **认证**: JWT
- **LLM集成**: 支持多种大语言模型API
- **API设计**: RESTful

### 前端

- **框架**: Vue 3
- **构建工具**: Vite
- **状态管理**: Pinia
- **UI组件**:
  - FullCalendar (日历视图)
  - Chart.js (数据可视化)
- **HTTP客户端**: Axios

## 功能特性

### 核心功能

- **课程管理**: 自动导入北航课程表，支持手动调整和冲突检测
- **任务管理**: 创建、编辑、删除任务，支持优先级、截止日期和完成状态跟踪
- **日历视图**: 直观展示日程安排，支持拖拽调整
- **四象限视图**: 基于重要性和紧急性的任务管理视图，帮助用户高效分配时间
- **同步作业功能**: 支持从SPOC自动同步作业信息，包括截止日期和提交状态
- **智能输入**: 支持自然语言输入任务，自动解析时间和内容
- **LLM辅助**: 利用大语言模型生成智能日程建议和任务完成安排
- **提醒服务**: 多级提醒系统，支持课程、作业和考试的自定义提醒时间
- **手机端支持**: 完整的移动端适配，支持iOS和Android设备通过web查看

### 高级功能

- **剪贴板队列**: 批量处理复制的任务内容
- **事件编辑**: 拖拽调整事件时间，快速编辑，支持颜色自动分配
- **设置面板**: 个性化配置系统参数，包括主题颜色和精力周期
- **专注模式**: 提供无干扰的专注工作环境，支持自定义专注时长
- **头像设置**: 支持上传和管理用户头像
- **数据本地保存**: 所有数据保存在本地SQLite数据库，确保隐私安全
- **深色模式**: 支持浅色/深色主题切换，适配不同使用环境
- **响应式设计**: 自动适配不同屏幕尺寸，提供最佳用户体验

## 项目结构

```
intelligent-calendar-for-BUAAer/
├── electron/               # Electron 主进程
│   ├── main.js            # Electron 主入口
│   └── preload.js         # 预加载脚本
├── backend/                # 后端代码
│   ├── models/            # 数据模型
│   ├── routes/            # API 路由
│   ├── services/          # 业务逻辑
│   ├── utils/             # 工具函数
│   ├── app.py             # 应用入口
│   ├── config.py          # 配置文件
│   ├── extensions.py      # 扩展初始化
│   └── requirements.txt   # 依赖列表
├── frontend/              # 前端代码
│   ├── public/            # 静态资源
│   ├── src/               # 源代码
│   ├── index.html         # HTML 模板
│   ├── package.json       # 依赖配置
│   └── vite.config.js     # Vite 配置
├── package.json           # 项目配置（Electron）
├── .gitignore             # Git 忽略文件
├── README.md              # 项目说明文档
├── ELECTRON_README.md     # Electron 安装指南
└── INSTALLATION.md        # 详细安装指南
```

## 快速开始

### 环境要求

- Node.js 16.x 或更高
- Python 3.8 或更高
- npm 8.x 或更高
- pip 20.x 或更高

### 安装与运行

请参考详细的[安装指南](./INSTALLATION.md)，包含：

- Node.js 和 Python 安装步骤
- 项目代码获取方法
- 后端环境配置
- 前端环境配置
- EasyOCR 安装与替代方案
- 常见问题与解决方案

### 启动应用

#### 方式一：Electron 桌面应用（推荐）

```bash
# 安装所有依赖
npm run install:all

# 启动 Electron 开发环境
npm run electron:dev
```

#### 方式二：Web 应用（传统方式）

1. **启动后端服务**:
   ```bash
   cd backend
   python app.py
   ```
2. **启动前端服务**:
   ```bash
   cd frontend
   npm run dev
   ```
3. **访问应用**:
   在浏览器中访问 <http://localhost:5173> 即可使用应用。

#### 方式三：使用 cpolar 远程访问（可选）

如需在手机或其他设备上远程访问，可使用 cpolar 内网穿透：

```bash
# 配置 cpolar 认证（首次使用）
cd cpolar
cpolar.exe authtoken YOUR_TOKEN

# 启动 cpolar
cd ..
npm run start:cpolar
```

启动后 cpolar 会显示公网访问地址，在远程设备浏览器访问即可。

详细说明请参考 [Electron 安装指南](./ELECTRON_README.md)

## Electron 桌面应用打包

构建可分发的桌面应用：

```bash
npm run electron:build
```

构建完成后，可执行文件位于 `dist/` 目录：

- `dist/BUAAer 智能日历 Setup x.x.x.exe` - Windows 安装程序
- `dist/win-unpacked/` - 免安装版本

### 打包注意事项

1. **cpolar 集成**: 打包时会自动包含 cpolar（如果存在）
2. **Python 环境**: 用户需要安装 Python 3.x
3. **应用图标**: 使用 `frontend/public/favicon.ico`
4. **安装位置**: 用户可自定义安装目录

详细说明请参考 [Electron 安装指南](./ELECTRON_README.md)

## API 文档

### 认证管理

- `POST /api/auth/buaa_id` - 设置北航学号
- `GET /api/auth/buaa_id` - 获取北航学号

### 课程管理

- `GET /api/courses` - 获取课程列表
- `POST /api/courses` - 添加课程
- `PUT /api/courses/<id>` - 更新课程
- `DELETE /api/courses/<id>` - 删除课程
- `POST /api/courses/sync_buaa` - 同步北航课程表
- `POST /api/courses/sync_buaa/<date>` - 按指定日期同步北航课程表

### 日历条目

- `GET /api/entries` - 获取所有条目
- `POST /api/entries` - 创建日历条目
- `PUT /api/entries/<id>` - 更新日历条目
- `DELETE /api/entries/<id>` - 删除日历条目
- `GET /api/entries/<date>` - 获取指定日期及之后7天内的所有条目

### 任务管理

- `GET /api/tasks` - 获取任务列表
- `POST /api/tasks` - 创建任务
- `PUT /api/tasks/<id>` - 更新任务
- `DELETE /api/tasks/<id>` - 删除任务
- `PUT /api/tasks/<id>/complete` - 标记任务为完成
- `PUT /api/tasks/<id>/uncomplete` - 标记任务为未完成

### 提醒管理

- `POST /api/reminders/upcoming` - 获取即将到来的提醒

## 功能模块详细说明

### 1. 课程管理

- 支持从北航教务系统自动导入课程表
- 提供手动添加、编辑、删除课程的功能
- 课程自动显示在日历视图中
- 支持课程冲突检测

### 2. 任务管理

- 支持创建不同类型的任务（作业、考试、项目等）
- 任务优先级设置（高、中、低）
- 截止日期提醒
- 任务完成状态跟踪
- 任务分类和标签

### 3. 智能输入

- 支持自然语言输入任务描述
- 自动解析时间、地点、优先级等信息
- 批量处理剪贴板内容
- 智能补全和建议

### 4. LLM辅助

- 利用大语言模型生成日程安排建议
- 自动优化时间分配
- 提供个性化的学习计划
- 支持多轮对话式交互

### 5. 日历视图

- 拖拽调整事件时间
- 事件详情查看和编辑
- 支持不同类型事件的颜色区分

### 6. 手机端支持

- **访问方式**: 通过扫描PC端生成的二维码快速访问，直接输入URL访问，支持添加到手机桌面
- **核心功能支持**: 完整的课程管理功能，任务创建、编辑和完成状态管理，智能输入功能，日历视图查看和操作，四象限视图支持，SPOC作业同步，设置面板和个性化配置，深色模式切换
- **用户体验优化**: 响应式设计，适配不同手机屏幕尺寸，触摸友好的交互界面，优化的移动端性能，支持断网离线访问
- **连接方式**: 支持同一网络下的本地连接，支持通过cpolar内网穿透实现远程访问，自动检测最佳连接方式

### 7. 深色模式

- 支持手动切换和系统主题跟随
- 优化的深色配色方案，减少眼部疲劳
- 全组件深色模式支持
- 移动端和桌面端一致的深色体验

## 开发指南

### 代码规范

- 后端：遵循 PEP 8 规范
- 前端：遵循 Vue 3 最佳实践
- 提交信息：使用语义化提交信息

### 测试

- 后端：使用 pytest 进行单元测试
- 前端：使用 Vitest 进行组件测试
- 集成测试：使用 Postman 或 curl 进行API测试

### 开发流程

1. 创建分支：`git checkout -b feature/xxx`
2. 开发功能
3. 提交代码：`git commit -m "feat: add xxx feature"`
4. 推送分支：`git push origin feature/xxx`
5. 创建 Pull Request
6. 代码审查
7. 合并分支

***

**北航智能日历系统** - 让时间管理更智能，让学习生活更高效！
