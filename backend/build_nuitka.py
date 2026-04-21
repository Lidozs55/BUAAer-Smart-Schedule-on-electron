#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Nuitka 打包脚本
使用方法：python build_nuitka.py
"""

import os
import sys
import subprocess
from pathlib import Path

# 获取当前脚本所在目录
BACKEND_DIR = Path(__file__).parent
DIST_DIR = BACKEND_DIR / "dist"

# 确保 dist 目录存在
DIST_DIR.mkdir(exist_ok=True)

# Nuitka 打包命令（Nuitka 4.0+ 语法）
# 生成独立可执行文件（不使用 --module，因为与 --standalone --onefile 冲突）
nuitka_cmd = [
    sys.executable, "-m", "nuitka",
    "--follow-imports",
    "--standalone",
    "--onefile",
    "--windows-console-mode=disable",  # Nuitka 4.0+ 新语法
    f"--output-dir={DIST_DIR}",
    f"--output-file=backend_server.exe",
    # 包含必要的包
    "--include-package=flask",
    "--include-package=flask_sqlalchemy",
    "--include-package=flask_cors",
    "--include-package=dotenv",
    "--include-package=requests",
    "--include-package=sqlalchemy",
    "--include-package=openai",
    "--include-package=easyocr",
    "--include-package=PIL",
    "--include-package=dashscope",
    "--include-package=qrcode",
    # 排除不必要的模块（Nuitka 4.0+ 使用 --nofollow-import-to 排除特定模块）
    "--nofollow-import-to=test",
    "--nofollow-import-to=unittest",
    "--nofollow-import-to=pip",
    "--nofollow-import-to=setuptools",
    "--nofollow-import-to=pydoc",
    "--nofollow-import-to=doctest",
    # 优化选项
    "--assume-yes-for-downloads",
    "--jobs=4",  # 使用 4 个并行任务
]

# 如果需要更激进的优化，可以添加以下选项：
# "--optimize=O2",  # 启用优化级别 2
# "--lto=yes",      # 启用链接时优化（需要额外安装）

# 如果需要包含 .env 文件：
# "--include-data-files", str(BACKEND_DIR / ".env") + "=backend/.env",

print("=" * 60)
print("开始使用 Nuitka 打包 Python 后端...")
print("=" * 60)
print(f"后端目录：{BACKEND_DIR}")
print(f"输出目录：{DIST_DIR}")
print("=" * 60)

try:
    # 检查 Nuitka 是否已安装
    result = subprocess.run([sys.executable, "-m", "nuitka", "--version"], 
                          capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print("错误：Nuitka 未安装，请先安装：pip install nuitka")
        sys.exit(1)
    print(f"Nuitka 版本：{result.stdout.strip()}")
    print("=" * 60)
    
    # 执行打包
    print("正在打包，请稍候...")
    print("=" * 60)
    
    result = subprocess.run(
        nuitka_cmd + [str(BACKEND_DIR / "app.py")],
        cwd=str(BACKEND_DIR),
        check=False
    )
    
    if result.returncode == 0:
        print("=" * 60)
        print("✓ 打包成功！")
        print(f"输出文件：{DIST_DIR / 'backend_server.exe'}")
        print("=" * 60)
        
        # 检查生成的文件大小
        exe_file = DIST_DIR / "backend_server.exe"
        if exe_file.exists():
            file_size = exe_file.stat().st_size
            print(f"文件大小：{file_size / (1024 * 1024):.2f} MB")
            print("=" * 60)
    else:
        print("=" * 60)
        print("✗ 打包失败，请检查错误信息")
        print("=" * 60)
        sys.exit(1)
        
except subprocess.CalledProcessError as e:
    print("=" * 60)
    print(f"✗ 打包过程出错：{e}")
    print("=" * 60)
    sys.exit(1)
except Exception as e:
    print("=" * 60)
    print(f"✗ 发生错误：{e}")
    print("=" * 60)
    sys.exit(1)
