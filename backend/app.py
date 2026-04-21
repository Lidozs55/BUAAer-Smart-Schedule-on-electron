from flask import Flask, send_from_directory, render_template_string, jsonify
from flask_cors import CORS
import os
import pathlib
import subprocess
import platform

# 设置当前工作目录
current_dir = pathlib.Path(__file__).parent
main_dir = current_dir.parent
os.chdir(str(current_dir))

# 确保 config 模块可以被导入
import sys
sys.path.append(str(current_dir))

# 现在导入本地模块
from config import Config
from extensions import db

# 后端服务端口配置
BACKEND_PORT = 5000  # Flask 后端服务端口


def start_cpolar_service():
    """
    启动 cpolar 隧道服务
    """
    try:
        # 首先检查并杀死已存在的 cpolar 进程，防止并发会话数超过限制
        if platform.system() == 'Windows':
            # Windows 系统，使用 taskkill 命令杀死 cpolar 进程
            subprocess.run(['taskkill', '/f', '/im', 'cpolar.exe'], capture_output=True, text=True)
            print("[CPolar] 已检查并杀死所有已存在的 cpolar 进程")
        else:
            # Linux/Mac 系统，使用 pkill 命令杀死 cpolar 进程
            subprocess.run(['pkill', '-f', 'cpolar'], capture_output=True, text=True)
            print("[CPolar] 已检查并杀死所有已存在的 cpolar 进程")
        
        # 明确指定使用主文件夹下面的/cpolar/cpolar.exe 路径
        if platform.system() == 'Windows':
            # Windows 系统，使用主文件夹下的 cpolar/cpolar.exe
            cpolar_path = os.path.join(main_dir, 'cpolar', 'cpolar.exe')
        else:
            # Linux/Mac 系统，使用主文件夹下的 cpolar/cpolar
            cpolar_path = os.path.join(main_dir, 'cpolar', 'cpolar')
        
        # 检查 cpolar 是否存在
        if os.path.exists(cpolar_path):
            # 检查是否有执行权限
            if platform.system() == 'Windows' or os.access(cpolar_path, os.X_OK):
                # 启动 cpolar 服务，使用正确的命令：cpolar http 5000
                # 在后台运行，不打开新窗口，避免乱码
                if platform.system() == 'Windows':
                    # Windows 系统，使用 DETACHED_PROCESS 标志在后台运行
                    subprocess.Popen(
                        [cpolar_path, 'http', str(BACKEND_PORT)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        stdin=subprocess.DEVNULL,
                        creationflags=subprocess.DETACHED_PROCESS,
                        cwd=str(current_dir)
                    )
                else:
                    # Linux/Mac 系统，使用后台运行
                    subprocess.Popen(
                        [cpolar_path, 'http', str(BACKEND_PORT)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        stdin=subprocess.DEVNULL,
                        start_new_session=True,
                        cwd=str(current_dir)
                    )
                print(f"[CPolar] 已在后台启动 cpolar 服务")
                print(f"[CPolar] 使用路径：{cpolar_path}")
                print(f"[CPolar] 启动命令：cpolar http {BACKEND_PORT}")
            else:
                print(f"[CPolar] 没有 cpolar 的执行权限：{cpolar_path}")
        else:
            print(f"[CPolar] 未找到 cpolar 可执行文件：{cpolar_path}")
            print(f"[CPolar] 您可以手动启动：cpolar http 5000")
    except Exception as e:
        print(f"[CPolar] 启动 cpolar 服务失败：{str(e)}")


def create_app(config_class=Config):
    """创建Flask应用实例"""
    app = Flask(__name__)
    app.config.from_object(config_class)
    
    # 确保instance目录存在
    os.makedirs(app.instance_path, exist_ok=True)
    
    # 初始化扩展
    db.init_app(app)
    CORS(app, supports_credentials=True)  # 允许跨域请求并支持credentials
    
    # 注册蓝图
    from routes.auth import auth_bp
    from routes.courses import courses_bp
    from routes.tasks import tasks_bp
    from routes.llm import llm_bp
    from routes.schedule import schedule_bp
    from routes.entries import entries_bp
    from routes.settings import settings_bp
    from routes.reminders import reminders_bp
    
    app.register_blueprint(auth_bp, url_prefix='/api/auth')
    app.register_blueprint(courses_bp, url_prefix='/api/courses')
    app.register_blueprint(entries_bp, url_prefix='/api/entries')
    app.register_blueprint(tasks_bp, url_prefix='/api/tasks')
    app.register_blueprint(llm_bp, url_prefix='/api/llm')
    app.register_blueprint(schedule_bp, url_prefix='/api/schedule')
    app.register_blueprint(settings_bp, url_prefix='/api/settings')
    app.register_blueprint(reminders_bp, url_prefix='/api/reminders')
    
    # 确保 instance 目录存在
    instance_dir = os.path.join(app.root_path, 'instance')
    if not os.path.exists(instance_dir):
        os.makedirs(instance_dir)
    
    # 创建数据库表
    with app.app_context():
        db.create_all()
    
    # 启动cpolar服务（异步，不阻塞其他初始化）
    import threading
    cpolar_thread = threading.Thread(target=start_cpolar_service)
    cpolar_thread.daemon = True
    cpolar_thread.start()
    
    # 立即启动cpolar域名自动刷新线程（它会自己处理延迟）
    from utils.qr_code import QRCodeGenerator
    QRCodeGenerator.start_cpolar_refresh()
    
    # 配置静态文件服务
    # 检查是否运行在 PyInstaller 打包的 exe 环境中
    import sys
    if hasattr(sys, '_MEIPASS'):
        # 打包为 exe 时，使用 sys._MEIPASS 作为基础路径
        meipass_path = sys._MEIPASS
        frontend_dist = pathlib.Path(meipass_path) / 'frontend' / 'dist'
        public_path = pathlib.Path(meipass_path) / 'frontend' / 'public'
    else:
        # 开发环境下，使用实际文件系统路径
        frontend_dist = current_dir.parent / 'frontend' / 'dist'
        public_path = current_dir.parent / 'frontend' / 'public'
    
    # 开发模式下代理到 Vite
    import requests as req
    VITE_SERVER = 'http://localhost:5173'
    
    # 静态文件路由
    @app.route('/assets/<path:filename>')
    def serve_assets(filename):
        # 开发模式下代理到 Vite
        if not hasattr(sys, '_MEIPASS'):
            try:
                resp = req.get(f'{VITE_SERVER}/assets/{filename}', timeout=5)
                return resp.content, resp.status_code, resp.headers.items()
            except:
                pass  # 如果 Vite 不可用，回退到本地文件
        return send_from_directory(str(frontend_dist / 'assets'), filename)
    
    # 声音文件路由
    @app.route('/sound/<path:filename>')
    def serve_sounds(filename):
        return send_from_directory(str(public_path / 'sound'), filename)
    
    # SVG文件路由
    @app.route('/svg/<path:filename>')
    def serve_svgs(filename):
        return send_from_directory(str(public_path / 'svg'), filename)
    
    # 主页面路由
    @app.route('/')
    @app.route('/<path:path>')
    def serve_frontend(path=''):
        # 如果请求的是 API，返回 404
        if path.startswith('api/'):
            return {'error': 'Not Found'}, 404
        
        # 开发模式下代理到 Vite
        if not hasattr(sys, '_MEIPASS'):
            try:
                # 请求 Vite 服务器
                resp = req.get(f'{VITE_SERVER}/{path}', timeout=10)
                # 创建响应，保留关键的内容类型头
                from flask import make_response
                response = make_response(resp.content, resp.status_code)
                # 设置正确的 Content-Type
                content_type = resp.headers.get('Content-Type', 'text/html')
                response.headers['Content-Type'] = content_type
                # 添加 CORS 头，允许跨域
                response.headers['Access-Control-Allow-Origin'] = '*'
                return response
            except Exception as e:
                print(f"Vite proxy error: {e}")
                pass  # 如果 Vite 不可用，回退到本地文件
        
        # 读取并返回 index.html
        index_path = frontend_dist / 'index.html'
        if index_path.exists():
            with open(index_path, 'r', encoding='utf-8') as f:
                return f.read()
        return 'Frontend not built', 500
    
    # 手机端路由
    @app.route('/mobile')
    @app.route('/mobile/<path:path>')
    def serve_mobile(path=''):
        # 开发模式下代理到 Vite
        if not hasattr(sys, '_MEIPASS'):
            try:
                # 请求 Vite 服务器，添加 mobile 路径
                resp = req.get(f'{VITE_SERVER}/mobile/{path}' if path else f'{VITE_SERVER}/mobile', timeout=5)
                return resp.content, resp.status_code, resp.headers.items()
            except Exception as e:
                print(f"Vite mobile proxy error: {e}")
                pass  # 如果 Vite 不可用，回退到本地文件
        
        # 读取并返回移动端 index.html
        index_path = frontend_dist / 'index.html'
        if index_path.exists():
            with open(index_path, 'r', encoding='utf-8') as f:
                return f.read()
        return 'Frontend not built', 500
    
    # 服务发现 API - 返回手机访问信息
    @app.route('/api/mobile/info')
    def mobile_info():
        from utils.qr_code import QRCodeGenerator
        
        # 获取手机访问信息
        access_info = QRCodeGenerator.get_mobile_access_info(port=BACKEND_PORT)
        
        return {
            'success': True,
            'data': access_info
        }, 200
    
    # 健康检查 API
    @app.route('/api/health')
    def health_check():
        return {'status': 'ok'}, 200
    
    # 设置 CPolar authtoken 的 API 端点
    @app.route('/api/mobile/set_cpolar_authtoken', methods=['POST'])
    def set_cpolar_authtoken():
        from flask import request
        import json
        
        try:
            # 获取请求数据
            data = request.get_json()
            authtoken = data.get('authtoken')
            
            if not authtoken:
                return {
                    'success': False,
                    'message': '请提供CPolar Authtoken'
                }, 400
            
            # 保存authtoken到配置文件或环境变量
            import platform
            if platform.system() == 'Windows':
                # Windows系统，保存到cpolar配置目录
                import pathlib
                cpolar_config_dir = pathlib.Path.home() / '.cpolar'
                cpolar_config_dir.mkdir(exist_ok=True)
                
                # 创建或更新authtoken文件
                authtoken_file = cpolar_config_dir / 'authtoken'
                authtoken_file.write_text(authtoken, encoding='utf-8')
            else:
                # Linux/Mac系统，保存到~/.cpolar/authtoken
                import os
                cpolar_config_dir = os.path.expanduser('~/.cpolar')
                os.makedirs(cpolar_config_dir, exist_ok=True)
                
                authtoken_file = os.path.join(cpolar_config_dir, 'authtoken')
                with open(authtoken_file, 'w', encoding='utf-8') as f:
                    f.write(authtoken)
            
            # 重启cpolar服务
            from utils.qr_code import QRCodeGenerator
            QRCodeGenerator.restart_cpolar_service()
            
            return {
                'success': True,
                'message': 'CPolar Authtoken保存成功'
            }, 200
        except Exception as e:
            return {
                'success': False,
                'message': f'保存CPolar Authtoken失败: {str(e)}'
            }, 500
    
    return app


if __name__ == '__main__':
    import logging
    from logging import StreamHandler
    
    # 配置根日志记录器，确保所有日志都输出到控制台
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            StreamHandler()  # 显式添加控制台处理器
        ]
    )
    
    # 配置 Flask 和 werkzeug 的日志级别
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.INFO)
    
    # 配置 Flask app 的日志
    app_logger = logging.getLogger('flask.app')
    app_logger.setLevel(logging.INFO)
    
    app = create_app()
    print(f"Starting Flask backend server on port {BACKEND_PORT}...")
    print(f"Production: http://localhost:{BACKEND_PORT}")
    print(f"Mobile: http://localhost:{BACKEND_PORT}/mobile")
    app.run(debug=False, host='0.0.0.0', port=BACKEND_PORT)
