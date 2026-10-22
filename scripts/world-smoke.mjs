/**
 * 三维世界构建自检（假 DOM + 真实 three.js 场景图，不需要浏览器 / WebGL）。
 *
 *   cd "Minshan Serenity" && node scripts/world-smoke.mjs
 *
 * 编译通过不等于能跑：three 的 API 误用、变量时序、实例化属性初始化这类问题
 * 全都只在运行时暴露，而且是"整页白屏"级别的。这个脚本用测试替身替掉两样东西——
 *   · WebGL 上下文（scene 图构建本身不需要 GL）
 *   · canvas 2D 与 DOM（贴图绘制、标记浮层）
 * 然后把真实的事件派发进真实的事件处理器，验证拾取 → 落点 → 连线的完整链路。
 * 被替掉的部分不是被测对象，被测对象是场景图与交互逻辑。
 */

import * as THREE from 'three'
import { skirtDepthOf } from '../src/three/cartoonTerrain.js'
import { demTerrainOptions } from '../src/three/demField.js'
// 真实高程数据。世界现在只接受 DEM——没有它 createTerrainWorld 会直接抛错，
// 而不是悄悄退回一个假地形（静默降级会让人以为看到的是真实地形）。
import { loadDemFixtureSync } from './lib/dem-fixture.mjs'

// ---------- DOM / canvas 测试替身 ----------
const drawCalls = { fillRect: 0, stroke: 0, fill: 0, clearRect: 0 }

function createFakeContext() {
  return {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    fillRect() {
      drawCalls.fillRect++
    },
    clearRect() {
      drawCalls.clearRect++
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    stroke() {
      drawCalls.stroke++
    },
    fill() {
      drawCalls.fill++
    },
  }
}

function createFakeElement(tag = 'div') {
  const listeners = new Map()
  const children = []

  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    className: '',
    textContent: '',
    clientWidth: 960,
    clientHeight: 640,
    width: 960,
    height: 640,
    parentNode: null,
    children,
    classList: {
      set: new Set(),
      add(c) {
        this.set.add(c)
      },
      remove(c) {
        this.set.delete(c)
      },
      contains(c) {
        return this.set.has(c)
      },
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type)
      if (!list) return
      const i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length
    },
    dispatch(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event)
    },
    appendChild(child) {
      children.push(child)
      child.parentNode = el
      return child
    },
    removeChild(child) {
      const i = children.indexOf(child)
      if (i >= 0) children.splice(i, 1)
      return child
    },
    remove() {
      el.parentNode?.removeChild(el)
    },
    querySelector() {
      return null
    },
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: el.clientWidth,
        height: el.clientHeight,
        right: el.clientWidth,
        bottom: el.clientHeight,
      }
    },
    getContext() {
      return createFakeContext()
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture() {
      return false
    },
  }

  el.ownerDocument = {
    addEventListener() {},
    removeEventListener() {},
  }

  // OrbitControls 会把滚轮/按键监听挂到根节点上，所以要提供一个能收监听的根节点
  const rootNode = {
    addEventListener() {},
    removeEventListener() {},
  }
  el.getRootNode = () => rootNode

  return el
}

globalThis.document = {
  createElement(tag) {
    return createFakeElement(tag)
  },
}

const { createTerrainWorld } = await import('../src/three/cartoonTerrain.js')

// ---------- 断言工具 ----------
let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) passed++
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function run(name, fn) {
  try {
    fn()
  } catch (err) {
    failures.push(`${name} 抛出异常 — ${err.message}`)
  }
}

// ---------- 搭建一个最小可用的 three 环境 ----------
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 200)
const domElement = createFakeElement('canvas')
const renderer = {
  domElement,
  shadowMap: {},
  setClearColor() {},
  render() {},
}
const labelLayer = createFakeElement('div')

// 记录回调，用来验证"世界一构造好就把初始状态广播出去"——
// 直接调 getStats() 是查不出这个问题的：漏广播时页面会一直显示 0
const callbackLog = { stats: [], markers: [] }

/**
 * 世界现在只吃真实 DEM。
 *
 * **但必须按真实装载顺序来**：先建一个空世界（DOM 就绪时同步创建），
 * 再通过 setDemField 把异步取回的 DEM 灌进去。
 *
 * 为什么不能图省事在构造时就传 DEM：那样测的是一条浏览器里不存在的路径。
 * 实测代价——曾经实现里"缺少 DEM 就抛错"，构造时传了 DEM 的自检全绿，
 * 而真实页面在数据到达前就被打死了。**自检的流程必须与线上一致。**
 */
const DEM_RESOLUTION = 96

