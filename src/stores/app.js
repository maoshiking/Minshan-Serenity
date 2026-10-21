import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * 应用级全局状态。后续按模块继续拆：user.js / scene.js 等。
 */
export const useAppStore = defineStore('app', () => {
  const appName = ref('Minshan Serenity')
  const ready = ref(false)

  const title = computed(() => appName.value)

  function markReady() {
    ready.value = true
  }

  return { appName, ready, title, markReady }
})
