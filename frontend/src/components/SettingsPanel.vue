<template>
  <div class="settings-panel-container">
    <div class="settings-header">
      <h2>设置</h2>
      <button class="close-btn" @click="$emit('close')">×</button>
    </div>
    
    <div class="settings-content">
      
      <!-- 北航账号绑定 -->
      <section class="settings-section">
        <h3>北航账号绑定</h3>
        <form class="settings-form">
          <div class="form-group">
              <label for="buaa-id">北航学号</label>
              <input 
                  type="text" 
                  id="buaa-id" 
                  v-model="buaaId" 
                  placeholder="请输入北航学号"
              />
          </div>
          <div class="form-group">
              <label for="buaa-password">北航密码</label>
              <input 
                  type="password" 
                  id="buaa-password" 
                  v-model="buaaPassword" 
                  placeholder="请输入北航密码"
              />
          </div>
          <div class="button-group">
            <button type="button" class="sync-btn" @click="syncBuaaCourses" :disabled="syncLoading">
                <span v-if="syncLoading">正在同步...</span>
                <span v-else>同步课程表</span>
            </button>
            <button type="button" class="save-btn" @click="saveBuaaId">保存</button>
          </div>
        <div class="form-hint">
            提示：点击"同步课程表"按钮后，系统会自动处理登录流程。
        </div>
        <div v-if="syncStatus" class="sync-status" :class="syncStatus.includes('成功') ? 'success' : 'error'">
            {{ syncStatus }}
        </div>
        </form>
      </section>
      
      <!-- 提醒偏好设置 -->
      <section class="settings-section">
        <h3>提醒偏好设置</h3>
        <div class="settings-form">
          <div class="form-group">
            <label for="course-reminder">课程/讲座/会议提前提醒时间（分钟）</label>
            <input 
              type="number" 
              id="course-reminder" 
              v-model.number="reminderSettings.course" 
              min="0"
            />
          </div>
          
          <div class="form-group">
            <label>考试多级提醒</label>
            <div class="multi-reminder">
              <div class="exam-reminder-item">
                <label class="exam-reminder-label">复习提醒（天数）</label>
                <input 
                  type="number" 
                  v-model.number="reminderSettings.exam[0]" 
                  placeholder="复习提醒" 
                  min="0"
                />
              </div>
              <div class="exam-reminder-item">
                <label class="exam-reminder-label">前往考场提醒（分钟）</label>
                <input 
                  type="number" 
                  v-model.number="reminderSettings.exam[1]" 
                  placeholder="前往考场提醒" 
                  min="0"
                />
              </div>
            </div>
          </div>
          
          <button class="save-btn" @click="saveReminderSettings">保存</button>
        </div>
      </section>
      
      <!-- LLM 配置 -->
      <section class="settings-section">
        <h3>LLM 配置</h3>
        <div class="settings-form">
          <div class="form-group">
            <label for="llm-platform">LLM 平台选择</label>
            <select 
              id="llm-platform" 
              v-model="llmConfig.platform"
              @change="onPlatformChange"
            >
              <option value="dashscope">阿里云百炼（通义千问）</option>
              <option value="openai">OpenAI 兼容接口（DeepSeek/OpenAI 等）</option>
            </select>
            <p class="form-hint">选择不同的 LLM 服务提供商</p>
          </div>
          
          <div class="form-group">
            <label for="api-key">API Key</label>
            <input 
              type="password" 
              id="api-key" 
              v-model="llmConfig.apiKey" 
              :placeholder="`请输入您的${platformLabels[llmConfig.platform]} API Key`"
            />
            <p class="form-hint" v-if="currentConfig && currentConfig.has_api_key">
              当前已配置 API Key：{{ currentConfig.api_key }}
            </p>
            <p class="form-hint" v-else>
              API Key 将保存在后端服务器的.env 文件中
            </p>
          </div>
          
          <div class="form-group" v-if="llmConfig.platform === 'openai'">
            <label for="base-url">Base URL</label>
            <input 
              type="text" 
              id="base-url" 
              v-model="llmConfig.baseUrl" 
              placeholder="例如：https://api.deepseek.com"
            />
            <p class="form-hint">OpenAI 兼容接口的 Base URL，如 DeepSeek: https://api.deepseek.com</p>
          </div>
          
          <div class="form-group">
            <label for="llm-model">模型名称</label>
            <input 
              type="text" 
              id="llm-model" 
              v-model="llmConfig.model" 
              :placeholder="getModelPlaceholder(llmConfig.platform)"
            />
            <p class="form-hint">{{ getModelHint(llmConfig.platform) }}</p>
          </div>
          
          <!-- 测试连接结果显示 -->
          <div v-if="testResult" :class="['test-result', testResult.success ? 'success' : 'error']">
            <span class="test-result-icon">{{ testResult.success ? '✅' : '❌' }}</span>
            <span class="test-result-message">{{ testResult.message }}</span>
            <div v-if="testResult.success && testResult.platform" class="test-result-details">
              平台：{{ testResult.platform }} | 模型：{{ testResult.model }}
            </div>
          </div>
          
          <div class="form-actions">
            <button 
              class="test-btn" 
              @click="testConnection"
              :disabled="isTesting"
            >
              {{ isTesting ? '测试中...' : '📡 测试连接' }}
            </button>
            <button class="save-btn" @click="saveLLMConfig">保存 LLM 配置</button>
          </div>
        </div>
      </section>
      
      <!-- 主题外观设置 -->
      <section class="settings-section">
        <h3>主题外观设置</h3>
        <div class="settings-form">
          <!-- 暂时禁用深色模式切换 -->
          <div class="form-group" style="display: none;">
            <label>主题选择</label>
            <div class="theme-options">
              <label class="theme-option">
                <input 
                  type="radio" 
                  v-model="theme" 
                  value="light" 
                  checked
                  disabled
                />
                <span>浅色主题</span>
              </label>
              <label class="theme-option">
                <input 
                  type="radio" 
                  v-model="theme" 
                  value="dark" 
                  disabled
                />
                <span>深色主题</span>
              </label>
            </div>
          </div>
          
          <div class="form-group">
            <label for="default-color">默认主题色</label>
            <div class="color-picker-group">
              <input 
                type="color" 
                id="default-color" 
                v-model="defaultColor" 
                class="color-picker"
              />
              <input 
                type="text" 
                v-model="defaultColor" 
                class="color-input"
                placeholder="#4a90e2"
              />
            </div>
          </div>
          
          <button class="save-btn" @click="saveThemeAndColor">保存</button>
        </div>
      </section>
      
      <!-- 精力周期设置 -->
      <section class="settings-section">
        <h3>精力周期设置</h3>
        <div class="settings-form">
          <div class="form-group">
            <label>上午精力</label>
            <select v-model="energyCycle.morning">
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </div>
          
          <div class="form-group">
            <label>下午精力</label>
            <select v-model="energyCycle.afternoon">
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </div>
          
          <div class="form-group">
            <label>晚上精力</label>
            <select v-model="energyCycle.evening">
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </div>
          
          <button class="save-btn" @click="saveEnergyCycle">保存</button>
        </div>
      </section>
      
      <!-- 安全与隐私 -->
      <section class="settings-section">
        <h3>安全与隐私</h3>
        <div class="settings-form">
          <div class="security-info">
            <h4>账号密码安全性保障</h4>
            <ul>
              <li><strong>密码不本地存储：</strong>您的北航账号密码仅用于北航统一身份认证（SSO），不会被本地数据库或文件存储。</li>
              <li><strong>SSO认证流程：</strong>密码直接提交给北航SSO系统验证，系统仅存储北航认证后的会话Cookie。</li>
              <li><strong>Cookie安全存储：</strong>北航系统的会话Cookie采用加密方式存储在本地数据库中。</li>
              <li><strong>单用户模式：</strong>应用采用单用户设计，所有数据仅对当前用户可见。</li>
              <li><strong>数据本地保存：</strong>所有日程、任务数据均保存在本地SQLite数据库中，确保数据隐私。</li>
            </ul>
            <div class="security-tips">
              <h4>安全建议</h4>
              <ul>
                <li>定期更新北航账号密码</li>
                <li>不要在公共设备上使用本应用</li>
                <li>使用完毕后及时退出应用</li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useUserStore, useSettingsStore, useCourseStore, useEntryStore } from '../store'
