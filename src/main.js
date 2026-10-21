import { createApp } from 'vue'
import { createPinia } from 'pinia'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'

import './styles/index.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

// 组件与 ElMessage 等 API 由 unplugin 按需自动导入（见 vite.config.js），此处只全局注册图标，
// 模板中直接写 <el-icon><House /></el-icon> 即可。中文 locale 由 App.vue 的 el-config-provider 提供。
// 图标为纯 SVG 渲染函数，体量很小，全量注册换来的是模板里零 import 的心智负担。
for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component)
}

app.mount('#app')
