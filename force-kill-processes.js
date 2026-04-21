/**
 * 强制清理进程脚本
 * 
 * 用于手动清理残留的后端和 cpolar 进程
 * 在应用异常退出或自动清理失败时使用
 */

const { exec } = require('child_process')

console.log('🔧 开始清理残留进程...\n')

function killProcessByPID(pid, name) {
  return new Promise((resolve) => {
    console.log(`正在清理 ${name} (PID: ${pid})...`)
    
    if (process.platform === 'win32') {
      exec(`taskkill /F /PID ${pid} /T`, (err, stdout, stderr) => {
        if (!err) {
          console.log(`✅ ${name} 已清理`)
          resolve(true)
        } else {
          console.log(`❌ ${name} 清理失败:`, stderr.trim())
          resolve(false)
        }
      })
    } else {
      exec(`kill -9 ${pid}`, (err) => {
        if (!err) {
          console.log(`✅ ${name} 已清理`)
          resolve(true)
        } else {
          console.log(`❌ ${name} 清理失败`)
          resolve(false)
        }
      })
    }
  })
}

function findAndKillProcesses() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Windows: 查找所有相关的进程
      exec('tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH', (err, stdout) => {
        if (err) {
          resolve()
          return
        }
        
        const lines = stdout.trim().split('\n')
        const pythonPids = []
        
        lines.forEach(line => {
          const parts = line.split(',')
          if (parts.length >= 2) {
            const pid = parseInt(parts[1].replace(/"/g, ''))
            if (!isNaN(pid)) {
              pythonPids.push(pid)
            }
          }
        })
        
        if (pythonPids.length > 0) {
          console.log(`发现 ${pythonPids.length} 个 Python 进程:`)
          pythonPids.forEach(pid => console.log(`  - PID: ${pid}`))
          console.log('')
          
          // 清理所有 Python 进程
          Promise.all(pythonPids.map(pid => killProcessByPID(pid, `Python(${pid})`)))
            .then(() => resolve())
        } else {
          console.log('✅ 未发现残留的 Python 进程\n')
          resolve()
        }
      })
    } else {
      // Linux/Mac
      exec('ps aux | grep -E "python|backend_server|cpolar" | grep -v grep', (err, stdout) => {
        if (err) {
          resolve()
          return
        }
        
        const lines = stdout.trim().split('\n')
        if (lines.length > 0 && lines[0]) {
          console.log(`发现 ${lines.length} 个相关进程:`)
          lines.forEach(line => console.log(`  ${line}`))
          console.log('')
          
          const pids = lines.map(line => {
            const parts = line.trim().split(/\s+/)
            return parseInt(parts[1])
          }).filter(pid => !isNaN(pid))
          
          Promise.all(pids.map(pid => killProcessByPID(pid, `Process(${pid})`)))
            .then(() => resolve())
        } else {
          console.log('✅ 未发现残留进程\n')
          resolve()
        }
      })
    }
  })
}

// 运行清理
findAndKillProcesses().then(() => {
  console.log('✅ 进程清理完成\n')
})
