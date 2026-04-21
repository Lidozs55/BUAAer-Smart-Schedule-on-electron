from flask import Blueprint, request, jsonify
import os
import dotenv

settings_bp = Blueprint('settings', __name__)

def get_env_path():
    """获取.env 文件路径 - 兼容 PyInstaller 打包环境"""
    import sys
    if hasattr(sys, '_MEIPASS'):
        # 打包后的运行环境，.env 文件位于 exe 所在目录
        basedir = os.path.dirname(sys.executable)
    else:
        # 开发环境，.env 文件位于 backend 目录上一级
        basedir = os.path.abspath(os.path.dirname(__file__))
        basedir = os.path.dirname(basedir)
    return os.path.join(basedir, '.env')

def save_env_variable(key, value):
    """保存环境变量到.env 文件"""
    env_path = get_env_path()
    
    # 读取现有.env 文件内容
    env_content = ''
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            env_content = f.read()
    
    # 更新或添加配置
    lines = env_content.split('\n')
    updated_lines = []
    key_found = False
    
    for line in lines:
        if line.strip().startswith(f'{key}='):
            # 更新现有配置
            updated_lines.append(f'{key}={value}')
            key_found = True
        else:
            updated_lines.append(line)
    
    if not key_found:
        # 添加新配置
        updated_lines.append(f'{key}={value}')
    
    # 写入更新后的内容
    with open(env_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(updated_lines))
    
    # 重新加载环境变量，确保配置立即生效
    from dotenv import load_dotenv
    load_dotenv(env_path, override=True)

@settings_bp.route('/api_key', methods=['POST'])
def save_api_key():
    """保存 API_KEY 到.env 文件（旧接口，保留向后兼容）"""
    data = request.get_json()
    api_key = data.get('api_key')
    
    if not api_key:
        return jsonify({'error': 'API_KEY is required'}), 400
    
    try:
        save_env_variable('LLM_API_KEY', api_key)
        return jsonify({'message': 'API_KEY saved successfully'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@settings_bp.route('/llm_config', methods=['POST'])
def save_llm_config():
    """保存完整的 LLM 配置（平台、API Key、模型、Base URL）"""
    data = request.get_json()
    
    # 验证必填字段
    required_fields = ['platform', 'api_key']
    for field in required_fields:
        if field not in data:
            return jsonify({'error': f'缺少必填字段：{field}'}), 400
    
    platform = data['platform']
    api_key = data['api_key']
    model = data.get('model', '')
    base_url = data.get('base_url', '')
    
    try:
        # 保存平台配置
        save_env_variable('LLM_PLATFORM', platform)
        
        # 保存 API Key
        save_env_variable('LLM_API_KEY', api_key)
        
        # 保存模型配置（如果提供）
        if model:
            save_env_variable('LLM_MODEL', model)
        
        # 保存 Base URL（如果提供）
        if base_url:
            save_env_variable('LLM_BASE_URL', base_url)
        
        return jsonify({
            'message': 'LLM 配置保存成功',
            'config': {
                'platform': platform,
                'model': model,
                'base_url': base_url
            }
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@settings_bp.route('/llm_config', methods=['GET'])
def get_llm_config():
    """获取当前 LLM 配置"""
    try:
        # 重新加载.env 文件获取最新配置
        from dotenv import load_dotenv
        env_path = get_env_path()
        if os.path.exists(env_path):
            load_dotenv(env_path, override=True)
        
        # 获取配置
        platform = os.getenv('LLM_PLATFORM', 'dashscope')  # 默认阿里云
        model = os.getenv('LLM_MODEL', '')
        base_url = os.getenv('LLM_BASE_URL', '')
        api_key = os.getenv('LLM_API_KEY', '')
        
        # 如果有 API Key，返回部分信息（不返回完整 key）
        api_key_display = ''
        if api_key:
            api_key_display = api_key[:8] + '...' if len(api_key) > 8 else api_key[:4] + '...'
        
        return jsonify({
            'platform': platform,
            'model': model,
            'base_url': base_url,
            'api_key': api_key_display,
            'has_api_key': bool(api_key)
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# 简单的内存限流器（生产环境建议使用 Redis）
_test_request_timestamps = {}

@settings_bp.route('/test_connection', methods=['POST'])
def test_llm_connection():
    """测试 LLM 连接是否可用"""
    import time
    from flask import request
    
    # 限流：每个客户端 60 秒内最多 5 次请求
    client_ip = 'default'
    current_time = time.time()
    
    if client_ip in _test_request_timestamps:
        timestamps = [ts for ts in _test_request_timestamps[client_ip] if current_time - ts < 60]
        _test_request_timestamps[client_ip] = timestamps
        
        if len(timestamps) >= 5:
            return jsonify({
                'success': False,
                'message': '测试过于频繁，请稍后再试'
            }), 429
    
    if client_ip not in _test_request_timestamps:
        _test_request_timestamps[client_ip] = []
    _test_request_timestamps[client_ip].append(current_time)
    
    # 直接调用 llm_parser 的 _call_llm 函数
    from services.llm_parser import LLMParser
    
    try:
        parser = LLMParser()
        
        # 使用简短的测试消息
        test_messages = [{"role": "user", "content": "连接成功"}]
        
        # 调用 LLM API
        response = parser._call_llm(test_messages)
        
        # 获取配置用于返回
        config = parser._get_llm_config()
        
        success = response is not None
        
        return jsonify({
            'success': success,
            'message': '连接成功！API Key 有效' if success else 'API 调用失败',
            'platform': config['platform'],
            'model': config['model'] or 'default'
        })
            
    except Exception as e:
        # 返回简化错误信息
        return jsonify({
            'success': False,
            'message': f'测试失败：{str(e)}'
        }), 500