import { authAPI, coursesAPI, settingsAPI, entriesAPI } from '../services/api'
import axios from 'axios'

const userStore = useUserStore()
const settingsStore = useSettingsStore()

// 北航学号
const buaaId = ref(userStore.buaaId || '')
// 北航密码
const buaaPassword = ref('')

// 提醒设置
const reminderSettings = ref({
  ...settingsStore.reminderSettings
})

// 主题设置
const theme = ref(settingsStore.theme)

// 默认颜色设置
const defaultColor = ref(settingsStore.defaultColor)

// 精力周期设置
const energyCycle = ref({
  ...settingsStore.energyCycle
})

// LLM 配置
const llmConfig = ref({
  platform: 'dashscope',
  apiKey: '',
  baseUrl: '',
  model: ''
})

// 当前配置（从后端加载）
const currentConfig = ref(null)

// 平台标签
const platformLabels = {
  dashscope: '阿里云百炼',
  openai: 'OpenAI 兼容'
}

// 测试连接状态
const isTesting = ref(false)
const testResult = ref(null)
const lastTestTime = ref(null)

// 同步状态
const syncLoading = ref(false)
const syncStatus = ref('')



// 组件挂载时加载北航学号并自动同步课程表
onMounted(async () => {
  try {
    const response = await authAPI.getBuaaId()
    if (response.buaa_id) {
      buaaId.value = response.buaa_id
      userStore.updateBuaaId(response.buaa_id)
      
      // 自动同步课程表
      if (buaaId.value.trim()) {
        await syncBuaaCourses()
      }
    }
    
    // 加载 LLM 配置
    await loadLLMConfig()
    
  } catch (error) {
    // console.error('加载北航学号失败:', error)
  }
})



