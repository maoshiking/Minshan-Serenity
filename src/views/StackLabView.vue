<script setup>
import { computed, ref, watch } from 'vue'
import * as THREE from 'three'
import { ElMessage } from 'element-plus'
import { useThreeStage } from '@/composables/useThreeStage'
import { fetchHealth } from '@/api/common'

const canvasHost = ref(null)
const running = ref(true)

const { error, start, stop } = useThreeStage({
  container: canvasHost,
  enabled: running,
  setup({ scene, camera, renderer }) {
    camera.position.set(0, 1.1, 5.6)
    camera.lookAt(0, 0, 0)

    const key = new THREE.DirectionalLight(0xfff4e8, 2.2)
    key.position.set(3, 4, 5)
    scene.add(key)

    const fill = new THREE.DirectionalLight(0xc9d8d2, 0.9)
    fill.position.set(-4, -2, -3)
    scene.add(fill)

    scene.add(new THREE.AmbientLight(0xffffff, 0.5))

    const group = new THREE.Group()
    scene.add(group)

    const knot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(1, 0.3, 160, 24),
      new THREE.MeshStandardMaterial({
        color: 0x2f5d50,
        roughness: 0.35,
        metalness: 0.25,
        flatShading: true,
      }),
    )
    group.add(knot)

    const wire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.1, 1),
      new THREE.MeshBasicMaterial({ color: 0xc2703d, wireframe: true, transparent: true, opacity: 0.18 }),
    )
    group.add(wire)

    renderer.setClearColor(0x000000, 0)

    return { group, knot, wire }
  },
  update({ delta, state }) {
    if (!state) return
    state.group.rotation.y += delta * 0.4
    state.knot.rotation.x += delta * 0.55
    state.wire.rotation.z -= delta * 0.15
  },
})

watch(error, (err) => {
  if (err) {
    ElMessage.error(`WebGL 初始化失败：${err.message}，请检查浏览器是否启用硬件加速`)
  }
})

async function ping() {
  try {
    const data = await fetchHealth()
    ElMessage.success(`/api/health 返回：${JSON.stringify(data)}`)
  } catch (err) {
    // 后端未启动时走到这里，属预期：说明 axios 链路本身是通的
    ElMessage.warning(`请求链路正常但接口不可用：${err.message}`)
  }
}

const statusText = computed(() => {
  if (error.value) return 'WebGL 不可用'
  return running.value ? '渲染中' : '已暂停'
})
</script>

<template>
  <div class="lab">
    <header class="lab-head">
      <p class="eyebrow">开发期自检页</p>
      <h1>技术栈自检</h1>
      <p class="lede">
        这一页只为确认底座可用：Element Plus 组件与图标、Pinia 状态、Axios 请求层、Three.js WebGL 渲染。
        验证完可以直接删掉本页与对应路由。
      </p>
    </header>

    <el-container class="layout">
      <el-main class="stage-wrap">
        <div ref="canvasHost" class="stage">
          <p v-if="error" class="stage-fallback">WebGL 不可用，画布未创建</p>
        </div>
        <p class="stage-tip">拖动画布无交互，仅自动旋转；切换开关验证 requestAnimationFrame 的启停清理。</p>
      </el-main>

      <el-aside width="280px" class="panel">
        <el-card shadow="never" class="panel-card">
          <template #header>
            <span>运行状态</span>
          </template>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="渲染器">{{ statusText }}</el-descriptions-item>
            <el-descriptions-item label="动画帧">{{ running ? '运行' : '暂停' }}</el-descriptions-item>
            <el-descriptions-item label="请求基址">/api</el-descriptions-item>
          </el-descriptions>

          <div class="panel-actions">
            <el-switch v-model="running" active-text="动画" inline-prompt />
            <el-button size="small" plain @click="ping">
              <el-icon><Connection /></el-icon>
              <span>测试 /api/health</span>
            </el-button>
          </div>
        </el-card>

        <el-card shadow="never" class="panel-card">
          <template #header>
            <span>路由跳转</span>
          </template>
          <el-space wrap>
            <el-button size="small" @click="$router.push({ name: 'home' })">
              <el-icon><Back /></el-icon>
              <span>返回首页</span>
            </el-button>
            <el-button size="small" @click="$router.push({ name: 'not-found', params: { pathMatch: ['definitely-missing'] } })">
              <el-icon><Warning /></el-icon>
              <span>触发 404</span>
            </el-button>
          </el-space>
        </el-card>
      </el-aside>
    </el-container>
  </div>
</template>

<style scoped>
.lab {
  max-width: 1080px;
  margin: 0 auto;
  padding: 56px 24px 80px;
}

.lab-head {
  max-width: 680px;
}

.eyebrow {
  margin: 0 0 10px;
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ms-accent);
}

h1 {
  margin: 0 0 12px;
  font-size: clamp(26px, 4vw, 38px);
  letter-spacing: -0.02em;
}

.lede {
  margin: 0;
  color: var(--ms-text-muted);
}

.layout {
  margin-top: 32px;
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.stage-wrap {
  padding: 0;
  flex: 1;
  min-width: 0;
}

.stage {
  position: relative;
  height: 420px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-lg);
  background: linear-gradient(160deg, #fdfcfa 0%, #e9e5de 100%);
  overflow: hidden;
}

.stage canvas {
  display: block;
}

.stage-fallback {
  position: absolute;
  inset: 0;
  margin: 0;
  display: grid;
  place-items: center;
  color: var(--ms-text-muted);
}

.stage-tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--ms-text-muted);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-card {
  border-radius: var(--ms-radius-lg);
}

.panel-actions {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}
</style>