let world = null
run('创建三维世界（尚无 DEM 数据）', () => {
  world = createTerrainWorld({
    scene,
    camera,
    renderer,
    labelLayer,
    options: { resolution: DEM_RESOLUTION },
    onMarkersChange: (list) => callbackLog.markers.push(list),
    onStats: (value) => callbackLog.stats.push(value),
  })
})
check('世界实例创建成功（空场景不抛错）', !!world)
check('尚无 DEM 时高度场为空', world?.field() === null, `field=${world?.field()}`)

const dem = loadDemFixtureSync({ resolution: DEM_RESOLUTION })
run('灌入真实 DEM（模拟异步装载完成）', () => {
  world.setDemField(
    {
      data: dem.data,
      meta: dem.meta,
      osmBuildings: dem.osmBuildings,
      resolution: dem.resolution,
      sizeMeters: dem.sizeMeters,
    },
    { resolution: DEM_RESOLUTION, ...demTerrainOptions(dem.meta) },
  )
})
check('灌入后高度场就绪', !!world.field())
check('灌入后尺寸变为真实米制', world.field()?.size === dem.sizeMeters, `size=${world.field()?.size}`)
check(
  '灌入后相机远平面覆盖整个场景',
  camera.far >= dem.sizeMeters * 2,
  `far=${camera.far} 场景=${dem.sizeMeters}`,
)
check('世界实例创建成功', !!world)
if (!world) {
  console.log('世界创建失败，后续断言跳过')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}

check('构造后立即广播了初始状态', callbackLog.stats.length > 0, `calls=${callbackLog.stats.length}`)
const initialStats = callbackLog.stats.at(-1)
check('初始状态里三角面数非零', (initialStats?.triangles ?? 0) > 0, `triangles=${initialStats?.triangles}`)
check('初始状态里树木数非零', (initialStats?.trees ?? 0) > 0, `trees=${initialStats?.trees}`)
// 真实地形没有"换种子"的概念，seed 断言随之移除
check('初始状态精度正确', initialStats?.resolution === DEM_RESOLUTION, `resolution=${initialStats?.resolution}`)

// ---------- 场景图结构 ----------
const counts = { mesh: 0, instanced: 0, light: 0, group: 0 }
scene.traverse((node) => {
  if (node.isInstancedMesh) counts.instanced++
  else if (node.isMesh) counts.mesh++
  if (node.isLight) counts.light++
  if (node.isGroup) counts.group++
})

check('场景里有普通网格（天空/地形/水面）', counts.mesh >= 3, `mesh=${counts.mesh}`)
check('场景里有实例化网格（树/石）', counts.instanced >= 1, `instanced=${counts.instanced}`)
check('场景里有灯光', counts.light >= 2, `light=${counts.light}`)
check('渲染器开启了阴影', renderer.shadowMap.enabled === true)
check('贴图确实在 canvas 上绘制过', drawCalls.fillRect > 0 && drawCalls.stroke > 0)

// 地形网格：非索引 + 带顶点色 + 顶点数很大
let terrainMesh = null
/**
 * 地形网格按**名字**定位，不要用"顶点最多的带色非索引网格"这种启发式。
 *
 * 曾经能挑对，是因为地形确实是场景里最大的网格。但示意性聚落现在有近 1500 栋，
 * 顶点数已经超过地形——同一个启发式就悄悄挑错了对象，
 * 断言随之失败而报的是"统计口径不一致"，把人往错误的方向引。
 * 名字是唯一稳定的标识。
 */
scene.traverse((node) => {
  if (node.isMesh && node.name === 'terrain-surface') terrainMesh = node
})
check('找到地形网格', !!terrainMesh, '按名字 terrain-surface 定位')
check('地形网格非索引（块面感前提）', terrainMesh?.geometry.index === null)

const stats0 = world.getStats()
check(
  '统计里的三角面数与非索引几何一致',
  stats0.triangles === terrainMesh.geometry.attributes.position.count / 3,
  `stats=${stats0.triangles} 几何=${terrainMesh.geometry.attributes.position.count / 3}`,
)
check('统计里有树', stats0.trees > 0, `trees=${stats0.trees}`)
check('初始没有标记点', stats0.markerCount === 0)

// 地形顶点不能有 NaN
run('地形顶点无 NaN', () => {
  const arr = terrainMesh.geometry.attributes.position.array
  let bad = 0
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) bad++
  check('地形顶点无 NaN', bad === 0, `bad=${bad}`)
})

// ---------- 悬停拾取（真实事件派发）----------
function pointerEvent(x, y, extra = {}) {
  return {
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  }
}

