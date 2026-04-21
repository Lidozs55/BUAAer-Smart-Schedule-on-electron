const { app, BrowserWindow, Tray, Menu, ipcMain, nativeTheme, screen } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')
const treeKill = require('tree-kill')

let mainWindow
let floatWindow
let tray
let backendProcess
let cpolarProcess
let isQuitting = false
let floatWindowVisible = true
let floatWindowOpacity = 0.85

function createWindow() {
  // 根据系统主题选择初始图标
  const isDarkMode = nativeTheme.shouldUseDarkColors
  const iconPath = path.join(__dirname, `../frontend/public/icons/icon-${isDarkMode ? 'dark' : 'light'}-256x256.png`)
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: iconPath,
    titleBarStyle: 'hidden', // 隐藏原生标题栏
    frame: false, // 移除原生边框
    backgroundColor: '#ffffff'
  })

  // 加载应用
  // 开发环境：直接使用 Vite 开发服务器
  // 生产环境：使用打包后的 dist 文件
  const isDev = process.env.NODE_ENV === 'development'
  if (isDev) {
    // 尝试使用 Vite 服务器（更稳定）
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    // 生产环境：加载本地文件
    const indexPath = path.join(__dirname, '../frontend/dist/index.html')
    console.log('Loading production build:', indexPath)
    mainWindow.loadFile(indexPath)
    // 生产环境不打开 DevTools
  }

  mainWindow.on('close', (event) => {
    // 如果不是退出应用，则阻止窗口关闭，最小化到托盘
    if (!isQuitting) {
      event.preventDefault()
      console.log('Window close intercepted - minimizing to tray')
      mainWindow.hide()
      mainWindow.setSkipTaskbar(true)
      // 主窗口关闭时显示悬浮窗
      showFloatWindow()
      console.log('Float window shown:', floatWindowVisible)
    } else {
      console.log('Application quitting, allowing window close')
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  
  // 创建系统托盘
  createTray(iconPath)
  
  // 创建悬浮窗
  createFloatWindow()
  
  // 监听系统主题变化，动态切换图标
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    const newIconPath = path.join(__dirname, `../frontend/public/icons/icon-${isDark ? 'dark' : 'light'}-256x256.png`)
    const newTrayIconPath = path.join(__dirname, `../frontend/public/icons/tray-icon-${isDark ? 'dark' : 'light'}.png`)
    
    // 更新窗口图标
    mainWindow.setIcon(newIconPath)
    
    // 更新托盘图标
    if (tray) {
      tray.setImage(newTrayIconPath)
      tray.setToolTip(`智能日历 for BUAAer (${isDark ? '深色模式' : '浅色模式'})`)
    }
    
    console.log(`Theme updated: ${isDark ? 'Dark Mode' : 'Light Mode'}`)
  })
}

// 创建悬浮窗
function createFloatWindow() {
  const displays = screen.getAllDisplays()
  const primaryDisplay = displays[0]
  const { width, height } = primaryDisplay.workAreaSize
  
  floatWindow = new BrowserWindow({
    width: 280,
    height: 400,
    x: width - 300,
    y: 60,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js')
    }
  })
  
  floatWindow.loadFile(path.join(__dirname, 'float-window.html'))
  floatWindow.setOpacity(floatWindowOpacity)
  floatWindow.setVisibleOnAllWorkspaces(true)
  
  floatWindow.on('closed', () => {
    floatWindow = null
  })
}

// 显示悬浮窗
function showFloatWindow() {
  if (floatWindow && floatWindowVisible) {
    floatWindow.show()
    floatWindow.setAlwaysOnTop(true, 'screen-saver')
  }
}

// 隐藏悬浮窗
function hideFloatWindow() {
  if (floatWindow) {
    floatWindow.hide()
  }
}

// 切换悬浮窗显示状态
function toggleFloatWindow() {
  floatWindowVisible = !floatWindowVisible
  if (floatWindowVisible) {
    showFloatWindow()
  } else {
    hideFloatWindow()
  }
}

// 设置悬浮窗透明度
function setFloatWindowOpacity(opacity) {
  floatWindowOpacity = opacity
  if (floatWindow) {
    floatWindow.setOpacity(opacity)
    floatWindow.webContents.send('update-opacity', opacity)
  }
}

