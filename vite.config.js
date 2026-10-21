import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    // Vue DevTools 仅开发期需要，不参与生产构建
    vueDevTools({ apply: 'serve' }),
    // Element Plus 按需导入：组合式 API 自动 import
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      // ElMessage / ElMessageBox / ElNotification / ElLoading 等命令式 API
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
      dts: 'src/types/auto-imports.d.ts',
    }),
    // Element Plus 按需导入：模板里的 <el-xxx> 自动注册
    Components({
      // 图标由 main.js 全局注册，这里只解析 element-plus 自身组件
      resolvers: [ElementPlusResolver({ importStyle: 'css' })],
      dts: 'src/types/components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    // 按需导入会带来大量 element-plus 子模块请求，预打包避免开发期请求风暴
    include: ['element-plus', 'axios', 'three'],
  },
  build: {
    // three.js 与 element-plus 体量较大，放宽单 chunk 警告阈值
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Vite 8 底层是 rolldown，manualChunks 仅支持函数形式（对象形式会直接报错）
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('three')) return 'three'
          if (id.includes('element-plus')) return 'element-plus'
        },
      },
    },
  },
})
