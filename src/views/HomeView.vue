<script setup>
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

// 最小加载态，避免 async 组件切换时白屏闪烁
const loading = ref(true)

onMounted(() => {
  appStore.markReady()
  loading.value = false
})

const stack = computed(() => [
  { label: 'Vue', value: '3.5.42', note: '组合式 API + script setup' },
  { label: 'Vite', value: '8.3.4', note: '构建与开发服务器' },
  { label: 'Pinia', value: '4.0.3', note: '按模块划分 store' },
  { label: 'Vue Router', value: '5.3.1', note: 'createWebHistory' },
  { label: 'Element Plus', value: '2.14.7', note: '按需导入 + 中文 locale' },
  { label: 'Three.js', value: '0.186.1', note: '3D 场景渲染' },
  { label: 'Axios', value: '1.20.0', note: '统一封装于 utils/request.js' },
])
</script>

<template>
  <div v-loading="loading" class="home">
    <header class="hero">
      <p class="eyebrow">项目骨架已就绪</p>
      <h1>{{ appStore.title }}</h1>
      <p class="lede">
        依赖、目录结构、请求层与三维舞台底座已经搭好。下一步要做什么，等你定方向。
      </p>
      <div class="actions">
        <el-button type="primary" @click="$router.push({ name: 'terrain' })">
          <el-icon><Location /></el-icon>
          <span>打开水磨古镇三维地形</span>
        </el-button>
        <el-button plain @click="$router.push({ name: 'lab' })">
          <el-icon><Monitor /></el-icon>
          <span>技术栈自检</span>
        </el-button>
      </div>
    </header>

    <section class="grid">
      <article v-for="item in stack" :key="item.label" class="card">
        <p class="card-label">{{ item.label }}</p>
        <p class="card-value">{{ item.value }}</p>
        <p class="card-note">{{ item.note }}</p>
      </article>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 1080px;
  margin: 0 auto;
  padding: 72px 24px 96px;
  min-height: 100%;
}

.hero {
  max-width: 640px;
}

.eyebrow {
  margin: 0 0 12px;
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ms-accent);
}

h1 {
  margin: 0 0 16px;
  font-size: clamp(32px, 6vw, 52px);
  line-height: 1.1;
  letter-spacing: -0.02em;
  font-weight: 600;
}

.lede {
  margin: 0 0 28px;
  color: var(--ms-text-muted);
  font-size: 16px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.grid {
  margin-top: 64px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}

.card {
  padding: 18px 20px;
  background: var(--ms-surface);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-lg);
  transition:
    transform 0.35s var(--ms-ease-out),
    border-color 0.35s var(--ms-ease-out);
}

.card:hover {
  transform: translateY(-3px);
  border-color: var(--ms-primary);
}

.card-label {
  margin: 0;
  font-size: 13px;
  color: var(--ms-text-muted);
}

.card-value {
  margin: 4px 0 8px;
  font-family: var(--ms-font-mono);
  font-size: 20px;
  font-weight: 600;
}

.card-note {
  margin: 0;
  font-size: 13px;
  color: var(--ms-text-muted);
}
</style>
