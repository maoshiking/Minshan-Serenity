<script setup>
import { computed, ref, shallowRef, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useThreeStage } from '@/composables/useThreeStage'
import { createTerrainWorld } from '@/three/cartoonTerrain'

const stageHost = ref(null)
const labelLayer = ref(null)

/**
 * three 世界实例用 shallowRef：它有几十个 three 对象挂在身上，
 * 走 Vue 的深度响应式会把每一帧的矩阵写入都变成依赖追踪，直接卡死。
 */
const worldRef = shallowRef(null)
const errorText = ref('')

const markers = ref([])
const stats = ref({ seed: 0, resolution: 0, markerCount: 0, routeLength: 0, trees: 0, rocks: 0, triangles: 0 })

const placeEnabled = ref(true)
const routeEnabled = ref(true)
const shadowEnabled = ref(true)
const lightIntensity = ref(2.1)
const resolution = ref(112)

const { error } = useThreeStage({
  container: stageHost,
  setup({ scene, camera, renderer }) {
    const world = createTerrainWorld({
      scene,
      camera,
      renderer,
      labelLayer: labelLayer.value,
      options: { resolution: resolution.value },
      onMarkersChange: (list) => {
        markers.value = list
      },
      onStats: (value) => {
        stats.value = value
      },
    })
    worldRef.value = world
    return { world }
  },
  update({ delta, elapsed, state }) {
    state?.world.update(delta, elapsed)
  },
  teardown({ state }) {
    // 控制器、几何、材质、共享贴图都在这里释放，否则每次进出页面漏一批 WebGL 资源
    state?.world.dispose()
    worldRef.value = null
  },
})

watch(error, (err) => {
  if (err) errorText.value = `WebGL 初始化失败：${err.message}，请检查浏览器是否启用硬件加速`
})

// 面板上的开关直接透传给 three 世界；这些 watcher 只在用户操作时触发
watch(placeEnabled, (v) => worldRef.value?.setPlaceEnabled(v))
watch(routeEnabled, (v) => worldRef.value?.setRouteEnabled(v))
watch(shadowEnabled, (v) => worldRef.value?.setShadowEnabled(v))
watch(lightIntensity, (v) => worldRef.value?.setLightIntensity(v))
watch(resolution, (v) => worldRef.value?.rebuild({ resolution: v }))

function reroll() {
  const seed = Math.floor(Math.random() * 100000000)
  worldRef.value?.rebuild({ seed })
  ElMessage.success(`换了一张地形 · seed ${seed}`)
}

function undo() {
  const last = markers.value.at(-1)
  if (!last) {
    ElMessage.info('还没有标记点')
    return
  }
  worldRef.value?.removeMarker(last.id)
}

function clearAll() {
  if (!markers.value.length) return
  worldRef.value?.clearMarkers()
  ElMessage.success('已清空标记点')
}

const routeText = computed(() =>
  stats.value.routeLength > 0 ? `${stats.value.routeLength.toFixed(0)} 单位` : '—',
)
const triangleText = computed(() => stats.value.triangles.toLocaleString('zh-CN'))
const markerText = computed(() => `${stats.value.markerCount} / ${worldRef.value?.maxMarkers ?? 16}`)
</script>

