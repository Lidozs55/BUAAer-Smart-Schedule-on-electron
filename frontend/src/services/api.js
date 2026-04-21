import axios from 'axios'

// 检测是否为 Electron 环境
const isElectron = window.electron !== undefined

// 确定后端 API 基础 URL
let baseURL = '/api'
if (isElectron) {
  // Electron 环境下使用绝对 URL
  baseURL = 'http://127.0.0.1:5000/api'
}

// 创建 axios 实例
const api = axios.create({
  baseURL: baseURL,
  timeout: 30000,
  withCredentials: true
})

// 请求拦截器
api.interceptors.request.use(
  config => {
    // 这里可以添加认证token
    return config
  },
  error => {
    return Promise.reject(error)
  }
)

// 响应拦截器
api.interceptors.response.use(
  response => {
    return response.data
  },
  error => {
    return Promise.reject(error)
  }
)

// 认证相关API
export const authAPI = {
  // 设置北航学号
  setBuaaId: (data, signal) => api.post('/auth/buaa_id', data, { signal }),
  // 获取北航学号
  getBuaaId: (signal) => api.get('/auth/buaa_id', { signal })
}

// 大语言模型解析API
export const llmAPI = {
  // 解析文本内容
  parseText: (data) => api.post('/llm/parse/text', data),
  // 解析语音转文字内容
  parseVoice: (data) => api.post('/llm/parse/voice', data),
  // 解析图片OCR识别内容
  parseImage: (data) => api.post('/llm/parse/image', data),
  // 解析剪切板内容
  parseClipboard: (data) => api.post('/llm/parse/clipboard', data),
  // 根据任务生成日程安排
  generateEntriesFromTask: (data) => api.post('/llm/generate/entries_from_task', data)
}

// 课程相关API
export const coursesAPI = {
  // 获取课程列表
  getCourses: () => api.get('/courses'),
  // 添加课程
  addCourse: (data) => api.post('/courses', data),
  // 更新课程
  updateCourse: (id, data) => api.put(`/courses/${id}`, data),
  // 删除课程
  deleteCourse: (id) => api.delete(`/courses/${id}`),
  // 同步北航课程表（使用当前日期）
  syncBuaaCourses: (data) => api.post('/courses/sync_buaa', data),
  // 按指定日期同步北航课程表
  syncBuaaCoursesByDate: (date, data, signal) => api.post(`/courses/sync_buaa/${date}`, data, { signal }),
  // 验证北航登录凭证
  verifyBuaaCredentials: (data) => api.post('/courses/verify_buaa_credentials', data)
}

// 条目相关API - 用于处理所有类型的条目（课程、会议、学习、运动等）
export const entriesAPI = {
  // 获取所有条目
  getEntries: (signal) => api.get('/entries', signal ? { signal } : {}),
  // 按日期获取条目
  getEntriesByDate: (date, signal) => api.get(`/entries/${date}`, signal ? { signal } : {}),
  // 按日期范围获取条目
  getEntriesByDateRange: (startDate, endDate, signal) => api.get('/entries/range', { params: { start_date: startDate, end_date: endDate }, ...(signal ? { signal } : {}) }),
  // 添加新条目
  addEntry: (data, signal) => api.post('/entries', data, signal ? { signal } : {}),
  // 更新条目
  updateEntry: (id, data, signal) => api.put(`/entries/${id}`, data, signal ? { signal } : {}),
  // 删除条目
  deleteEntry: (id, signal) => api.delete(`/entries/${id}`, signal ? { signal } : {}),
  // 获取课程类型的条目
  getCourseEntries: (signal) => api.get('/entries/courses', signal ? { signal } : {})
}

// 任务相关API
export const tasksAPI = {
  // 获取任务列表
  getTasks: (completed) => api.get('/tasks', { params: { completed } }),
  // 添加任务
  addTask: (data) => api.post('/tasks', data),
  // 更新任务
  updateTask: (id, data) => api.put(`/tasks/${id}`, data),
  // 删除任务
  deleteTask: (id) => api.delete(`/tasks/${id}`),
  // 标记任务为完成
  completeTask: (id) => api.put(`/tasks/${id}/complete`),
  // 标记任务为未完成
  uncompleteTask: (id) => api.put(`/tasks/${id}/uncomplete`)
}

// 日程管理相关 API
export const scheduleAPI = {
  // 检查日程冲突
  checkConflict: (data) => api.post('/schedule/check_conflict', data),
  // 自动安排任务
  autoSchedule: (data) => api.post('/schedule/auto_schedule', data),
  // 查找可用时间段
  findAvailableSlots: (data) => api.post('/schedule/find_available_slots', data)
}

// API_KEY 相关 API
export const settingsAPI = {
  // 保存 API_KEY（旧接口，保留向后兼容）
  saveApiKey: (data) => api.post('/settings/api_key', data),
  // 保存完整的 LLM 配置
  saveLLMConfig: (data) => api.post('/settings/llm_config', data),
  // 获取 LLM 配置
  getLLMConfig: () => api.get('/settings/llm_config'),
  // 测试 LLM 连接
  testConnection: () => api.post('/settings/test_connection')
}

// 提醒相关 API
export const remindersAPI = {
  // 获取即将到来的提醒
  getUpcomingReminders: (settings = {}, signal) => api.post('/reminders/upcoming', { settings }, { ...(signal ? { signal } : {}) })
}

export default api
