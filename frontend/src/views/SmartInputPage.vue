<template>
  <div class="smart-input-page">
    <div class="page-content">
      <!-- 智能输入面板 -->
      <section class="input-section">
        <SmartInput />
      </section>
      
      <!-- 剪切板队列面板 -->
      <section class="clipboard-section">
        <ClipboardQueue @use-clipboard-item="handleUseClipboardItem" />
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import SmartInput from '../components/SmartInput.vue'
import ClipboardQueue from '../components/ClipboardQueue.vue'
import { useClipboardStore } from '../store'

const emit = defineEmits(['go-back'])
const clipboardStore = useClipboardStore()

// 计算属性：获取剪切板队列
const clipboardQueue = computed(() => clipboardStore.clipboardQueue)

// 返回主页
const goBack = () => {
  emit('go-back')
}

// 处理使用剪切板内容
const handleUseClipboardItem = (text) => {
  console.log('使用剪切板内容:', text)
  // 这里可以添加将内容传递给智能输入组件的逻辑
  // 由于智能输入组件是子组件，需要通过事件或状态管理来传递数据
  // 暂时只打印日志，后续可以扩展
}
</script>

<style scoped>
.smart-input-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background-color: var(--bg-primary);
}

.page-content {
  flex: 1;
  padding: 1.5rem;
  display: flex;
  gap: 1.5rem;
  align-items: stretch;
  min-height: 0; /* 允许 flex 子项缩小 */
  overflow: hidden;
}

/* 智能输入面板样式 */
.input-section {
  flex: 1;
  background-color: var(--bg-secondary);
  border-radius: 8px;
  box-shadow: 0 2px 8px var(--shadow-color);
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 剪切板队列面板样式 */
.clipboard-section {
  flex: 1;
  background-color: var(--bg-secondary);
  border-radius: 8px;
  box-shadow: 0 2px 8px var(--shadow-color);
  padding: 1.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  min-width: 350px;
}

/* 响应式设计 */
@media (max-width: 1024px) {
  .page-content {
    flex-direction: column;
  }
  
  .clipboard-section {
    width: 100%;
    max-width: 100%;
  }
}
</style>