<template>
  <div class="map-page">
    <section class="stage">
      <div ref="stageHost" class="canvas-host"></div>
      <div ref="labelLayer" class="label-layer"></div>

      <div class="hud hud--top">
        <div class="hud-card">
          <p class="eyebrow">三维卡通地形</p>
          <h1>Minshan Terrain</h1>
          <p class="hud-sub">程序化生成 · 单次落点拾取 · 贴地路线</p>
        </div>
        <div class="hud-actions">
          <el-button size="small" @click="worldRef?.resetView()">
            <el-icon><Refresh /></el-icon>
            <span>重置视角</span>
          </el-button>
          <el-button size="small" type="primary" @click="reroll">
            <el-icon><MagicStick /></el-icon>
            <span>换一张地形</span>
          </el-button>
        </div>
      </div>

      <div class="hud hud--bottom">
        <span>左键拖动旋转</span>
        <i>·</i>
        <span>滚轮缩放</span>
        <i>·</i>
        <span>右键平移</span>
        <i>·</i>
        <span :class="['hint-strong', { 'is-on': placeEnabled }]">单击放置标记</span>
      </div>

      <p v-if="errorText" class="fallback">{{ errorText }}</p>
    </section>

    <aside class="panel">
      <el-card shadow="never" class="panel-card">
        <template #header>
          <span>交互</span>
        </template>

        <div class="field">
          <span class="field-label">点击放置标记</span>
          <el-switch v-model="placeEnabled" />
        </div>
        <div class="field">
          <span class="field-label">显示路线</span>
          <el-switch v-model="routeEnabled" />
        </div>
        <div class="field">
          <span class="field-label">投射阴影</span>
          <el-switch v-model="shadowEnabled" />
        </div>

        <div class="field field--stack">
          <div class="field-head">
            <span class="field-label">光照强度</span>
            <span class="field-value">{{ lightIntensity.toFixed(1) }}</span>
          </div>
          <el-slider v-model="lightIntensity" :min="0.5" :max="4" :step="0.1" :show-tooltip="false" />
        </div>

        <div class="field field--stack">
          <span class="field-label">地形精度</span>
          <el-select v-model="resolution" size="small">
            <el-option :value="72" label="流畅 · 72 格" />
            <el-option :value="112" label="标准 · 112 格" />
            <el-option :value="160" label="精细 · 160 格" />
          </el-select>
        </div>

        <div class="panel-actions">
          <el-button size="small" plain @click="undo">
            <el-icon><Refresh /></el-icon>
            <span>撤销最后一个</span>
          </el-button>
          <el-button size="small" plain @click="clearAll">
            <el-icon><Delete /></el-icon>
            <span>清空标记</span>
          </el-button>
        </div>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <span>地形数据</span>
        </template>
        <el-descriptions :column="1" size="small" border>
          <el-descriptions-item label="随机种子">{{ stats.seed }}</el-descriptions-item>
          <el-descriptions-item label="网格">{{ stats.resolution }} × {{ stats.resolution }}</el-descriptions-item>
          <el-descriptions-item label="三角面">{{ triangleText }}</el-descriptions-item>
          <el-descriptions-item label="树木">{{ stats.trees }}</el-descriptions-item>
          <el-descriptions-item label="岩石">{{ stats.rocks }}</el-descriptions-item>
          <el-descriptions-item label="标记点">{{ markerText }}</el-descriptions-item>
          <el-descriptions-item label="路线长度">{{ routeText }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <span>标记点</span>
        </template>

        <p v-if="!markers.length" class="empty">
          在地形上单击即可落点，从左到右依次编号；两个以上标记点会自动连成贴地路线。
        </p>

        <ul v-else class="marker-list">
          <li v-for="item in markers" :key="item.id">
            <span class="marker-index">{{ item.index }}</span>
            <span class="marker-coord">
              X <b>{{ item.x.toFixed(1) }}</b>
              <em>·</em>
              Z <b>{{ item.z.toFixed(1) }}</b>
            </span>
            <el-button link size="small" @click="worldRef?.focusMarker(item.id)">
              <el-icon><Aim /></el-icon>
              <span>定位</span>
            </el-button>
            <el-button link size="small" @click="worldRef?.removeMarker(item.id)">
              <el-icon><Delete /></el-icon>
            </el-button>
          </li>
        </ul>
      </el-card>

      <el-card shadow="never" class="panel-card">
        <template #header>
          <span>这一页做了什么</span>
        </template>
        <ul class="notes">
          <li>噪声高度场 + 梯田化 + 岛屿衰减，同一个 seed 必然生成同一张地图。</li>
          <li>非索引几何 + 逐面单色单法线，配合卡通阶梯渐变得到块面感，而不是圆滑的塑料山。</li>
          <li>
            落点不走 Raycaster 打七万面，而是在高度场上做光线步进 + 二分收敛，指针移动零卡顿（精度约 0.01）。
          </li>
          <li>路线是贴地飘带：每处取左中右三点地面的最大值再抬高，横向过坎也不会被地形切掉。</li>
          <li>标记编号用 HTML 浮层，文字始终清晰，并且样式不受画布分辨率影响。</li>
        </ul>
      </el-card>
    </aside>
  </div>
</template>

<style scoped>
.map-page {
  display: flex;
  /* 用视口高度而不是百分比：el-config-provider 是否包一层 div 会影响百分比高度的
     解析基准，视口单位则与父链无关，一定撑满。dvh 兼容移动端地址栏收缩。 */
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  background: linear-gradient(180deg, #cfe3ee 0%, #e9eef0 100%);
  overflow: hidden;
}

/* 画布由 useThreeStage 动态插入，用 :deep 才能选中 */
.canvas-host {
  position: absolute;
  inset: 0;
}

.canvas-host :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.label-layer {
  position: absolute;
  inset: 0;
  z-index: 3;
  overflow: hidden;
  /* 默认穿透，只有标记徽章自己开启命中，否则画布收不到事件 */
  pointer-events: none;
}

.hud {
  position: absolute;
  z-index: 4;
  pointer-events: none;
}

.hud--top {
  top: 20px;
  left: 20px;
  right: 20px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.hud--bottom {
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(8px);
  border: 1px solid var(--ms-border);
  font-size: 12px;
  color: var(--ms-text-muted);
  white-space: nowrap;
}

.hud--bottom i {
  font-style: normal;
  opacity: 0.45;
}

.hint-strong {
  color: var(--ms-text-muted);
  transition: color 0.25s var(--ms-ease-out);
}

.hint-strong.is-on {
  color: var(--ms-accent);
  font-weight: 600;
}

.hud-card {
  padding: 12px 18px 14px;
  border-radius: var(--ms-radius-lg);
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: blur(8px);
  border: 1px solid var(--ms-border);
  pointer-events: auto;
}

.eyebrow {
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ms-accent);
}

.hud-card h1 {
  margin: 0;
  font-size: 22px;
  letter-spacing: -0.01em;
}

.hud-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ms-text-muted);
}

