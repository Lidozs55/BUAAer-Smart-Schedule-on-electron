#!/usr/bin/env node
/**
 * 构建优化验证脚本
 * 用于检查打包后的文件大小和组成
 */

const fs = require('fs');
const path = require('path');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// 递归计算目录大小
function getDirectorySize(dirPath) {
  let totalSize = 0;
  
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  
  const files = fs.readdirSync(dirPath);
  
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    
    try {
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        totalSize += getDirectorySize(filePath);
      } else {
        totalSize += stats.size;
      }
    } catch (error) {
      // 忽略无法访问的文件
    }
  }
  
  return totalSize;
}

// 分析目录结构
function analyzeDirectory(dirPath, options = {}) {
  const { maxDepth = 3, minSize = 1024 * 1024 } = options; // 默认显示 >1MB 的文件/目录
  
  const results = [];
  
  function scan(dir, depth = 0) {
    if (depth > maxDepth) return;
    
    if (!fs.existsSync(dir)) return;
    
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      if (file.startsWith('.')) continue; // 跳过隐藏文件
      
      const filePath = path.join(dir, file);
      
      try {
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory()) {
          const dirSize = getDirectorySize(filePath);
          if (dirSize >= minSize) {
            results.push({
              path: filePath,
              size: dirSize,
              type: 'directory'
            });
          }
          scan(filePath, depth + 1);
        } else {
          if (stats.size >= minSize) {
            results.push({
              path: filePath,
              size: stats.size,
              type: 'file'
            });
          }
        }
      } catch (error) {
        // 忽略错误
      }
    }
  }
  
  scan(dirPath);
  return results.sort((a, b) => b.size - a.size);
}

// 主函数
function main() {
  log('\n========================================', 'cyan');
  log('   构建优化验证工具', 'cyan');
  log('========================================\n', 'cyan');
  
  const projectRoot = path.join(__dirname);
  const distDir = path.join(projectRoot, 'dist');
  const backendDistDir = path.join(projectRoot, 'backend', 'dist');
  const frontendDistDir = path.join(projectRoot, 'frontend', 'dist');
  
  // 检查各个目录
  log('📦 检查构建产物...\n', 'yellow');
  
  const directories = [
    { name: 'Electron 打包输出', path: distDir },
    { name: 'Python 后端打包', path: backendDistDir },
    { name: '前端构建输出', path: frontendDistDir }
  ];
  
  directories.forEach(({ name, path: dirPath }) => {
    if (fs.existsSync(dirPath)) {
      const size = getDirectorySize(dirPath);
      log(`✓ ${name}: ${formatFileSize(size)}`, 'green');
    } else {
      log(`✗ ${name}: 目录不存在`, 'red');
    }
  });
  
  // 分析最大的文件/目录
  log('\n📊 分析最大的文件/目录（>1MB）...\n', 'yellow');
  
  if (fs.existsSync(distDir)) {
    log('Electron 打包输出目录分析:', 'cyan');
    const results = analyzeDirectory(distDir);
    
    if (results.length === 0) {
      log('  没有找到大于 1MB 的文件/目录', 'yellow');
    } else {
      results.slice(0, 10).forEach((item, index) => {
        const size = formatFileSize(item.size);
        const relativePath = path.relative(projectRoot, item.path);
        log(`  ${index + 1}. ${relativePath} (${size})`, item.type === 'directory' ? 'blue' : 'reset');
      });
    }
  }
  
  if (fs.existsSync(backendDistDir)) {
    log('\nPython 后端打包目录分析:', 'cyan');
    const results = analyzeDirectory(backendDistDir);
    
    if (results.length === 0) {
      log('  没有找到大于 1MB 的文件/目录', 'yellow');
    } else {
      results.slice(0, 10).forEach((item, index) => {
        const size = formatFileSize(item.size);
        const relativePath = path.relative(projectRoot, item.path);
        log(`  ${index + 1}. ${relativePath} (${size})`, item.type === 'directory' ? 'blue' : 'reset');
      });
    }
  }
  
  // 检查 .map 文件
  log('\n🔍 检查 .map 文件...\n', 'yellow');
  
  function findMapFiles(dir, found = []) {
    if (!fs.existsSync(dir)) return found;
    
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          findMapFiles(filePath, found);
        } else if (file.endsWith('.map')) {
          found.push(filePath);
        }
      } catch (error) {
        // 忽略
      }
    }
    return found;
  }
  
  const mapFiles = findMapFiles(distDir);
  if (mapFiles.length > 0) {
    log(`⚠  发现 ${mapFiles.length} 个 .map 文件:`, 'yellow');
    mapFiles.forEach(f => log(`  - ${path.relative(projectRoot, f)}`, 'yellow'));
  } else {
    log('✓ 未发现 .map 文件（已正确排除）', 'green');
  }
  
  // 总结
  log('\n========================================', 'cyan');
  log('   验证完成', 'cyan');
  log('========================================\n', 'cyan');
  
  log('💡 优化建议:', 'cyan');
  log('1. 检查 node_modules 是否包含不必要的开发依赖', 'blue');
  log('2. 确认 Python 后端已使用 Nuitka 打包', 'blue');
  log('3. 检查图片资源是否已优化', 'blue');
  log('4. 考虑使用 WebP 格式替代 PNG', 'blue');
  log('5. 检查是否有可以懒加载的组件\n', 'blue');
}

// 运行
main();