// 保存北航学号
const saveBuaaId = async () => {
  try {
    // 调用API保存北航学号
    const response = await authAPI.setBuaaId({ 
      buaa_id: buaaId.value 
    })
    // console.log('保存北航学号:', response)
    // 更新store
    userStore.updateBuaaId(buaaId.value)
  } catch (error) {
    // console.error('保存失败:', error)
    alert('保存失败')
  }
}

// 同步北航课程表
const syncBuaaCourses = async () => {
  try {
    // 验证北航学号
    if (!buaaId.value.trim()) {
      alert('请先输入北航学号')
      return
    }
    
    // 设置加载状态
    syncLoading.value = true
    syncStatus.value = '正在登录北航系统...'
    
    // 通过后端代理调用北航API
    const date = new Date().toISOString().split('T')[0]
    
    console.log('发起同步请求，参数:', {
      buaa_id: buaaId.value,
      password: buaaPassword.value ? '******' : '',
      date: date
    })
    
    // 直接调用后端的sync_buaa接口，让后端处理北航API调用
    const syncResponse = await coursesAPI.syncBuaaCourses({
      buaa_id: buaaId.value,
      password: buaaPassword.value,
      date: date
    })
    
    console.log('同步请求返回结果:', syncResponse)
    
    // 检查同步结果
    if (syncResponse && syncResponse.status === 'success') {
      // 更新同步状态
      syncStatus.value = '课程表同步成功！'
      
      // 刷新课程列表和日历数据
      const courseStore = useCourseStore()
      const entryStore = useEntryStore()
      
      // 获取最新的课程列表
      const coursesResponse = await coursesAPI.getCourses()
      courseStore.setCourses(coursesResponse.courses)
      
      // 使用完整的GET-BUAA_API-GET逻辑：先获取指定日期范围内的entries，然后同步课程表，最后再次获取entries
    const formattedDate = date
      
      // 1. 先获取当前日期的entries，确保数据基础
      // 注：此步骤可考虑移除，因为后续会再次获取完整的7天数据
      // const initialEntriesResponse = await entriesAPI.getEntriesByDate(formattedDate)
      // const initialEntries = Array.isArray(initialEntriesResponse) ? initialEntriesResponse : (initialEntriesResponse.entries || [])
      
      // 2. 再次同步课程表（使用按日期同步API，确保获取最新数据）
      try {
        await coursesAPI.syncBuaaCoursesByDate(formattedDate, {
          buaa_id: buaaId.value,
          password: '' // 密码由后端存储，前端不需要传递
        })
      } catch (syncError) {
        console.error('再次同步课程表失败:', syncError)
        // 继续执行，不影响后续操作
      }
      
      // 3. 最后再次获取entries数据，确保获取到最新的课程表数据
      // 直接使用 /entries/<date> API，它已经默认返回7天范围的条目
      // 将formattedDate前移一天
      const targetDate = new Date(formattedDate)
      targetDate.setDate(targetDate.getDate() - 1)
      const previousDay = targetDate.toISOString().split('T')[0]
      const entriesResponse = await entriesAPI.getEntriesByDate(previousDay)
      const entries = Array.isArray(entriesResponse) ? entriesResponse : (entriesResponse.entries || [])
      entryStore.setEntries(entries)
      
      console.log('已执行完整的GET-BUAA_API-GET逻辑，刷新了日历数据')
    } else {
      // 同步失败
      const errorMessage = syncResponse && syncResponse.message ? syncResponse.message : '同步失败，请稍后重试'
      syncStatus.value = `同步失败: ${errorMessage}`
      console.error('同步课程表失败:', syncResponse)
    }
    
    // 清空密码
    buaaPassword.value = ''
  } catch (error) {
    // 处理不同类型的错误
    if (error.response) {
      // 服务器返回错误
      const errorData = error.response.data
      console.error('同步课程表失败，服务器返回错误:', errorData)
      if (error.response.status === 401) {
        // 认证错误
        syncStatus.value = `北航登录失败: ${errorData.message || '请检查学号和密码'}`
      } else if (error.response.status === 503) {
        // 网络错误
        syncStatus.value = `网络错误: ${errorData.message || '无法连接到北航服务器'}`
      } else {
        // 其他服务器错误
        syncStatus.value = `同步失败: ${errorData.message || '服务器内部错误'}`
      }
    } else if (error.request) {
      // 请求已发送但没有收到响应
      console.error('同步课程表失败，没有收到服务器响应:', error.request)
      syncStatus.value = '请求失败: 无法连接到服务器'
    } else {
      // 请求配置错误
      console.error('同步课程表失败，请求配置错误:', error.message)
      syncStatus.value = `请求失败: ${error.message}`
    }
  } finally {
    // 关闭加载状态
    syncLoading.value = false
  }
}

