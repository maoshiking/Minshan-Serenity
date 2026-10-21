import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import * as THREE from 'three'

/**
 * three.js 舞台生命周期封装：负责 WebGLRenderer / Scene / PerspectiveCamera 的
 * 创建、尺寸自适应与销毁。业务侧只关心 setup 与每帧的 update。
 *
 * 注意：用浅层 ref 持有 three 实例，避免 Vue 深度代理 WebGL 对象导致性能塌陷。
 * setup 返回的对象（Group / Mesh / 控制器等）会原样透传给 update，不要在组件里另建 ref 搬运。
 *
 * @param {object} options
 * @param {import('vue').Ref<HTMLElement|null>} options.container 画布挂载节点
 * @param {(ctx: object) => any} [options.setup] 初始化场景内容，返回值作为 update 的第四个参数
 * @param {(ctx: object) => void} [options.update] 每帧回调，ctx 含 scene/camera/renderer/delta/elapsed/state
 * @param {(ctx: object) => void} [options.teardown] 卸载前的清理回调，早于 renderer.dispose 执行。
 *   控制器、事件监听、材质等 setup 里申请的资源都在这里释放
 * @param {import('vue').Ref<boolean>} [options.enabled] 为 false 时暂停渲染循环
 * @param {boolean} [options.autoStart] 是否挂载后自动开始渲染，默认 true
 */
export function useThreeStage(options = {}) {
  const { container, setup, update, teardown, enabled, autoStart = true } = options

  const scene = shallowRef(null)
  const camera = shallowRef(null)
  const renderer = shallowRef(null)
  const running = shallowRef(false)
  const error = shallowRef(null)

  // setup 的返回值，仅内部持有，不参与响应式
  let state = null
  let frameId = 0
  let resizeObserver = null
  let clock = null

  function tick() {
    frameId = requestAnimationFrame(tick)
    const delta = clock.getDelta()
    update?.({
      scene: scene.value,
      camera: camera.value,
      renderer: renderer.value,
      delta,
      elapsed: clock.elapsedTime,
      state,
    })
    renderer.value.render(scene.value, camera.value)
  }

  function start() {
    if (running.value || !renderer.value) return
    running.value = true
    clock = new THREE.Clock()
    frameId = requestAnimationFrame(tick)
  }

  function stop() {
    running.value = false
    if (frameId) cancelAnimationFrame(frameId)
    frameId = 0
  }

  function resize() {
    const el = container.value
    if (!el || !renderer.value || !camera.value) return
    const width = el.clientWidth || 1
    const height = el.clientHeight || 1
    camera.value.aspect = width / height
    camera.value.updateProjectionMatrix()
    renderer.value.setSize(width, height, false)
  }

  onMounted(() => {
    const el = container.value
    if (!el) {
      error.value = new Error('useThreeStage: container 未就绪')
      return
    }

    try {
      scene.value = new THREE.Scene()
      camera.value = new THREE.PerspectiveCamera(45, 1, 0.1, 200)
      camera.value.position.set(0, 0.6, 6)

      renderer.value = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.value.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      el.appendChild(renderer.value.domElement)

      resize()
      state = setup?.({ scene: scene.value, camera: camera.value, renderer: renderer.value }) ?? null

      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(el)

      if (autoStart) start()
    } catch (err) {
      // WebGL 不可用（禁用硬件加速 / 无显卡）时不让整页崩掉
      error.value = err
    }
  })

  onBeforeUnmount(() => {
    stop()
    resizeObserver?.disconnect()
    resizeObserver = null

    // 先让业务侧释放自己的资源（控制器、几何、材质），此时 renderer 还活着，
    // 拿得到 WebGL 上下文去做最后一步清理
    try {
      teardown?.({ scene: scene.value, camera: camera.value, renderer: renderer.value, state })
    } catch (err) {
      console.warn('[useThreeStage] teardown 抛出异常，已忽略：', err)
    }

    const rendererInstance = renderer.value
    if (rendererInstance) {
      rendererInstance.domElement.remove()
      rendererInstance.dispose()
    }

    state = null
    scene.value = null
    camera.value = null
    renderer.value = null
  })

  // 外部开关切换时同步暂停 / 恢复
  if (enabled) {
    watch(enabled, (value) => {
      value ? start() : stop()
    })
  }

  return { scene, camera, renderer, running, error, start, stop, resize }
}