// 悬停指示器：一个由"圆盘 + 圆环"两个 Mesh 组成的 Group。
// 注意标记点的 Group 也是两个子节点，但其中一个是子 Group（没有 geometry），据此区分。
let hoverGroup = null
scene.traverse((node) => {
  if (!node.isGroup || node.children.length !== 2) return
  const kinds = node.children
    .map((c) => c.geometry?.type)
    .sort()
    .join('+')
  if (kinds === 'CircleGeometry+RingGeometry') hoverGroup = node
})
check('找到悬停指示器 Group', !!hoverGroup)

// 重新派发一次 pointermove，确保断言基于最新一帧的状态
run('派发 pointermove 到画布中央', () => {
  domElement.dispatch('pointermove', pointerEvent(480, 320))
  world.update(0.016, 0.016)
})

if (hoverGroup) {
  check('悬停指示器已显示', hoverGroup.visible === true)
  const field = world.field()
  const groundY = field.worldHeight(hoverGroup.position.x, hoverGroup.position.z)
  check(
    '悬停指示器贴在地表附近',
    Math.abs(hoverGroup.position.y - groundY) < 1.0,
    `Δ=${(hoverGroup.position.y - groundY).toFixed(3)}`,
  )
  check('悬停指示器朝上（未翻转）', hoverGroup.quaternion.w > 0.3, `w=${hoverGroup.quaternion.w.toFixed(3)}`)
}

// 指向天空：必须隐藏
run('派发指向天空的 pointermove', () => {
  domElement.dispatch('pointermove', pointerEvent(480, 8))
  world.update(0.016, 0.032)
})
if (hoverGroup) check('指向天空时悬停指示器隐藏', hoverGroup.visible === false)

// ---------- 点击落点（真实事件派发）----------
run('派发一次点击', () => {
  domElement.dispatch('pointermove', pointerEvent(480, 320))
  domElement.dispatch('pointerdown', pointerEvent(480, 320))
  domElement.dispatch('pointerup', pointerEvent(480, 320))
})
check('画布中央单击生成了一个标记点', world.getStats().markerCount === 1, `count=${world.getStats().markerCount}`)
check('标记浮层里出现了一个标签', labelLayer.children.length === 1, `labels=${labelLayer.children.length}`)

// 拖动超过阈值：算转视角，不该落点
const beforeDrag = world.getStats().markerCount
run('派发一次拖动', () => {
  domElement.dispatch('pointerdown', pointerEvent(400, 300))
  domElement.dispatch('pointerup', pointerEvent(440, 330))
})
check('拖动不产生标记点', world.getStats().markerCount === beforeDrag)

// 关闭落点开关后点击无效
world.setPlaceEnabled(false)
run('关闭落点后点击', () => {
  domElement.dispatch('pointerdown', pointerEvent(520, 360))
  domElement.dispatch('pointerup', pointerEvent(520, 360))
})
check('关闭落点开关后点击不生效', world.getStats().markerCount === beforeDrag)
world.setPlaceEnabled(true)

// ---------- 几何有效性（这一组是为一个真实踩过的坑加的）----------
// three 0.186 的 computeVertexNormals() 不再返回 this，链式调用会得到 undefined，
// 而 InstancedMesh 的默认参数会把它静默换成空几何：树和石头根本不出现，且不报任何错。
// 所以断言必须是"几何里有顶点"，而不只是"实例数量大于 0"。
const emptyGeometries = []
scene.traverse((node) => {
  if (!node.isMesh && !node.isInstancedMesh) return
  const position = node.geometry?.attributes?.position
  if (!position || position.count === 0) {
    emptyGeometries.push(`${node.constructor.name}(instanced=${!!node.isInstancedMesh})`)
  }
})
check('所有网格都有非空几何', emptyGeometries.length === 0, emptyGeometries.join(', '))

let instancedCount = 0
let instancedWithoutNormal = 0
let vegetationFaces = 0
scene.traverse((node) => {
  if (!node.isInstancedMesh) return
  instancedCount++
  // 缺法线的块面几何会整片发黑
  if (!node.geometry.attributes.normal) instancedWithoutNormal++
  // 数量大的那一批就是树林。必须乘实例数：单个树几何只有几十个面，
  // 是"一个几何 × 几百个实例"才构成树林
  if (node.count > 100) {
    vegetationFaces += (node.geometry.attributes.position.count / 3) * node.count
  }
})
check('场景里有实例化网格', instancedCount > 0, `instanced=${instancedCount}`)
check('实例化网格都带法线', instancedWithoutNormal === 0, `缺失=${instancedWithoutNormal}`)
check('树林几何确有内容', vegetationFaces > 1000, `faces=${vegetationFaces}`)

