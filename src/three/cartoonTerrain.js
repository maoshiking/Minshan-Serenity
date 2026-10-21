import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createHeightField, DEFAULT_TERRAIN_OPTIONS } from './heightField.js'
import { buildTerrainGeometry, createToonGradientMap, SKIRT_DEPTH_FACTOR } from './terrainMesh.js'
import { raycastField } from './picking.js'
import { buildRoutePoints, buildRouteRibbon, createDashTexture } from './route.js'
import { createForest, createRocks, createSkyDome, createWater } from './scenery.js'

/**
 * 卡通地形地图的编排层：把高度场、几何、装饰、交互、标记和路线拧成一个可直接驱动的东西。
 *
 * 设计取舍：
 * - 拾取不走 Raycaster 打网格，而是 raycastField 在高度场上解析求解（见 picking.js）
 * - 标记编号用 HTML 浮层而非 3D 文字：文字始终清晰、还能直接用 CSS 做交互态
 * - 共享资源（卡通渐变、虚线贴图、标记几何）在实例内创建一次，随实例统一销毁
 */

const UP = new THREE.Vector3(0, 1, 0)
const ACCENT = '#c2703d'

/**
 * 画面观感参数集中在这里。
 *
 * 抽出来的实际原因：离线预览渲染器（scripts/preview/soft-render.mjs）要用同一份数值，
 * 否则"预览图"与"真实场景"会变成两份各自漂移的抄本，预览就失去意义了。
 */
export const SCENE_LOOK = {
  /** 主光：方向 = keyDirection 归一化，相对原点的位置由它决定。
   *  仰角刻意压在 ~38°：太阳更高时阴影长度超不过地形高差，画面上几乎看不到投影，
   *  地形会显得很平。压低之后山脊的投影才拉得出来。 */
  keyColor: '#fff3e0',
  keyIntensity: 2.1,
  keyDirection: [0.58, 0.62, 0.53],
  /** 半球补光：天空色 / 地面反弹色 */
  hemisphereSky: '#cfe6f2',
  hemisphereGround: '#8a9a72',
  hemisphereIntensity: 1.35,
  /** 雾：以地图边长 size 为单位 */
  fogColor: '#e8eff3',
  fogNearFactor: 1.5,
  fogFarFactor: 4.2,
  /** 相机：fov、观察方向（会被归一化、只取方向）、以及包围盒占画面的目标比例 */
  fov: 46,
  cameraOffset: [0.62, 0.47, 0.86],
  frameFill: 0.9,
  targetHeightFactor: 0.35,
  accent: ACCENT,
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v
}

export function frameTerrainCamera(camera, { size, heightScale, aspect = 1, fill = SCENE_LOOK.frameFill }) {
  const target = new THREE.Vector3(0, heightScale * SCENE_LOOK.targetHeightFactor, 0)
  const direction = new THREE.Vector3(...SCENE_LOOK.cameraOffset).normalize()
  const probe = new THREE.Vector3()

  // 沙盘包围盒的八个角。必须把底座那一截算进去，否则近角会被裁掉
  const half = size / 2
  const corners = []
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      for (const y of [-heightScale * SKIRT_DEPTH_FACTOR, heightScale]) corners.push(new THREE.Vector3(x, y, z))
    }
  }

  camera.fov = SCENE_LOOK.fov
  camera.aspect = aspect
  camera.updateProjectionMatrix()

  /*
   * 按宽高比反求相机距离，使包围盒刚好落在 fill 比例内。
   *
   * 必须跟宽高比走：固定距离在窄窗口会把地图切掉，在宽窗口又把地图缩成一小块。
   * 用迭代而非解析式，是因为透视下"最大 NDC"与距离并非严格成反比——近处的角会被放大，
   * 简单按 1/距离 缩放会系统性偏小。
   */
  let distance = size * 1.5
  for (let iteration = 0; iteration < 6; iteration++) {
    camera.position.copy(target).addScaledVector(direction, distance)
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()

    let maxAbs = 0
    for (const corner of corners) {
      probe.copy(corner).project(camera)
      maxAbs = Math.max(maxAbs, Math.abs(probe.x), Math.abs(probe.y))
    }
    if (maxAbs < 1e-6) break
    distance *= maxAbs / fill
  }

  camera.position.copy(target).addScaledVector(direction, distance)
  camera.lookAt(target)
  camera.updateMatrixWorld(true)
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
  return distance
}

