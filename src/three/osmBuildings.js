import * as THREE from 'three'
import { SETTLEMENT_PALETTE } from './settlement.js'

/**
 * 真实建筑轮廓（来自 OpenStreetMap）。
 *
 * 与 settlement.js 的区别必须说清楚
 * ------------------------------------------------
 *   settlement.js  —— **示意性聚落**，程序生成，不是测绘成果
 *   osmBuildings.js —— **真实轮廓**，逐栋来自 OSM，可追溯到具体建筑名（商业街、体育馆…）
 *
 * 两者在界面上要能区分。混在一起当成"测绘成果"是欺骗。
 *
 * 覆盖面：OSM 只在水磨古镇主街区一带稀疏，本场景内 43 栋几乎全部属于
 * 阿坝师范学院校区，另有商业街与梅朵天堂大酒店。详细说明见数据文件的 coverageNote。
 *
 * 三角化用**扇形法**（以质心为中心连线）。
 * 为什么不引 earcut：本项目的几何全是凸多边形或近似凸的建筑轮廓，
 * 扇形法对它们足够，且能省掉一个运行时依赖。凹多边形会出现三角面外翻，
 * 所以下面会先做一次凸性检查，对凹轮廓退化处理（用质心扇形会有轻微外溢，
 * 但在这个尺度上看不出来——这是明确的取舍，不是疏忽）。
 */

/** 判断简单多边形是否凸（允许极小容差） */
function isConvex(ring) {
  const n = ring.length
  if (n < 4) return true
  let sign = 0
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const c = ring[(i + 2) % n]
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)
    if (Math.abs(cross) < 1e-6) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/**
 * 多边形轮廓 → 屋顶面三角（水平，位于给定高度）。
 * 返回一组 [ax,az, bx,bz, cx,cz]。
 */
function roofTriangles(ring, y) {
  const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length
  const cz = ring.reduce((s, p) => s + p.z, 0) / ring.length
  const tris = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    tris.push([a.x, y, a.z, b.x, y, b.z, cx, y, cz])
  }
  return tris
}

/** 多边形轮廓 → 侧墙三角（墙体） */
function wallTriangles(ring, y0, y1) {
  const tris = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    // 两个三角组成一面墙
    tris.push([a.x, y0, a.z, b.x, y0, b.z, b.x, y1, b.z])
    tris.push([a.x, y0, a.z, b.x, y1, b.z, a.x, y1, a.z])
  }
  return tris
}

/**
 * 构建真实建筑几何。
 *
 * @param {object} field 高度场（用于逐栋贴地）
 * @param {object} data  public/terrain/shuimo-osm-buildings.json 的内容
 * @param {object} [options]
 */
export function buildOsmBuildingGeometry(field, data, options = {}) {
  const { palette = SETTLEMENT_PALETTE, roofPitch = 0.18 } = options

  const wall = new THREE.Color(palette.earthWall)
  const roof = new THREE.Color(palette.roofDark)

  const positions = []
  const colors = []
  let concave = 0

  const half = field.size / 2

  for (const b of data.buildings) {
    const ring = b.ring
    if (!ring || ring.length < 3) continue
    if (!isConvex(ring)) concave++

    // 贴地：取轮廓的最低点作为墙脚，保证不会有一角悬空
    let baseY = Infinity
    let sumY = 0
    for (const p of ring) {
      const u = p.x / field.size + 0.5
      const v = p.z / field.size + 0.5
      const y = field.surfaceHeightAt(u, v) * field.heightScale
      if (y < baseY) baseY = y
      sumY += y
    }
    const avgY = sumY / ring.length
    // 用最低点更稳：宁可有墙脚埋进地里，也不要悬空
    const y0 = baseY - 0.4
    const h = b.height || 9
    const y1 = y0 + h
    // 屋顶：简单双坡用抬高屋脊近似——这里用整体微抬，避免为凹轮廓做复杂屋脊
    const ridgeY = y1 + Math.min(2.4, h * roofPitch)

    for (const [ax, ay, az, bx, by, bz, cx2, cy2, cz2] of wallTriangles(ring, y0, y1)) {
      positions.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2)
      for (let k = 0; k < 3; k++) colors.push(wall.r, wall.g, wall.b)
    }
    for (const [ax, ay, az, bx, by, bz, cx2, cy2, cz2] of roofTriangles(ring, ridgeY)) {
      positions.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2)
      for (let k = 0; k < 3; k++) colors.push(roof.r, roof.g, roof.b)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()

  return {
    geometry,
    triangleCount: positions.length / 9,
    buildingCount: data.buildings.length,
    concaveCount: concave,
    avgY: data.buildings.reduce((s, b) => s + (b.center?.z ?? 0), 0) / Math.max(1, data.buildings.length),
    half,
  }
}

/**
 * 一步到位：真实轮廓建筑组。
 */
export function createOsmBuildings(field, data, options = {}) {
  const { gradientMap, ...geomOptions } = options
  const { geometry, triangleCount, buildingCount, concaveCount } = buildOsmBuildingGeometry(
    field,
    data,
    geomOptions,
  )

  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap,
    side: THREE.DoubleSide,
    shadowSide: THREE.FrontSide,
    emissive: new THREE.Color(SETTLEMENT_PALETTE.earthWall).multiplyScalar(0.28),
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = 'osm-buildings'

  const group = new THREE.Group()
  group.add(mesh)

  return {
    group,
    count: buildingCount,
    triangleCount,
    concaveCount,
    /** 明确标注：这一批是真实轮廓，不是示意 */
    synthetic: false,
    source: data.source,
    license: data.license,
    coverageNote: data.coverageNote,
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