// ---------- 初始取景校验 ----------
// 默认取景是纯数学推出来的，没有肉眼可看，所以把它算成 NDC 直接验证：
// 地形八个角必须全部落在画面内（含沙盘底座），并且不能小得像一粒芝麻。
// 宽高比取 1.0 与 1.6 两个极端：窄栏/竖屏和常规宽屏都要成立。
run('初始取景校验', () => {
  const f = world.field()
  const half = f.size / 2
  const skirtDepth = skirtDepthOf(f.options ?? f)
  const corners = []
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      for (const y of [-skirtDepth, f.heightScale]) corners.push(new THREE.Vector3(x, y, z))
    }
  }

  const measure = () => {
    let maxAbs = 0
    let inside = true
    for (const corner of corners) {
      const p = corner.clone().project(camera)
      maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y))
      if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1) inside = false
    }
    return { maxAbs, inside }
  }

  // 构造完成时就该已经取好景（用的是创建时的宽高比 1.5）
  world.update(1 / 60, 100)
  const initial = measure()
  console.log(`  · 构造后（宽高比 1.5）：最坏角 NDC = ${initial.maxAbs.toFixed(3)}`)
  check('构造后取景已经成立', initial.inside && initial.maxAbs > 0.7, `maxAbs=${initial.maxAbs.toFixed(3)}`)

  // 真正的产品保证：任何宽高比下"重置视角"都能重新贴合。
  // 注意必须先 resetView —— 改宽高比本身不会自动重新取景（那会跟用户手动转动视角打架）
  for (const aspect of [1.0, 1.5, 1.6]) {
    camera.aspect = aspect
    camera.updateProjectionMatrix()
    world.resetView()
    world.update(1 / 60, 100)
    const { maxAbs, inside } = measure()
    console.log(`  · 重置视角后（宽高比 ${aspect}）：最坏角 NDC = ${maxAbs.toFixed(3)}`)
    check(`宽高比 ${aspect}：重置视角后地形完整在画面内`, inside, `maxAbs=${maxAbs.toFixed(3)}`)
    check(`宽高比 ${aspect}：构图不过小`, maxAbs > 0.7, `maxAbs=${maxAbs.toFixed(3)}`)
  }

  camera.aspect = 1.5
  camera.updateProjectionMatrix()
})

// ---------- 标记点贴地与编号 ----------
const field = world.field()
run('标记点贴地检查', () => {
  const marker = world.getMarkers()[0]
  const expected = field.worldHeight(marker.x, marker.z)
  check('标记点 y 等于该处地表高度', Math.abs(marker.y - expected) < 1e-9, `Δ=${Math.abs(marker.y - expected)}`)
  check('标记点坐标有限', Number.isFinite(marker.x) && Number.isFinite(marker.z))
})

// ---------- 路线 ----------
run('铺三个标记点', () => {
  world.addMarker(-25, -18)
  world.addMarker(4, 6)
  world.addMarker(22, -10)
})
check('共 4 个标记点', world.getStats().markerCount === 4, `count=${world.getStats().markerCount}`)
check('标签数量与标记数一致', labelLayer.children.length === 4, `labels=${labelLayer.children.length}`)
check('编号按顺序递增', labelLayer.children.map((c) => c.children[0].textContent).join(',') === '1,2,3,4', labelLayer.children.map((c) => c.children[0].textContent).join(','))

const routeStats = world.getStats()
check('路线长度为正', routeStats.routeLength > 0, `length=${routeStats.routeLength}`)

// 路线飘带必须浮在地表之上
run('路线贴地检查', () => {
  let ribbon = null
  scene.traverse((node) => {
    if (node.isMesh && node.geometry?.attributes?.uv && node.geometry.index) ribbon = node
  })
  check('找到路线飘带网格', !!ribbon)
  if (!ribbon) return
  const pos = ribbon.geometry.attributes.position
  let minClearance = Infinity
  let bad = 0
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) bad++
    const clearance = y - field.worldHeightSmooth(x, z)
    if (clearance < minClearance) minClearance = clearance
  }
  check('飘带顶点无 NaN', bad === 0, `bad=${bad}`)
  check('飘带全程浮在地表之上', minClearance > 0.05, `minClearance=${minClearance.toFixed(3)}`)
})