// 保存提醒设置
const saveReminderSettings = () => {
  settingsStore.updateReminderSettings(reminderSettings.value)
}

// 保存主题和颜色设置
const saveThemeAndColor = () => {
  settingsStore.updateTheme(theme.value)
  settingsStore.updateDefaultColor(defaultColor.value)
  // 主题和颜色切换会通过CSS变量自动生效
}

// 保存精力周期设置
const saveEnergyCycle = () => {
  settingsStore.updateEnergyCycle(energyCycle.value)
}

// 加载 LLM 配置
const loadLLMConfig = async () => {
  try {
    const response = await settingsAPI.getLLMConfig()
    if (response) {
      currentConfig.value = response
      // 填充配置表单
      llmConfig.value.platform = response.platform || 'dashscope'
      llmConfig.value.model = response.model || ''
      llmConfig.value.baseUrl = response.base_url || ''
      // 不填充完整的 API Key，只保留显示
    }
  } catch (error) {
    console.error('加载 LLM 配置失败:', error)
  }
}

// 平台变化时的处理
const onPlatformChange = () => {
  // 根据平台设置默认值
  if (llmConfig.value.platform === 'dashscope') {
    llmConfig.value.baseUrl = ''
    if (!llmConfig.value.model) {
      llmConfig.value.model = 'qwen-plus-2025-12-01'
    }
  } else if (llmConfig.value.platform === 'openai') {
    if (!llmConfig.value.model) {
      llmConfig.value.model = 'deepseek-chat'
    }
  }
}

// 获取模型占位符
const getModelPlaceholder = (platform) => {
  if (platform === 'dashscope') {
    return '例如：qwen-plus-2025-12-01'
  } else if (platform === 'openai') {
    return '例如：deepseek-chat 或 gpt-3.5-turbo'
  }
  return ''
}

// 获取模型提示
const getModelHint = (platform) => {
  if (platform === 'dashscope') {
    return '阿里云百炼支持的模型名称，默认使用 qwen-plus'
  } else if (platform === 'openai') {
    return 'OpenAI 兼容接口的模型名称，DeepSeek 推荐使用 deepseek-chat'
  }
  return ''
}

