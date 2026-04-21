const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

console.log('🚀 开始打包 BUAAer 智能日历应用...\n')

// 项目根目录
const ROOT_DIR = __dirname
const BACKEND_DIR = path.join(ROOT_DIR, 'backend')
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend')
const DIST_DIR = path.join(ROOT_DIR, 'dist')

// 步骤 1: 构建前端
console.log('📦 步骤 1: 构建前端...')
try {
  execSync('npm run build:frontend', { 
    cwd: ROOT_DIR, 
    stdio: 'inherit' 
  })
  console.log('✅ 前端构建完成\n')
} catch (error) {
  console.error('❌ 前端构建失败')
  process.exit(1)
}

// 步骤 2: 使用 PyInstaller 打包后端
console.log('🐍 步骤 2: 打包 Python 后端...')
try {
  // 检查是否安装了 PyInstaller
  try {
    execSync('pyinstaller --version', { stdio: 'ignore' })
  } catch (error) {
    console.log('正在安装 PyInstaller...')
    execSync('pip install pyinstaller', { stdio: 'inherit' })
  }
  
  // 确保安装了所有 Python 依赖
  console.log('正在安装 Python 依赖...')
  execSync('pip install -r requirements.txt', {
    cwd: BACKEND_DIR,
    stdio: 'inherit'
  })
  
  // 创建 PyInstaller 配置文件
  const specContent = `# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('routes', 'routes'),
        ('services', 'services'),
        ('config.py', 'config.py'),
    ],
    hiddenimports=[
        'flask',
        'flask_cors',
        'flask_sqlalchemy',
        'dotenv',
        'dashscope',
        'openai',
        'requests',
        'sqlalchemy',
        'PIL',
        'easyocr',
        'qrcode',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='backend_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # 不显示控制台窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
`
  
  const specPath = path.join(BACKEND_DIR, 'backend.spec')
  fs.writeFileSync(specPath, specContent)
  
  console.log('正在编译后端可执行文件（这可能需要几分钟）...')
  execSync('pyinstaller --clean backend.spec', {
    cwd: BACKEND_DIR,
    stdio: 'inherit'
  })
  
  // 复制后端可执行文件到打包目录
  const backendExe = path.join(BACKEND_DIR, 'dist', 'backend_server.exe')
  const backendDist = path.join(DIST_DIR, 'win-unpacked', 'resources', 'backend')
  
  if (!fs.existsSync(backendDist)) {
    fs.mkdirSync(backendDist, { recursive: true })
  }
  
  if (fs.existsSync(backendExe)) {
    fs.copyFileSync(backendExe, path.join(backendDist, 'backend_server.exe'))
    
    // 复制 .env 文件（如果存在）
    const envSrc = path.join(BACKEND_DIR, '.env')
    const envDest = path.join(backendDist, '.env')
    if (fs.existsSync(envSrc)) {
      fs.copyFileSync(envSrc, envDest)
      console.log('✅ 已复制 .env 配置文件')
    }
    
    console.log('✅ 后端打包完成\n')
  } else {
    console.error('❌ 后端可执行文件未找到')
    process.exit(1)
  }
  
} catch (error) {
  console.error('❌ 后端打包失败')
  console.error(error.message)
  process.exit(1)
}

// 步骤 3: 使用 electron-builder 打包
console.log('⚡ 步骤 3: 打包 Electron 应用...')
try {
  execSync('npx electron-builder --win --x64', {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  })
  console.log('✅ Electron 打包完成\n')
} catch (error) {
  console.error('❌ Electron 打包失败')
  process.exit(1)
}

console.log('🎉 打包完成！')
console.log(`📦 安装包位置：${path.join(DIST_DIR)}`)
console.log('\n安装程序文件：')
console.log('  - BUAAer 智能日历 Setup X.X.X.exe (NSIS 安装程序)')
console.log('\n这个安装包可以在任何 Windows 电脑上运行，无需安装 Python！')
