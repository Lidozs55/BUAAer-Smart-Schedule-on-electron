/**
 * 进程清理测试脚本
 * 
 * 用于测试应用退出时进程是否被正确清理
 */

const { spawn } = require('child_process')
const path = require('path')

console.log('🔍 进程清理测试脚本\n')

// 测试 1: 检查是否有残留的 Python 进程
function checkZombieProcesses() {
  return new Promise((resolve) => {
    const { exec } = require('child_process')
    
    if (process.platform === 'win32') {
      exec('tasklist /FI "IMAGENAME eq python.exe" /NH', (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        
        const lines = stdout.trim().split('\n').filter(line => line.trim())
        resolve(lines)
      })
    } else {
      exec('ps aux | grep -E "python|backend_server" | grep -v grep', (err, stdout) => {
        if (err) {
          resolve([])
          return
        }
        
        const lines = stdout.trim().split('\n').filter(line => line.trim())
        resolve(lines)
      })
    }
  })
}

// 测试 2: 模拟启动和清理进程
async function testProcessCleanup() {
  console.log('📝 测试步骤:\n')
  console.log('1. 检查当前是否有残留的 Python 进程...\n')
  
  const zombieProcesses = await checkZombieProcesses()
  
  if (zombieProcesses.length > 0) {
    console.log('⚠️  发现残留的 Python 进程:')
    zombieProcesses.forEach(line => console.log(`   ${line}`))
    console.log('\n建议：在打包的应用中测试退出功能，确保进程被正确清理\n')
  } else {
    console.log('✅ 未发现残留的 Python 进程\n')
  }
  
  console.log('2. 进程清理逻辑说明:\n')
  console.log('   - 使用 tree-kill 杀死整个进程树 (PID + 所有子进程)')
  console.log('   - 设置 5 秒超时，超时后强制终止')
  console.log('   - 额外使用 taskkill/pkill 清理可能的僵尸进程')
  console.log('   - 等待所有清理完成后再退出应用\n')
  
  console.log('3. 测试方法:\n')
  console.log('   a) 运行打包后的应用: dist/win-unpacked/BUAAer 智能日历.exe')
  console.log('   b) 正常使用应用（创建日程、使用后端功能等）')
  console.log('   c) 退出应用（点击托盘菜单的"退出"或关闭所有窗口）')
  console.log('   d) 立即运行此脚本检查是否有进程残留:')
  console.log('      node test-process-cleanup.js\n')
  console.log('   e) 如果仍有残留，查看应用日志中的清理信息\n')
  
  console.log('4. 预期日志输出:\n')
  console.log('   Application is quitting, cleaning up processes...')
  console.log('   Starting to kill Backend process tree (PID: xxxxx)...')
  console.log('   Starting to kill Cpolar process tree (PID: xxxxx)...')
  console.log('   Backend process tree killed successfully')
  console.log('   Cpolar process tree killed successfully')
  console.log('   All processes cleaned up, exiting application...')
  console.log('   Cleaned up zombie Python processes\n')
}

// 运行测试
testProcessCleanup()
