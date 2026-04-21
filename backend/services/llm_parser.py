import os
import json
import requests
import logging
from config import Config

# 配置 logging 输出到控制台
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class LLMParser:
    def __init__(self):
        """初始化 LLM 解析器 - 支持多平台"""
        pass
    
    def _get_llm_config(self):
        """获取 LLM 配置 - 每次调用时重新获取，确保能获取到最新配置"""
        # 重新加载环境变量
        from dotenv import load_dotenv
        from config import get_env_path
        env_path = get_env_path()
        if os.path.exists(env_path):
            load_dotenv(env_path, override=True)
        
        # 获取平台配置
        platform = os.getenv('LLM_PLATFORM', 'dashscope')  # 默认阿里云
        api_key = os.getenv('LLM_API_KEY')
        model = os.getenv('LLM_MODEL', '')
        base_url = os.getenv('LLM_BASE_URL', '')
        
        # 如果没有配置 platform，默认为 dashscope
        if not platform:
            platform = 'dashscope'
        
        return {
            'platform': platform,
            'api_key': api_key,
            'model': model,
            'base_url': base_url
        }
    
    def _call_llm(self, messages):
        """
        调用 LLM API - 根据平台自动选择合适的 SDK
        支持平台：dashscope(阿里云), openai(兼容接口包括 DeepSeek)
        """
        config = self._get_llm_config()
        platform = config['platform']
        api_key = config['api_key']
        model = config['model']
        base_url = config['base_url']
        
        if not api_key:
            return None
        
        try:
            if platform == 'dashscope':
                # 阿里云百炼
                from dashscope import Generation
                import dashscope
                dashscope.base_http_api_url = 'https://dashscope.aliyuncs.com/api/v1'
                
                response = Generation.call(
                    api_key=api_key,
                    model=model or 'qwen-plus-2025-12-01',
                    messages=messages,
                    result_format="message",
                    enable_thinking=True,
                )
                
                if response.status_code == 200:
                    return response.output.choices[0].message.content
                else:
                    return None
                    
            elif platform == 'openai':
                # OpenAI 兼容接口（包括 DeepSeek、OpenAI 等）
                from openai import OpenAI
                import httpx
                
                # 设置默认 Base URL（如果没有配置）
                if not base_url:
                    base_url = 'https://api.openai.com/v1'
                
                # 设置默认模型
                if not model:
                    if 'deepseek' in base_url.lower():
                        model = 'deepseek-chat'
                    else:
                        model = 'gpt-3.5-turbo'
                
                # 创建 httpx 客户端
                http_client = httpx.Client()
                
                client = OpenAI(
                    api_key=api_key,
                    base_url=base_url,
                    http_client=http_client
                )
                
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    stream=False
                )
                
                return response.choices[0].message.content
            
            else:
                # 未知平台，尝试使用 OpenAI 兼容接口
                from openai import OpenAI
                
                if not base_url:
                    return None
                
                client = OpenAI(
                    api_key=api_key,
                    base_url=base_url
                )
                
                response = client.chat.completions.create(
                    model=model or 'default',
                    messages=messages,
                    stream=False
                )
                
                return response.choices[0].message.content
                
        except Exception as e:
            logger.error(f"LLM API 调用失败：{str(e)}")
            return None
    
    def _get_occupied_slots(self, start_date):
        """获取未来7天已占用时段"""
        try:
            # 调用本地API获取未来7天的日程
            api_url = f"http://127.0.0.1:5000/api/entries/{start_date}"
            response = requests.get(api_url)
            response.raise_for_status()
            data = response.json()
            
            # 仅保留每条entry的起止时间
            occupied_slots = []
            for entry in data.get('entries', []):
                occupied_slots.append({
                    'start_time': entry['start_time'],
                    'end_time': entry['end_time']
                })
            
            return occupied_slots
        except Exception as e:
            return []
    
    def parse_text(self, text, user_preferences=None, start_date=None):
        """解析文本内容，提取时限任务和固定日程信息"""
        # 如果没有提供开始日期，使用当前日期
        if not start_date:
            from datetime import datetime
            start_date = datetime.now().strftime('%Y-%m-%d')
        
        # 获取未来7天已占用时段
        occupied_slots = self._get_occupied_slots(start_date)
        
        # 构建提示词
        prompt = "请分析以下用户输入，提取时限任务和固定日程信息，并返回指定格式的JSON数据。\n\n"
        prompt += "输入数据：\n"
        prompt += f"- 文本内容：\"{text}\"\n"
        
        if user_preferences:
            prompt += f"- 用户偏好：{json.dumps(user_preferences)}\n"
        
        prompt += f"- 未来7天已占用时段：{json.dumps(occupied_slots)}\n\n"
        
        prompt += "处理要求：\n"
        prompt += "1. **任务(task)**：从文本中识别有截止时间的任务\n"
        prompt += "   - 提取：任务名称、截止时间\n"
        prompt += "   - 估算：预期完成时长\n"
        prompt += "   - 安排：在截止时间前，避开已占用时段，推荐合适的一个或多个完成时间段，同时生成一个或多个伴随的entry条目\n"
        prompt += "2. **日程(entry)**：从文本中识别时间固定的安排\n"
        prompt += "   - 提取：日程名称（如有地址信息则包含地址信息）、开始时间、结束时间、日程类型（详见json示例）\n"
        prompt += "   - 安排（不一定存在）：若存在极重要的且需要前置准备的日程（如考试等）可以避开已占用时段，推荐合适的一个或多个完成时间段，同时额外生成一个或多个entry条目\n"
        
        import time
        import datetime
        weekdays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
        current_date_str=time.strftime('%Y-%m-%d', time.localtime())+f"({weekdays[datetime.datetime.now().weekday()]})"

        prompt += "输出要求：\n"
        prompt += "- 仅返回JSON格式数据，不包含其他内容\n"
        prompt += "- 不考虑文本中直接提取的时间固定安排，确保其他时间安排不与已占用时段冲突\n"
        prompt += "- 合理安排任务完成时间，考虑用户偏好，考虑人类基本作息规律\n"
        prompt += f"- 以用户当前时间{current_date_str}为基准，返回的时间和日期必须经过仔细检查，尤其是对于“明天”“这周四”等相对时间\n"
        
        prompt += "请返回以下JSON格式：\n"
        prompt += "{\n"
        prompt += "  \"tasks\": [\n"
        prompt += "    {\n"
        prompt += "      \"name\": \"任务名称\",\n"
        prompt += "      \"deadline\": \"YYYY-MM-DD HH:MM\",\n"
        prompt += "      \"estimated_time\": 120\n"
        prompt += "    }\n"
        prompt += "  ],\n"
        prompt += "  \"entries\": [\n"
        prompt += "    {\n"
        prompt += "      \"title\": \"日程名称\",\n"
        prompt += "      \"start_time\": \"YYYY-MM-DD HH:MM\",\n"
        prompt += "      \"end_time\": \"YYYY-MM-DD HH:MM\",\n"
        prompt += "      \"entry_type\": \"meeting/course/exam/study/lecture/sports/other\"\n"
        prompt += "    }\n"
        prompt += "  ]\n"
        prompt += "}\n"
        
        try:
            # 每次调用时获取最新的配置
            config = self._get_llm_config()
            if not config['api_key']:
                return None
            
            # 调用大语言模型 API
            messages = [{"role": "user", "content": prompt}]
            response_content = self._call_llm(messages)
            return response_content
        except Exception as e:
            return None
    
    def parse_voice(self, voice_text, user_preferences=None, start_date=None):
        """解析语音转文字内容，提取任务信息"""
        return self.parse_text(voice_text, user_preferences, start_date)
    
    def parse_image(self, image_text, user_preferences=None, start_date=None):
        """解析图片OCR识别内容，提取任务信息"""
        return self.parse_text(image_text, user_preferences, start_date)
    
    def parse_clipboard(self, clipboard_text, user_preferences=None, start_date=None):
        """解析剪切板内容，提取任务信息"""
        return self.parse_text(clipboard_text, user_preferences, start_date)
    
    def generate_entries_from_task(self, task, user_preferences=None, start_date=None):
        """根据任务生成日程安排"""
        # 如果没有提供开始日期，使用当前日期
        if not start_date:
            from datetime import datetime
            start_date = datetime.now().strftime('%Y-%m-%d')
        
        # 获取未来 7 天已占用时段
        occupied_slots = self._get_occupied_slots(start_date)
        
        # 构建提示词
        prompt = "请根据以下任务信息，在截止日期前自动拆分工作并安排到空闲时间中，生成日程安排。\n\n"
        prompt += "任务信息：\n"
        prompt += f"- 任务名称：{task.get('title', '')}\n"
        prompt += f"- 任务描述：{task.get('description', '')}\n"
        prompt += f"- 任务类型：{task.get('task_type', '')}\n"
        prompt += f"- 截止日期：{task.get('deadline', '')}\n"
        prompt += f"- 任务优先级：{task.get('priority', '')}\n"
        
        if user_preferences:
            prompt += f"- 用户偏好：{json.dumps(user_preferences)}\n"
        
        prompt += f"- 未来 7 天已占用时段：{json.dumps(occupied_slots)}\n\n"
        
        prompt += "处理要求：\n"
        prompt += "1. 请将任务拆分为合理的工作段，安排在截止日期前的空闲时间中\n"
        prompt += "2. 确保生成的日程不与已占用时段冲突\n"
        prompt += "3. 考虑人类基本作息规律，避免安排过晚或过早的时间\n"
        prompt += "4. 根据任务优先级和截止日期合理分配时间\n"
        
        import time
        import datetime
        weekdays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
        current_date_str=time.strftime('%Y-%m-%d', time.localtime())+f"({weekdays[datetime.datetime.now().weekday()]})"
        
        prompt += "输出要求：\n"
        prompt += "- 仅返回 JSON 格式数据，不包含其他内容\n"
        prompt += f"- 以用户当前时间{current_date_str}为基准，返回的时间和日期必须经过仔细检查\n"
        prompt += "- 为每个工作段生成一个 entry 条目\n"
        
        prompt += "请返回以下 JSON 格式：\n"
        prompt += "{\n"
        prompt += "  \"entries\": [\n"
        prompt += "    {\n"
        prompt += "      \"title\": \"任务名称 - 工作段描述\",\n"
        prompt += "      \"start_time\": \"YYYY-MM-DD HH:MM\",\n"
        prompt += "      \"end_time\": \"YYYY-MM-DD HH:MM\",\n"
        prompt += "      \"entry_type\": \"study\"\n"
        prompt += "    }\n"
        prompt += "  ]\n"
        prompt += "}\n"
        
        try:
            # 复用 _call_llm 方法
            messages = [{"role": "user", "content": prompt}]
            response = self._call_llm(messages)
            return response
        except Exception as e:
            logger.error(f"生成日程安排失败：{str(e)}")
            return None
