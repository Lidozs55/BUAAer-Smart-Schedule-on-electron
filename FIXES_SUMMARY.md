# 修复总结

## 已修复的问题

### 1. 输入框聚焦问题
**问题**: 生产环境下新建日程时无法输入，只能选择预置选项  
**原因**: DOM 渲染时机差异，输入框未就绪  
**修复**: 在 `EventEditModal.vue` 和 `BatchAddModal.vue` 中添加自动聚焦逻辑

```javascript
// 使用 nextTick 确保 DOM 渲染后聚焦
watch(() => props.visible, async (newVal) => {
  if (newVal) {
    await nextTick()
    if (titleInput.value) {
      titleInput.value.focus()
      titleInput.value.select()
    }
  }
}, { immediate: true })
```

### 2. 进程清理不彻底
**问题**: 退出应用后残留 Python 进程  
**原因**: tree-kill 异步执行未等待，子进程逃逸  
**修复**: 同步等待清理完成，添加超时机制和二次清理

```javascript
// 同步清理进程
function killProcessSync(process, processName) {
  return new Promise((resolve) => {
    treeKill(process.pid, 'SIGTERM', (err) => {
      if (process && !process.killed) {
        try { process.kill('SIGKILL') } catch (e) {}
      }
      resolve()
    })
    setTimeout(() => {
      try { process.kill('SIGKILL') } catch (e) {}
      resolve()
    }, 5000)
  })
}

// 应用退出时清理
app.on('will-quit', (event) => {
  event.preventDefault()
  Promise.all([
    killProcessSync(backendProcess, 'Backend'),
    killProcessSync(cpolarProcess, 'Cpolar')
  ]).then(() => {
    cleanupZombieProcesses()
    app.exit(0)
  })
})
```

### 3. 打包图标问题
**问题**: 使用无效的 ICO 文件导致打包失败  
**修复**: 使用 PNG 图标，与开发环境保持一致

```json
{
  "win": {
    "icon": "frontend/public/icons/icon-256x256.png"
  }
}
```

## 修改的文件

- `electron/main.js` - 进程清理逻辑
- `frontend/src/components/EventEditModal.vue` - 自动聚焦
- `frontend/src/components/BatchAddModal.vue` - 自动聚焦
- `package.json` - 打包配置（图标、文件过滤）

## 测试建议

1. **输入框聚焦**: 拖动创建日程，点击输入框应自动聚焦
2. **进程清理**: 退出应用后运行 `tasklist | findstr python` 检查无残留
3. **打包测试**: `npm run electron:build` 生成安装包

## 打包命令

```bash
npm run electron:build
```

输出：
- 安装包：`dist/BUAAer 智能日历 Setup 1.0.0.exe` (~345 MB)
- 便携版：`dist/win-unpacked/BUAAer 智能日历.exe` (~193 MB)
