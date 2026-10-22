import * as THREE from 'three'
import { lonLatToWorld, normToElevation } from './demField.js'

/**
 * 水磨古镇的地标数据与落位。
 *
 * 数据来源与可信度
 * ----------------
 * 九个地标的经纬度由需求方提供（高德 WGS84，点位中心近似值），
 * 属于"已提供但未做过实地核校"的级别。所以这里给每个地标带一个
 * `verified: false` 标记，界面上一律显示"待核"，不冒充权威。
 *
 * 为什么坐标只算一次
 * ----------------
 * 经纬度 → 世界坐标的换算必须与 build-dem.mjs 完全一致，否则地标会整体偏移。
 * 这类错误肉眼极难发现（看起来"就是在那儿"），所以只允许有一个实现
 * （demField.lonLatToWorld），并且在这里算好后缓存，不在渲染循环里重复算。
 */

/** 九个地标：名称、经纬度、类别、可否作为讲解点 */
export const SHUIMO_LANDMARKS = [
  { id: 'huanglong-daoguan', name: '黄龙道观', lon: 103.41721, lat: 30.92835, kind: 'taoist' },
  { id: 'chunfeng-ge', name: '春风阁', lon: 103.420068, lat: 30.929212, kind: 'qiang' },
  { id: 'chanshou-laojie', name: '禅寿老街·万年台', lon: 103.420881, lat: 30.930634, kind: 'qiang' },
  { id: 'zikuta', name: '字库塔', lon: 103.420613, lat: 30.93074, kind: 'qiang' },
  { id: 'qiangdiao', name: '羌碉、西羌汇', lon: 103.419371, lat: 30.929548, kind: 'qiang' },
  { id: 'zhiyuan-langqiao', name: '致远廊桥', lon: 103.42143, lat: 30.93016, kind: 'qiang' },
  { id: 'shouxihu', name: '寿溪湖环湖步道', lon: 103.420251, lat: 30.928652, kind: 'quiet' },
  { id: 'renji-ximugu', name: '仁吉喜目谷', lon: 103.436958, lat: 30.942703, kind: 'quiet' },
  { id: 'hexie-guangchang', name: '和谐广场', lon: 103.422298, lat: 30.933248, kind: 'quiet' },
]

/**
 * 地标类别 → 显示色。与视觉方向「山志」的点缀色一致：
 * 朱砂只留给道家文脉，羌文化用青灰，静养用墨绿。
 */
export const LANDMARK_COLORS = {
  taoist: '#B4453A',
  qiang: '#5C6B73',
  quiet: '#4F6B5A',
}

/**
 * 把地标列表转成带世界坐标与贴地高程的数组。
 *
 * @param {object} meta   DEM 元数据（shuimo-dem.json）
 * @param {object} field  高度场，用于取贴地高程
 * @param {object} [options]
 * @param {boolean} [options.onlyInside] 只保留落在场景范围内的（默认 true）
 * @returns {Array<object>}
 */
export function resolveLandmarks(meta, field, options = {}) {
  const { onlyInside = true } = options
  const half = (meta.sizeMeters ?? 1600) / 2
  const out = []

  for (const lm of SHUIMO_LANDMARKS) {
    const { x, z } = lonLatToWorld(meta, lm.lon, lm.lat)
    const inside = Math.abs(x) <= half && Math.abs(z) <= half
    if (onlyInside && !inside) continue

    // 贴地高程：用与网格逐字对齐的 surfaceHeightAt，保证标记不会浮空或陷地
    const u = x / (meta.sizeMeters ?? 1600) + 0.5
    const v = z / (meta.sizeMeters ?? 1600) + 0.5
    const norm = field ? field.surfaceHeightAt(u, v) : 0
    const y = field ? norm * field.heightScale : 0

    out.push({
      ...lm,
      x,
      y,
      z,
      // 真实海拔（米），用于界面显示与"是否会被水淹"的判断
      elevation: normToElevation(meta, norm),
      inside,
      // 需求方提供但未经实地核校——界面必须显示"待核"
      verified: false,
    })
  }

  return out
}

/**
 * 地标标记：一根细立柱 + 顶部一个小八面体。
 *
 * 为什么不用精灵或贴图：地标在这个尺度上只有几米，用几何体反而更省，
 * 而且能受益于场景的雾与光照，不会像广告牌那样浮在画面之上。
 * 立柱的作用是解决"陡坡上圆点看起来悬空"的问题——有一根柱子接地就踏实了。
 */
export function createLandmarkMarkers(landmarks, options = {}) {
  const { radius = 6, height = 56, gradientMap } = options

  const group = new THREE.Group()
  group.name = 'landmark-markers'

  const byKind = new Map()
  for (const lm of landmarks) {
    if (!byKind.has(lm.kind)) byKind.set(lm.kind, [])
    byKind.get(lm.kind).push(lm)
  }

  const owned = []

  for (const [kind, list] of byKind) {
    const color = new THREE.Color(LANDMARK_COLORS[kind] ?? '#5C6B73')

    const stemGeom = new THREE.CylinderGeometry(radius * 0.08, radius * 0.08, height, 5)
    stemGeom.translate(0, height / 2, 0)
    const headGeom = new THREE.OctahedronGeometry(radius * 0.5, 0)
    headGeom.translate(0, height, 0)

    const material = new THREE.MeshToonMaterial({
      color,
      gradientMap,
      // 标记是"界面"而不是"地物"，所以不参与投影，免得在陡坡上拉出长影
      emissive: color.clone().multiplyScalar(0.25),
    })

    for (const geom of [stemGeom, headGeom]) {
      owned.push(geom)
    }
    owned.push(material)

    for (const lm of list) {
      const stem = new THREE.Mesh(stemGeom, material)
      const head = new THREE.Mesh(headGeom, material)
      stem.position.set(lm.x, lm.y, lm.z)
      head.position.set(lm.x, lm.y, lm.z)
      group.add(stem, head)
    }
  }

  function dispose() {
    for (const item of owned) item.dispose?.()
  }

  return { group, count: landmarks.length, dispose }
}