// 创建系统托盘
function createTray(iconPath) {
  // 根据系统主题选择合适的图标
  const isDarkMode = nativeTheme.shouldUseDarkColors
  const trayIconPath = path.join(__dirname, `../frontend/public/icons/tray-icon-${isDarkMode ? 'dark' : 'light'}.png`)
  
  tray = new Tray(trayIconPath)
  
  // 创建托盘菜单
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        showWindow()
      }
    },
    {
      label: '悬浮窗',
      submenu: [
        {
          label: floatWindowVisible ? '隐藏悬浮窗' : '显示悬浮窗',
          click: () => {
            toggleFloatWindow()
            updateTrayMenu()
          }
        },
        {
          label: '透明度 85%',
          click: () => setFloatWindowOpacity(0.85)
        },
        {
          label: '透明度 70%',
          click: () => setFloatWindowOpacity(0.70)
        },
        {
          label: '透明度 50%',
          click: () => setFloatWindowOpacity(0.50)
        }
      ]
    },
    {
      label: '退出应用',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  
  tray.setToolTip(`智能日历 for BUAAer (${isDarkMode ? '深色模式' : '浅色模式'})`)
  tray.setContextMenu(contextMenu)
  
  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    showWindow()
  })
}

// 更新托盘菜单
function updateTrayMenu() {
  if (!tray) return
  
  const isDarkMode = nativeTheme.shouldUseDarkColors
  const trayIconPath = path.join(__dirname, `../frontend/public/icons/tray-icon-${isDarkMode ? 'dark' : 'light'}.png`)
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        showWindow()
      }
    },
    {
      label: '悬浮窗',
      submenu: [
        {
          label: floatWindowVisible ? '隐藏悬浮窗' : '显示悬浮窗',
          click: () => {
            toggleFloatWindow()
            updateTrayMenu()
          }
        },
        {
          label: '透明度 85%',
          click: () => setFloatWindowOpacity(0.85)
        },
        {
          label: '透明度 70%',
          click: () => setFloatWindowOpacity(0.70)
        },
        {
          label: '透明度 50%',
          click: () => setFloatWindowOpacity(0.50)
        }
      ]
    },
    {
      label: '退出应用',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  
  tray.setContextMenu(contextMenu)
}

// 显示窗口
function showWindow() {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.setSkipTaskbar(false)
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
    // 主窗口打开时隐藏悬浮窗
    hideFloatWindow()
  }
}

// 启动后端 Flask 服务
function startBackend() {
  // 判断是否为开发环境
  const isDev = process.env.NODE_ENV === 'development'
  
  if (isDev) {
    // 开发环境：使用 Python 脚本
    const backendPath = path.join(__dirname, '../backend')
    const pythonScript = path.join(backendPath, 'app.py')
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3'
    
    backendProcess = spawn(pythonCommand, [pythonScript], {
      cwd: backendPath,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    })
    
    console.log('Starting backend in development mode...')
  } else {
    // 生产环境：使用 Nuitka 打包的可执行文件
    // Nuitka 相比 PyInstaller 的优势：
    // 1. 更小的打包体积（通常减少 30-50%）
    // 2. 更好的运行时性能（编译为 C 代码）
    // 3. 更好的依赖管理
    const backendExe = path.join(process.resourcesPath, 'backend', 'backend_server.exe')
    
    backendProcess = spawn(backendExe, [], {
      cwd: path.join(process.resourcesPath, 'backend'),
      env: { ...process.env }
    })
    
    console.log('Starting backend in production mode...')
    console.log('Backend executable:', backendExe)
  }

  backendProcess.stdout.on('data', (data) => {
    console.log(`Backend: ${data}`)
  })

  backendProcess.stderr.on('data', (data) => {
    console.error(`Backend Error: ${data}`)
  })

  backendProcess.on('close', (code) => {
    console.log(`Backend process exited with code ${code}`)
  })
}

// 启动 cpolar 内网穿透服务
function startCpolar() {
  const cpolarPath = path.join(__dirname, '../cpolar/cpolar.exe')
  
  // 检查 cpolar 是否存在
  if (process.platform !== 'win32' || !fs.existsSync(cpolarPath)) {
    console.log('Cpolar not available on this platform or not found')
    return null
  }
  
  console.log('Starting cpolar tunnel...')
  
  cpolarProcess = spawn(cpolarPath, ['http', '5000'], {
    cwd: path.join(__dirname, '../cpolar'),
    detached: false
  })

  cpolarProcess.stdout.on('data', (data) => {
    console.log(`Cpolar: ${data}`)
  })

  cpolarProcess.stderr.on('data', (data) => {
    console.error(`Cpolar Error: ${data}`)
  })

  cpolarProcess.on('close', (code) => {
    console.log(`Cpolar process exited with code ${code}`)
  })
  
  return cpolarProcess
}