// ---------- 标记增删的重编号 ----------
run('删除首个标记点', () => {
  world.removeMarker(world.getMarkers()[0].id)
})
check('删除后剩 3 个', world.getStats().markerCount === 3)
check(
  '删除后编号重新连续',
  labelLayer.children.map((c) => c.children[0].textContent).join(',') === '1,2,3',
  labelLayer.children.map((c) => c.children[0].textContent).join(','),
)
check('删除后标签元素也被移除', labelLayer.children.length === 3)

// ---------- 动画帧 ----------
run('连续跑 120 帧', () => {
  for (let i = 0; i < 120; i++) world.update(1 / 60, 1 / 60 + i / 60)
})
check('跑帧后状态正常', world.getStats().markerCount === 3)
run('标记落点动画收敛到地面', () => {
  for (let i = 0; i < 200; i++) world.update(1 / 60, 5 + i / 60)
  let maxOffset = 0
  scene.traverse((node) => {
    if (node.isGroup && node.children.length === 2 && node.children.some((c) => c.geometry?.type === 'ConeGeometry')) {
      maxOffset = Math.max(maxOffset, Math.abs(node.children[1].position.y))
    }
  })
  check('落点动画结束后标记回到地面', maxOffset < 1e-6, `maxOffset=${maxOffset}`)
})

// ---------- 路线开关 ----------
world.setRouteEnabled(false)
check('关闭路线后长度归零', world.getStats().routeLength === 0)
world.setRouteEnabled(true)
check('重新打开路线后长度恢复', world.getStats().routeLength > 0)

// ---------- 阴影与光照开关 ----------
world.setShadowEnabled(false)
check('关闭阴影生效', renderer.shadowMap.enabled === false)
world.setShadowEnabled(true)
check('打开阴影生效', renderer.shadowMap.enabled === true)
run('调整光照强度', () => world.setLightIntensity(3.3))
run('重置视角', () => world.resetView())
run('定位到标记点', () => world.focusMarker(world.getMarkers()[0].id))
run('定位后跑帧（相机飞行）', () => {
  for (let i = 0; i < 90; i++) world.update(1 / 60, 10 + i / 60)
})

// ---------- 调整精度 ----------
const camLenBefore = camera.position.length()
/**
 * 真实 DEM 只有一张，"换 seed"没有意义（seed 现在是程序化地形的遗留概念）。
 * 用户能改的是**画面精度**——它走 setResolution，只换几何、不动相机，
 * 这样调精度时视角不会被重置。
 */
run('降低精度', () => world.setResolution(56))
check('精度已更新', world.getStats().resolution === 56, `resolution=${world.getStats().resolution}`)
check(
  '调精度不重置相机',
  Math.abs(camera.position.length() - camLenBefore) < 1,
  `调前=${camLenBefore.toFixed(1)} 调后=${camera.position.length().toFixed(1)}`,
)
check('调精度后标记点被保留', world.getStats().markerCount === 3, `count=${world.getStats().markerCount}`)

run('重建后标记点重新贴地', () => {
  const newField = world.field()
  for (const marker of world.getMarkers()) {
    const expected = newField.worldHeight(marker.x, marker.z)
    check('标记点贴在新地表上', Math.abs(marker.y - expected) < 1e-9, `id=${marker.id} Δ=${Math.abs(marker.y - expected)}`)
  }
})
run('重建后跑帧', () => {
  for (let i = 0; i < 30; i++) world.update(1 / 60, 20 + i / 60)
})

// ---------- 标记数量上限 ----------
run('压满标记上限', () => {
  const max = world.maxMarkers
  let guard = 0
  while (world.getStats().markerCount < max && guard < 100) {
    world.addMarker((guard % 9) * 6 - 24, (guard % 7) * 7 - 20)
    guard++
  }
  const overflow = world.addMarker(0, 0)
  check('超出上限时不再新增', overflow === null)
  check('标记数停在上限', world.getStats().markerCount === max, `count=${world.getStats().markerCount} max=${max}`)
})

// ---------- 清空与销毁 ----------
run('清空标记', () => world.clearMarkers())
check('清空后没有标记点', world.getStats().markerCount === 0)
check('清空后标签浮层也空了', labelLayer.children.length === 0)
check('清空后路线消失', world.getStats().routeLength === 0)

const meshBefore = scene.children.length
run('销毁世界', () => world.dispose())
check('销毁后场景被清空', scene.children.length < meshBefore, `${scene.children.length} vs ${meshBefore}`)
check('销毁后事件监听已摘除', domElement.listenerCount('pointerdown') === 0 && domElement.listenerCount('pointerup') === 0)

// ---------- 汇总 ----------
const total = passed + failures.length
console.log(`\n三维世界构建自检：${passed}/${total} 通过`)
if (failures.length) {
  console.log('\n未通过：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓\n')
