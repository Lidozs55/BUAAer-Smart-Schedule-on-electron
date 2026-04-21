const { contextBridge, ipcRenderer } = require('electron')

// 暴露后端 API
contextBridge.exposeInMainWorld('electron', {
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url')
})

// 暴露窗口控制 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 最小化窗口
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  // 最大化/还原窗口
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  // 关闭窗口
  closeWindow: () => ipcRenderer.invoke('close-window'),
  // 获取窗口最大化状态
  isWindowMaximized: () => ipcRenderer.invoke('is-window-maximized'),
  // 最小化到托盘
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  // 退出应用
  quitApp: () => ipcRenderer.invoke('quit-app'),
  // 显示窗口
  showWindow: () => ipcRenderer.invoke('show-window'),
  // 悬浮窗控制
  toggleFloatWindow: () => ipcRenderer.invoke('toggle-float-window'),
  showFloatWindow: () => ipcRenderer.invoke('show-float-window'),
  hideFloatWindow: () => ipcRenderer.invoke('hide-float-window'),
  setFloatWindowOpacity: (opacity) => ipcRenderer.invoke('set-float-window-opacity', opacity)
})