// 等待后端服务就绪
function waitForBackend() {
  return new Promise((resolve, reject) => {
    const maxAttempts = 30
    let attempts = 0
    
    const checkBackend = async () => {
      try {
        const axios = require('axios')
        await axios.get('http://127.0.0.1:5000/api/health', { timeout: 1000 })
        resolve()
      } catch (error) {
        attempts++
        if (attempts >= maxAttempts) {
          reject(new Error('Backend service failed to start'))
        } else {
          setTimeout(checkBackend, 1000)
        }
      }
    }
    
    checkBackend()
  })
}

app.whenReady().then(async () => {
  // 启动后端服务
  startBackend()
  
  try {
    // 等待后端服务就绪
    await waitForBackend()
    console.log('Backend service is ready')
    
    // 后端启动成功后，启动 cpolar
    startCpolar()
  } catch (error) {
    console.error('Failed to start backend:', error)
  }
  
  createWindow()
})

app.on('window-all-closed', () => {
  // 当所有窗口都关闭时，但不一定是用户要退出应用
  // 只有在用户主动选择退出时才真正退出
  if (process.platform !== 'darwin') {
    // Windows 和 Linux 上，如果是最小化到托盘，不要退出应用
    if (isQuitting) {
      app.quit()
    }
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// 同步清理进程的辅助函数
function killProcessSync(process, processName) {
  return new Promise((resolve) => {
    if (!process) {
      resolve()
      return
    }
    
    treeKill(process.pid, 'SIGTERM', (err) => {
      if (err) console.error(`Failed to kill ${processName}:`, err)
      
      // 强制终止确保清理
      if (process && !process.killed) {
        try { process.kill('SIGKILL') } catch (e) {}
      }
      resolve()
    })
    
    // 5 秒超时强制终止
    setTimeout(() => {
      try { process.kill('SIGKILL') } catch (e) {}
      resolve()
    }, 5000)
  })
}

// 清理残留的 Python 进程
function cleanupZombieProcesses() {
  const { exec } = require('child_process')
  if (process.platform === 'win32') {
    exec('taskkill /F /IM python.exe /T 2>nul')
  } else {
    exec('pkill -9 -f "backend_server|python.*app.py" 2>/dev/null')
  }
}

// 处理应用退出
app.on('will-quit', (event) => {
  event.preventDefault()
  
  Promise.all([
    killProcessSync(backendProcess, 'Backend'),
    killProcessSync(cpolarProcess, 'Cpolar')
  ]).then(() => {
    if (tray) tray.destroy()
    cleanupZombieProcesses()
    app.exit(0)
  }).catch(() => {
    app.exit(1)
  })
})

// IPC 通信处理
ipcMain.handle('get-backend-url', () => {
  return 'http://127.0.0.1:5000'
})

// 获取 cpolar 状态
ipcMain.handle('get-cpolar-status', () => {
  return {
    running: cpolarProcess !== null && !cpolarProcess.killed,
    platform: process.platform
  }
})

// 最小化到系统托盘
ipcMain.handle('minimize-to-tray', () => {
  if (mainWindow) {
    mainWindow.hide()
    mainWindow.setSkipTaskbar(true)
  }
})

// 退出应用
ipcMain.handle('quit-app', () => {
  isQuitting = true
  app.quit()
})

// 显示窗口
ipcMain.handle('show-window', () => {
  showWindow()
})

// 窗口控制
ipcMain.handle('minimize-window', () => {
  if (mainWindow) {
    mainWindow.minimize()
  }
})

ipcMain.handle('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

ipcMain.handle('close-window', () => {
  if (mainWindow) {
    mainWindow.close()
  }
})

// 获取窗口最大化状态
ipcMain.handle('is-window-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false
})

// 悬浮窗控制
ipcMain.handle('toggle-float-window', () => {
  toggleFloatWindow()
  updateTrayMenu()
})

ipcMain.handle('show-float-window', () => {
  floatWindowVisible = true
  showFloatWindow()
  updateTrayMenu()
})

ipcMain.handle('hide-float-window', () => {
  floatWindowVisible = false
  hideFloatWindow()
  updateTrayMenu()
})

ipcMain.handle('set-float-window-opacity', (event, opacity) => {
  setFloatWindowOpacity(opacity)
})