export function createTerrainWorld({
  scene,
  camera,
  renderer,
  labelLayer,
  options = {},
  onMarkersChange,
  onStats,
}) {
  // ---------- 共享资源 ----------
  const toonGradient = createToonGradientMap()
  const dashTexture = createDashTexture()

  const root = new THREE.Group()
  scene.add(root)

  let currentOptions = { ...DEFAULT_TERRAIN_OPTIONS, ...options }
  const size = currentOptions.size

  // ---------- 天空 / 雾 / 光照 ----------
  const sky = createSkyDome({ radius: Math.max(size * 5, 400) })
  root.add(sky)

  const fogColor = new THREE.Color(SCENE_LOOK.fogColor)
  // 雾的起止按地图自身尺度给，而不是按相机距离：相机默认距离约 1.75×size，
  // 若把 near 设成 size 级，整张图会被雾洗淡。这里让近角完全无雾、远角只压 ~20%，
  // 边缘自然融进地平线，而近处观感不受影响。
  scene.fog = new THREE.Fog(fogColor, size * SCENE_LOOK.fogNearFactor, size * SCENE_LOOK.fogFarFactor)

  const hemisphere = new THREE.HemisphereLight(
    SCENE_LOOK.hemisphereSky,
    SCENE_LOOK.hemisphereGround,
    SCENE_LOOK.hemisphereIntensity,
  )
  root.add(hemisphere)

  const key = new THREE.DirectionalLight(SCENE_LOOK.keyColor, SCENE_LOOK.keyIntensity)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0005
  key.shadow.normalBias = 0.1
  key.position.set(
    size * SCENE_LOOK.keyDirection[0],
    size * SCENE_LOOK.keyDirection[1],
    size * SCENE_LOOK.keyDirection[2],
  )
  root.add(key)
  root.add(key.target)

  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  function updateShadowCamera() {
    const extent = size * 0.8
    const cam = key.shadow.camera
    cam.left = -extent
    cam.right = extent
    cam.top = extent
    cam.bottom = -extent
    cam.near = 1
    cam.far = size * 3
    cam.updateProjectionMatrix()
  }
  updateShadowCamera()

  // ---------- 相机 / 控制器 ----------
  const defaultTarget = () => new THREE.Vector3(0, currentOptions.heightScale * SCENE_LOOK.targetHeightFactor, 0)

  camera.fov = SCENE_LOOK.fov
  camera.near = 0.5
  camera.far = size * 8
  camera.updateProjectionMatrix()

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = size * 0.35
  controls.maxDistance = size * 4
  controls.minPolarAngle = 0.08
  // 卡住俯仰下限：钻到地图底下看穿帮对谁都没好处
  controls.maxPolarAngle = 1.35

  /**
   * 应用默认取景。用当前宽高比现算，所以"重置视角"在任何窗口尺寸下都好看。
   */
  function applyDefaultView() {
    frameTerrainCamera(camera, {
      size,
      heightScale: currentOptions.heightScale,
      aspect: camera.aspect || 1,
    })
    controls.target.copy(defaultTarget())
    controls.update()
  }

  applyDefaultView()

  // ---------- 地形与装饰 ----------
  let field = null
  let terrainGroup = null
  let terrainMesh = null
  let water = null
  let forest = null
  let rocks = null

  function buildTerrain() {
    field = createHeightField(currentOptions)

    terrainGroup = new THREE.Group()
    root.add(terrainGroup)

    const geometry = buildTerrainGeometry(field, { skirtDepth: field.heightScale * SKIRT_DEPTH_FACTOR })
    const material = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: toonGradient,
      // 侧壁与底面的缠绕顺序不必逐一验算，双面渲染直接免疫这个问题
      side: THREE.DoubleSide,
      // 但阴影必须只从朝上的正面生成，否则双面会自遮挡出满屏条纹
      shadowSide: THREE.FrontSide,
    })
    terrainMesh = new THREE.Mesh(geometry, material)
    terrainMesh.castShadow = true
    terrainMesh.receiveShadow = true
    terrainGroup.add(terrainMesh)

    water = createWater(field, { gradientMap: toonGradient })
    terrainGroup.add(water.mesh)

    forest = createForest(field, { gradientMap: toonGradient })
    terrainGroup.add(forest.group)

    rocks = createRocks(field, { gradientMap: toonGradient })
    terrainGroup.add(rocks.group)
  }

  /** 只销毁几何与材质；贴图是共享的，由实例统一销毁，避免重复释放 */
  function disposeSubtree(object) {
    const geometries = new Set()
    const materials = new Set()
    object.traverse((node) => {
      if (node.geometry) geometries.add(node.geometry)
      if (node.material) {
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.add(m)
      }
    })
    for (const g of geometries) g.dispose()
    for (const m of materials) m.dispose()
  }

  function disposeTerrain() {
    if (!terrainGroup) return
    water?.dispose()
    forest?.dispose()
    rocks?.dispose()
    disposeSubtree(terrainGroup)
    root.remove(terrainGroup)
    terrainGroup = null
    terrainMesh = null
    water = null
    forest = null
    rocks = null
  }

  // ---------- 标记点资源 ----------
  const markerGeometry = {
    ring: new THREE.RingGeometry(1.15, 1.52, 28).rotateX(-Math.PI / 2),
    tip: new THREE.ConeGeometry(0.52, 1.3, 12).rotateX(Math.PI).translate(0, 0.8, 0),
    head: new THREE.SphereGeometry(0.6, 14, 10).translate(0, 1.7, 0),
  }
  const markerMaterial = {
    ring: new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    body: new THREE.MeshToonMaterial({ color: ACCENT, gradientMap: toonGradient }),
  }

  const markers = []
  let markerIdSeq = 0
  const MAX_MARKERS = 16

  // ---------- 悬停指示器 ----------
  const hoverGroup = new THREE.Group()
  const hoverDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1.6, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  const hoverRing = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1.2, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  hoverGroup.add(hoverDisc, hoverRing)
  hoverGroup.visible = false
  root.add(hoverGroup)

  // ---------- 路线 ----------
  let routeMesh = null
  let routeLength = 0
  let routeEnabled = true

  function disposeRoute() {
    if (!routeMesh) return
    root.remove(routeMesh)
    routeMesh.geometry.dispose()
    routeMesh.material.dispose()
    routeMesh = null
    routeLength = 0
  }

  function rebuildRoute() {
    disposeRoute()
    if (!routeEnabled || markers.length < 2) {
      emit()
      return
    }

    const points = buildRoutePoints(markers.map((m) => ({ x: m.x, z: m.z })))
    const built = buildRouteRibbon(field, points, { width: 1.9, lift: 0.5 })
    if (!built) {
      emit()
      return
    }

    routeLength = built.length
    // 虚线按弧长铺：不管路线多长，箭头在世界空间里都是同样间距
    dashTexture.repeat.set(Math.max(1, Math.round(built.length / 5)), 1)

    const material = new THREE.MeshBasicMaterial({
      map: dashTexture,
      color: ACCENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    })

    routeMesh = new THREE.Mesh(built.geometry, material)
    routeMesh.renderOrder = 5
    root.add(routeMesh)
    emit()
  }

  // ---------- 标记点 ----------
  function createLabelElement(marker) {
    const el = document.createElement('div')
    el.className = 'terrain-marker'
    const badge = document.createElement('span')
    badge.className = 'terrain-marker__badge'
    el.appendChild(badge)

    const tip = document.createElement('span')
    tip.className = 'terrain-marker__tip'
    el.appendChild(tip)

    el.addEventListener('pointerenter', () => el.classList.add('is-hover'))
    el.addEventListener('pointerleave', () => el.classList.remove('is-hover'))
    // 点标签 = 飞过去看。标签自己有 pointer-events，所以不会顺手在地图上多打一个标记
    el.addEventListener('click', () => flyTo(marker))
    labelLayer?.appendChild(el)
    marker.el = el
    marker.badge = badge
    marker.tip = tip
  }

  function refreshLabels() {
    markers.forEach((marker, index) => {
      if (marker.badge) marker.badge.textContent = String(index + 1)
      if (marker.tip) {
        marker.tip.textContent = `X ${marker.x.toFixed(1)} · Z ${marker.z.toFixed(1)} · 点击定位`
      }
    })
  }

  function snapshot() {
    return markers.map((m, index) => ({
      id: m.id,
      index: index + 1,
      x: m.x,
      z: m.z,
      y: m.y,
    }))
  }

  function emit() {
    onMarkersChange?.(snapshot())
    onStats?.(getStats())
  }

  function addMarker(x, z) {
    if (markers.length >= MAX_MARKERS) return null

    const y = field.worldHeight(x, z)
    const group = new THREE.Group()
    group.position.set(x, y, z)

    const ring = new THREE.Mesh(markerGeometry.ring, markerMaterial.ring)
    const pin = new THREE.Group()
    pin.add(new THREE.Mesh(markerGeometry.tip, markerMaterial.body))
    pin.add(new THREE.Mesh(markerGeometry.head, markerMaterial.body))
    group.add(ring, pin)
    root.add(group)

    const marker = {
      id: ++markerIdSeq,
      x,
      z,
      y,
      group,
      ring,
      pin,
      // 落点动画从这个时刻开始计时
      createdAt: elapsedTime,
    }
    createLabelElement(marker)
    markers.push(marker)
    refreshLabels()
    rebuildRoute()
    return marker
  }

  function removeMarker(id) {
    const index = markers.findIndex((m) => m.id === id)
    if (index === -1) return false
    const [marker] = markers.splice(index, 1)
    root.remove(marker.group)
    marker.el?.remove()
    refreshLabels()
    rebuildRoute()
    return true
  }

  function clearMarkers() {
    for (const marker of markers) {
      root.remove(marker.group)
      marker.el?.remove()
    }
    markers.length = 0
    refreshLabels()
    rebuildRoute()
  }

  /** 换地形后把已有标记重新贴回地面，而不是粗暴清空 */
  function resnapMarkers() {
    for (const marker of markers) {
      marker.y = field.worldHeight(marker.x, marker.z)
      marker.group.position.y = marker.y
    }
    rebuildRoute()
  }

  // ---------- 交互 ----------
  const dom = renderer.domElement
  const raycaster = new THREE.Raycaster()
  let pointerNdc = null
  let pointerInside = false
  let pointerDownAt = null
  let placeEnabled = true
  let cursor = ''

  function toNdc(event) {
    const rect = dom.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    }
  }

  function pick(ndc) {
    raycaster.setFromCamera(ndc, camera)
    return raycastField(field, raycaster.ray, { maxDistance: size * 4 })
  }

  function onPointerMove(event) {
    pointerInside = true
    pointerNdc = toNdc(event)
  }

  function onPointerLeave() {
    pointerInside = false
    pointerNdc = null
    hoverGroup.visible = false
  }

  function onPointerDown(event) {
    if (event.button !== 0) return
    pointerDownAt = { x: event.clientX, y: event.clientY }
  }

  function onPointerUp(event) {
    if (event.button !== 0 || !pointerDownAt) return
    const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y)
    pointerDownAt = null
    // 拖动是在转视角，不是点击落点
    if (moved > 5 || !placeEnabled) return
    const hit = pick(toNdc(event))
    if (!hit) return
    addMarker(hit.point.x, hit.point.z)
  }

  dom.addEventListener('pointermove', onPointerMove)
  dom.addEventListener('pointerleave', onPointerLeave)
  dom.addEventListener('pointerdown', onPointerDown)
  dom.addEventListener('pointerup', onPointerUp)

  // ---------- 相机飞行 ----------
  let fly = null

  function flyTo(point) {
    const toTarget = new THREE.Vector3(point.x, point.y, point.z)
    const offset = new THREE.Vector3(0.5, 0.72, 0.85).normalize().multiplyScalar(size * 0.5)
    fly = {
      t: 0,
      fromTarget: controls.target.clone(),
      toTarget,
      fromCam: camera.position.clone(),
      toCam: toTarget.clone().add(offset),
    }
  }

  function resetView() {
    fly = null
    applyDefaultView()
  }

  function updateFly(delta) {
    if (!fly) return
    fly.t = Math.min(1, fly.t + delta / 0.7)
    const e = 1 - Math.pow(1 - fly.t, 3)
    controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e)
    camera.position.lerpVectors(fly.fromCam, fly.toCam, e)
    if (fly.t >= 1) fly = null
  }

  // ---------- HTML 标签跟随 ----------
  const projected = new THREE.Vector3()

  function updateLabels() {
    if (!labelLayer) return
    const width = dom.clientWidth || 1
    const height = dom.clientHeight || 1

    // 投影用的是上一帧的矩阵，这里先手动补齐，否则标签会滞后一帧地"飘"
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()

    for (const marker of markers) {
      if (!marker.el) continue
      projected.set(marker.x, marker.y + 2.9, marker.z).project(camera)
      const visible = projected.z < 1
      if (!visible) {
        if (marker.el.style.display !== 'none') marker.el.style.display = 'none'
        continue
      }
      if (marker.el.style.display === 'none') marker.el.style.display = ''
      const px = (projected.x * 0.5 + 0.5) * width
      const py = (-projected.y * 0.5 + 0.5) * height
      marker.el.style.transform = `translate(-50%, -100%) translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`
    }
  }

  // ---------- 主循环 ----------
  let elapsedTime = 0

  function update(delta, elapsed) {
    elapsedTime = elapsed

    updateFly(delta)

    // 平移范围收在地图附近，别把地形推出画面找不回来。
    // 必须在 controls.update() 之前钳制：update() 会用 target 反算相机位置，
    // 放在后面会让相机比 target 慢一帧，快速平移时看得出抖。
    const limit = size * 0.45
    controls.target.x = clamp(controls.target.x, -limit, limit)
    controls.target.z = clamp(controls.target.z, -limit, limit)
    controls.target.y = clamp(controls.target.y, -currentOptions.heightScale * 0.5, currentOptions.heightScale * 1.5)
    controls.update()

    water?.update(delta, elapsed)

    // 虚线流动：offset.x 递减 → 图案朝 +u 方向走，也就是从起点流向终点
    if (routeMesh) dashTexture.offset.x -= delta * 0.35

    for (const marker of markers) {
      const t = Math.min(1, (elapsed - marker.createdAt) / 0.55)
      // easeOutBack：落地时轻微过冲，砸下去的那一下才有分量
      const c1 = 1.70158
      const c3 = c1 + 1
      const eased = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
      marker.pin.position.y = (1 - clamp(eased, 0, 1.08)) * 7
      marker.pin.scale.setScalar(0.45 + 0.55 * clamp(eased, 0, 1))
      marker.ring.scale.setScalar(1 + Math.sin(elapsed * 2.2 + marker.id) * 0.07)
    }

    updateHover(delta)
    updateLabels()
  }

  let hoverPhase = 0
  function updateHover(delta) {
    if (!pointerInside || !pointerNdc) {
      hoverGroup.visible = false
      if (cursor !== 'default') {
        dom.style.cursor = 'default'
        cursor = 'default'
      }
      return
    }

    const hit = pick(pointerNdc)
    if (!hit) {
      hoverGroup.visible = false
      if (cursor !== 'default') {
        dom.style.cursor = 'default'
        cursor = 'default'
      }
      return
    }

    hoverPhase += delta
    hoverGroup.visible = true
    hoverGroup.position.copy(hit.point).addScaledVector(hit.normal, 0.12)
    // 让指示器贴着坡面躺下，而不是水平插进山里
    hoverGroup.quaternion.setFromUnitVectors(UP, hit.normal)
    const pulse = 1 + Math.sin(hoverPhase * 3) * 0.06
    hoverDisc.scale.setScalar(pulse)
    hoverRing.scale.setScalar(pulse)

    const next = placeEnabled ? 'crosshair' : 'default'
    if (cursor !== next) {
      dom.style.cursor = next
      cursor = next
    }
  }

  // ---------- 对外 API ----------
  function getStats() {
    return {
      seed: currentOptions.seed,
      resolution: currentOptions.resolution,
      markerCount: markers.length,
      routeLength,
      trees: forest?.count ?? 0,
      rocks: rocks?.count ?? 0,
      triangles: terrainMesh ? terrainMesh.geometry.attributes.position.count / 3 : 0,
    }
  }

  function rebuild(next = {}) {
    currentOptions = { ...currentOptions, ...next }
    disposeTerrain()
    buildTerrain()
    resnapMarkers()
    emit()
  }

  function setPlaceEnabled(value) {
    placeEnabled = Boolean(value)
  }

  function setRouteEnabled(value) {
    routeEnabled = Boolean(value)
    rebuildRoute()
  }

  function setLightIntensity(value) {
    key.intensity = value
  }

  function setShadowEnabled(value) {
    renderer.shadowMap.enabled = Boolean(value)
    // 开关阴影会改变着色器分支，必须让所有材质重编译，否则画面不会变
    root.traverse((node) => {
      if (node.material) {
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) m.needsUpdate = true
      }
    })
  }

  function dispose() {
    dom.removeEventListener('pointermove', onPointerMove)
    dom.removeEventListener('pointerleave', onPointerLeave)
    dom.removeEventListener('pointerdown', onPointerDown)
    dom.removeEventListener('pointerup', onPointerUp)

    for (const marker of markers) marker.el?.remove()
    markers.length = 0

    disposeRoute()
    disposeTerrain()
    controls.dispose()

    disposeSubtree(root)
    scene.remove(root)
    scene.fog = null

    // 共享贴图最后统一释放
    toonGradient.dispose()
    dashTexture.dispose()
  }

  buildTerrain()
  // 构造完先广播一次初始状态：否则面板要等到用户落第一个点才有数据，
  // 一打开页面会看到"种子 0 / 三角面 0 / 树木 0"
  emit()

  return {
    field: () => field,
    update,
    dispose,
    rebuild,
    addMarker,
    removeMarker,
    clearMarkers,
    focusMarker(id) {
      const marker = markers.find((m) => m.id === id)
      if (marker) flyTo({ x: marker.x, y: marker.y, z: marker.z })
    },
    resetView,
    setPlaceEnabled,
    setRouteEnabled,
    setLightIntensity,
    setShadowEnabled,
    getStats,
    getMarkers: snapshot,
    get controls() {
      return controls
    },
    get maxMarkers() {
      return MAX_MARKERS
    },
  }
}