// 保存 LLM 配置
const saveLLMConfig = async () => {
  if (!llmConfig.value.apiKey.trim()) {
    alert('请输入 API Key')
    return
  }
  
  try {
    const config = {
      platform: llmConfig.value.platform,
      api_key: llmConfig.value.apiKey,
      model: llmConfig.value.model,
      base_url: llmConfig.value.baseUrl
    }
    
    const response = await settingsAPI.saveLLMConfig(config)
    // 清空输入框
    llmConfig.value.apiKey = ''
    // 重新加载配置
    await loadLLMConfig()
    alert('LLM 配置保存成功！')
  } catch (error) {
    console.error('保存 LLM 配置失败:', error)
    alert('保存 LLM 配置失败，请重试')
  }
}

// 测试 LLM 连接
const testConnection = async () => {
  // 防止频繁点击
  if (isTesting.value) return
  
  // 移除 API Key 检查，让后端返回错误
  // if (!llmConfig.value.apiKey.trim() && !currentConfig.value?.has_api_key) {
  //   testResult.value = {
  //     success: false,
  //     message: '请先输入或保存 API Key'
  //   }
  //   return
  // }
  
  isTesting.value = true
  testResult.value = null
  
  try {
    const response = await settingsAPI.testConnection()
    
    testResult.value = {
      success: response.success,
      message: response.message,
      platform: response.platform,
      model: response.model
    }
    
    // 如果测试成功，记录测试时间
    if (response.success) {
      lastTestTime.value = new Date()
    }
  } catch (error) {
    // 处理不同类型的错误
    if (error.response) {
      const errorData = error.response.data
      
      // 根据错误类型显示不同提示
      if (errorData.error_type === 'missing_api_key') {
        testResult.value = {
          success: false,
          message: '请先保存 API Key 后再测试'
        }
      } else if (errorData.error_type === 'authentication_error') {
        testResult.value = {
          success: false,
          message: 'API Key 无效或已过期，请检查后重试'
        }
      } else if (errorData.error_type === 'network_error') {
        testResult.value = {
          success: false,
          message: '网络连接失败，请检查网络或代理设置'
        }
      } else if (errorData.error_type === 'quota_error') {
        testResult.value = {
          success: false,
          message: 'API 配额已用尽或余额不足'
        }
      } else if (errorData.error_type === 'rate_limit_error') {
        testResult.value = {
          success: false,
          message: '请求过于频繁，请稍后再试（限 5 次/分钟）'
        }
      } else if (error.response.status === 429) {
        testResult.value = {
          success: false,
          message: '测试过于频繁，请稍后再试（限 5 次/分钟）'
        }
      } else {
        testResult.value = {
          success: false,
          message: errorData.message || '测试失败，请稍后重试'
        }
      }
    } else if (error.code === 'ECONNABORTED') {
      testResult.value = {
        success: false,
        message: '请求超时，请检查网络连接'
      }
    } else {
      testResult.value = {
        success: false,
        message: '无法连接到服务器，请检查后端服务是否运行'
      }
    }
  } finally {
    isTesting.value = false
    
    // 5 秒后自动清除测试结果
    setTimeout(() => {
      if (!isTesting.value) {
        testResult.value = null
      }
    }, 5000)
  }
}
</script>

<style scoped>
.settings-panel-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.settings-header h2 {
  font-size: 1.5rem;
  color: #333;
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: #666;
  padding: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.3s ease;
}

.close-btn:hover {
  background-color: #f5f5f5;
  color: #333;
}

.settings-content {
  overflow-y: auto;
}

