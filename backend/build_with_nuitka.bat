# Nuitka 打包配置文件
# 用于替代 PyInstaller，提供更小的打包体积和更好的性能

# 基本用法：
# python -m nuitka --module --follow-imports --onefile app.py --output-file=backend_server.exe

# 推荐的 Nuitka 打包命令（Windows）：
# python -m nuitka ^
#   --module ^
#   --follow-imports ^
#   --follow-imports-to=flask ^
#   --follow-imports-to=sqlalchemy ^
#   --python-flag=no_site ^
#   --standalone ^
#   --onefile ^
#   --enable-plugin=pylint-warnings ^
#   --disable-console ^
#   --assume-yes-for-downloads ^
#   --output-dir=dist ^
#   --output-file=backend_server.exe ^
#   app.py

# 或者使用更激进的优化选项：
# python -m nuitka ^
#   --module ^
#   --follow-imports ^
#   --python-flag=no_site ^
#   --standalone ^
#   --onefile ^
#   --disable-console ^
#   --output-dir=dist ^
#   --output-file=backend_server.exe ^
#   --include-package=flask ^
#   --include-package=flask_sqlalchemy ^
#   --include-package=flask_cors ^
#   --include-package=python_dotenv ^
#   --include-package=requests ^
#   --include-package=sqlalchemy ^
#   --include-package=openai ^
#   --include-package=easyocr ^
#   --include-package=PIL ^
#   --include-package=dashscope ^
#   --include-package=qrcode ^
#   --exclude-module=test ^
#   --exclude-module=unittest ^
#   --exclude-module=pip ^
#   --exclude-module=setuptools ^
#   app.py

# 环境变量文件处理：
# .env 文件需要单独复制到 dist 目录，或者使用 --include-data-files 选项
# --include-data-files=../.env=.env

# 性能优化选项：
# --optimize=O2    # 启用优化级别 2
# --lto=yes        # 启用链接时优化（需要额外安装）

# 调试选项（开发时使用）：
# --debug          # 启用调试模式
# --show-progress  # 显示打包进度
# --show-memory    # 显示内存使用情况

# 完整命令示例：
python -m nuitka ^
  --module ^
  --follow-imports ^
  --python-flag=no_site ^
  --standalone ^
  --onefile ^
  --disable-console ^
  --output-dir=dist ^
  --output-file=backend_server.exe ^
  --include-package=flask ^
  --include-package=flask_sqlalchemy ^
  --include-package=flask_cors ^
  --include-package=python_dotenv ^
  --include-package=requests ^
  --include-package=sqlalchemy ^
  --include-package=openai ^
  --include-package=easyocr ^
  --include-package=PIL ^
  --include-package=dashscope ^
  --include-package=qrcode ^
  --exclude-module=test ^
  --exclude-module=unittest ^
  --exclude-module=pip ^
  --exclude-module=setuptools ^
  --exclude-module=pydoc ^
  --exclude-module=doctest ^
  --assume-yes-for-downloads ^
  --jobs=4 ^
  app.py
