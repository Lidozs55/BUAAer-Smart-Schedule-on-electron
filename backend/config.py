import os
import sys
from dotenv import load_dotenv

def get_basedir():
    """获取基础目录路径 - 兼容 PyInstaller 打包环境"""
    if hasattr(sys, '_MEIPASS'):
        # 打包后的运行环境
        return os.path.dirname(sys.executable)
    else:
        # 开发环境
        return os.path.abspath(os.path.dirname(__file__))

def get_env_path():
    """获取.env 文件路径 - 兼容 PyInstaller 打包环境"""
    basedir = get_basedir()
    return os.path.join(basedir, '.env')

# 加载环境变量，指定.env 文件路径
env_path = get_env_path()
load_dotenv(env_path, override=True)

# 获取基础目录（用于 Config 类）
basedir = get_basedir()

class Config:
    """Flask 应用配置"""
    # 密钥，用于会话管理和加密
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-secret-key'
    
    # 确保 instance 目录存在
    instance_dir = os.path.join(basedir, "instance")
    if not os.path.exists(instance_dir):
        os.makedirs(instance_dir)
    
    # 数据库 URI
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL') or f'sqlite:///{os.path.join(instance_dir, "app.db")}'
    
    # 大语言模型 API 配置 - 直接从环境变量获取，支持从文件加载和系统环境变量
    LLM_API_KEY = os.environ.get('LLM_API_KEY')
    LLM_API_URL = os.environ.get('LLM_API_URL') or 'https://api.qwen.com/v1/chat/completions'
    
    # 提醒配置
    REMINDER_INTERVAL = 60  # 检查提醒的间隔时间（秒）
    
    # 北航 API 配置
    BUAA_API_BASE_URL = 'https://byxt.buaa.edu.cn/jwapp/sys'