.hud-actions {
  display: flex;
  gap: 8px;
  pointer-events: auto;
}

.fallback {
  position: absolute;
  inset: 0;
  margin: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
  color: var(--ms-text-muted);
  background: var(--ms-surface-soft);
}

.panel {
  width: 340px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  overflow-y: auto;
  background: var(--ms-surface);
  border-left: 1px solid var(--ms-border);
}

.panel-card {
  border-radius: var(--ms-radius-lg);
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
}

.field--stack {
  display: block;
  padding-top: 10px;
}

.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-label {
  font-size: 14px;
}

.field-value {
  font-family: var(--ms-font-mono);
  font-size: 13px;
  color: var(--ms-text-muted);
}

.field--stack :deep(.el-select) {
  width: 100%;
  margin-top: 8px;
}

.field--stack :deep(.el-slider) {
  margin-top: 2px;
}

.panel-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.empty {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ms-text-muted);
}

.marker-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.marker-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--ms-radius);
  border: 1px solid var(--ms-border);
}

.marker-index {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  background: var(--ms-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

.marker-coord {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--ms-text-muted);
  white-space: nowrap;
}

.marker-coord b {
  font-family: var(--ms-font-mono);
  font-weight: 600;
  color: var(--ms-text);
}

.marker-coord em {
  font-style: normal;
  margin: 0 3px;
  opacity: 0.5;
}

.notes {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--ms-text-muted);
}

@media (max-width: 900px) {
  .map-page {
    flex-direction: column-reverse;
    overflow-y: auto;
  }

  .stage {
    flex: none;
    height: 58vh;
  }

  .panel {
    width: auto;
    border-left: none;
    border-bottom: 1px solid var(--ms-border);
  }

  .hud--top {
    left: 12px;
    right: 12px;
    top: 12px;
  }

  .hud-sub {
    display: none;
  }
}
</style>

<!--
  标记标签是 JS 动态创建的（appendChild 到 label-layer），不在模板里，
   scoped 样式加不上 data-v 属性，所以这部分必须是全局样式。
-->
<style>
.terrain-marker {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: auto;
  cursor: pointer;
  /* JS 每帧改写 transform，提前提示浏览器单独合成这一层 */
  will-change: transform;
}

.terrain-marker__badge {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--ms-accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  font-family: var(--ms-font-mono);
  border: 2px solid rgba(255, 255, 255, 0.92);
  box-shadow: 0 3px 8px rgba(35, 33, 30, 0.3);
  transition: transform 0.22s var(--ms-ease-out);
}

.terrain-marker:hover .terrain-marker__badge {
  transform: scale(1.18);
}

.terrain-marker__tip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 9px;
  border-radius: 7px;
  background: rgba(35, 33, 30, 0.88);
  color: #fff;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s var(--ms-ease-out);
}

.terrain-marker:hover .terrain-marker__tip {
  opacity: 1;
}
</style>
