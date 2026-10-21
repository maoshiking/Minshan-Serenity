<script setup>
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

const missingPath = Array.isArray(route.params.pathMatch)
  ? route.params.pathMatch.join('/')
  : String(route.params.pathMatch ?? '')
</script>

<template>
  <div class="not-found">
    <el-result icon="warning" title="404" :sub-title="`没有找到 /${missingPath} 这个页面`">
      <template #extra>
        <el-button type="primary" @click="router.replace({ name: 'home' })">
          <el-icon><HomeFilled /></el-icon>
          <span>回到首页</span>
        </el-button>
      </template>
    </el-result>
  </div>
</template>

<style scoped>
.not-found {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 48px 24px;
}
</style>