.settings-section {
  margin-bottom: 2rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.settings-section:last-child {
  border-bottom: none;
}

.settings-section h3 {
  font-size: 1.2rem;
  margin-bottom: 1rem;
  color: #333;
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.form-group label {
  font-weight: 500;
  color: #333;
  font-size: 0.9rem;
}

.form-group input,
.form-group select {
  padding: 0.75rem;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  font-size: 1rem;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 2px rgba(74, 144, 226, 0.2);
}

.button-group {
  display: flex;
  gap: 0.5rem;
}

.sync-btn {
  padding: 0.75rem 1.5rem;
  border: 1px solid var(--primary-color);
  border-radius: 4px;
  background-color: white;
  color: var(--primary-color);
  cursor: pointer;
  transition: all 0.3s ease;
  font-size: 1rem;
  align-self: flex-start;
}

.sync-btn:hover {
  background-color: var(--primary-light);
}

.form-hint {
        font-size: 0.85rem;
        color: #666;
        margin-top: 0.5rem;
        padding: 0.5rem;
        background-color: #f5f5f5;
        border-radius: 4px;
        border-left: 3px solid #4a90e2;
    }
    
    /* 登录选项对话框样式 */
    .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1000;
    }
    
    .modal-content {
        background-color: white;
        padding: 1.5rem;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        width: 90%;
        max-width: 600px;
    }
    
    .login-options {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }
    
    .login-option {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }
    
    .login-option h4 {
        margin: 0;
        font-size: 1.1rem;
        color: #333;
    }
    
    .login-option p {
        margin: 0;
        font-size: 0.9rem;
        color: #666;
    }
    
    .login-form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }
    
    .remember-me {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
    }
    
    .login-divider {
        text-align: center;
        color: #999;
        position: relative;
    }
    
    .login-divider::before,
    .login-divider::after {
        content: '';
        position: absolute;
        top: 50%;
        width: 45%;
        height: 1px;
        background-color: #e0e0e0;
    }
    
    .login-divider::before {
        left: 0;
    }
    
    .login-divider::after {
        right: 0;
    }
    
    .cancel-btn {
        padding: 0.75rem 1.5rem;
        border: 1px solid #e0e0e0;
        border-radius: 4px;
        background-color: white;
        color: #333;
        cursor: pointer;
        transition: all 0.3s ease;
        font-size: 1rem;
        align-self: flex-start;
    }
    
    .cancel-btn:hover {
        background-color: #f5f5f5;
    }

.multi-reminder {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.exam-reminder-item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.exam-reminder-label {
  font-size: 0.9rem;
  font-weight: 500;
  color: #333;
}

.multi-reminder input {
  width: 100%;
  max-width: 200px;
  padding: 0.75rem;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  font-size: 1rem;
}

.theme-options {
  display: flex;
  gap: 1.5rem;
}

.theme-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

/* 自定义单选按钮样式 */
.theme-option input[type="radio"] {
  accent-color: var(--primary-color);
}

.color-picker-group {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.color-picker {
  width: 40px;
  height: 40px;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  cursor: pointer;
}

.color-input {
  flex: 1;
  padding: 0.75rem;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  font-size: 1rem;
}

.save-btn {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 4px;
  background-color: var(--primary-color);
  color: white;
  cursor: pointer;
  transition: all 0.3s ease;
  font-size: 1rem;
  align-self: flex-start;
}

.save-btn:hover {
  background-color: var(--primary-dark);
}

/* 测试连接按钮样式 */
.form-actions {
  display: flex;
  gap: 1rem;
  margin-top: 0.5rem;
}

.test-btn {
  padding: 0.75rem 1.5rem;
  border: 2px solid var(--primary-color);
  border-radius: 4px;
  background-color: white;
  color: var(--primary-color);
  cursor: pointer;
  transition: all 0.3s ease;
  font-size: 1rem;
  font-weight: 500;
  align-self: flex-start;
}

.test-btn:hover:not(:disabled) {
  background-color: var(--primary-color);
  color: white;
}

.test-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 测试结果显示 */
.test-result {
  padding: 1rem;
  border-radius: 4px;
  font-size: 0.9rem;
  font-weight: 500;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.test-result.success {
  background-color: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.test-result.error {
  background-color: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.test-result-icon {
  font-size: 1.2rem;
}

.test-result-message {
  font-weight: 600;
}

.test-result-details {
  font-size: 0.85rem;
  opacity: 0.8;
  margin-top: 0.25rem;
}

/* 同步状态样式 */
.sync-status {
  margin-top: 1rem;
  padding: 0.75rem;
  border-radius: 4px;
  font-size: 0.9rem;
  font-weight: 500;
  text-align: center;
}

.sync-status.success {
  background-color: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.sync-status.error {
  background-color: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}


</style>
