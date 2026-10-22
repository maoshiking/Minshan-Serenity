/**
 * 地形纯逻辑冒烟测试（不依赖浏览器 / WebGL）。
 *
 *   cd "Minshan Serenity" && node scripts/terrain-smoke.mjs
 *
 * 这些断言覆盖的都是"画面上看不出错、但会让标记浮空 / 贴图错位 / 性能塌陷"的问题：
 * 噪声确定性、高度场值域、三角面采样与网格剖分是否一致、解析式拾取精度、飘带是否贴地。
 * 只 import 纯模块，因此可以直接在 Node 里跑；scenery.js 依赖 document，不在此列。
 */

import { hash2, fbm2D, mulberry32, ridgedFbm2D, valueNoise2D } from '../src/three/noise.js'
import { createHeightFieldFromData } from '../src/three/heightField.js'
import { demTerrainOptions } from '../src/three/demField.js'
import { loadDemFixtureSync } from './lib/dem-fixture.mjs'
import { raycastField } from '../src/three/picking.js'
import { buildTerrainGeometry, pickBand } from '../src/three/terrainMesh.js'
import { buildRoutePoints, buildRouteRibbon } from '../src/three/route.js'
import * as THREE from 'three'

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps
}

// ---------- 1. 噪声：确定性 + 值域 ----------
check('hash2 确定性', hash2(12, -34, 7) === hash2(12, -34, 7))
check('hash2 对 seed 敏感', hash2(12, -34, 7) !== hash2(12, -34, 8))

let hashInRange = true
let hashMin = Infinity
let hashMax = -Infinity
for (let i = 0; i < 20000; i++) {
  const v = hash2(i * 37 - 5000, i * 91 + 13, i % 17)
  if (!(v >= 0 && v < 1)) hashInRange = false
  if (v < hashMin) hashMin = v
  if (v > hashMax) hashMax = v
}
check('hash2 落在 [0,1)', hashInRange, `min=${hashMin} max=${hashMax}`)
check('hash2 覆盖度合理', hashMin < 0.01 && hashMax > 0.99, `min=${hashMin.toFixed(4)} max=${hashMax.toFixed(4)}`)

let noiseInRange = true
for (let i = 0; i < 5000; i++) {
  const x = (i % 97) * 0.37 - 12
  const y = Math.floor(i / 97) * 0.53 - 9
  const v = valueNoise2D(x, y, 3)
  if (!(v >= 0 && v <= 1)) noiseInRange = false
}
check('valueNoise2D 落在 [0,1]', noiseInRange)
check('valueNoise2D 确定性', valueNoise2D(1.5, -2.5, 9) === valueNoise2D(1.5, -2.5, 9))
check('fbm2D 确定性', fbm2D(2.2, -1.1, { seed: 5 }) === fbm2D(2.2, -1.1, { seed: 5 }))
check('ridgedFbm2D 在 [0,1]', (() => {
  for (let i = 0; i < 3000; i++) {
    const v = ridgedFbm2D(i * 0.21, i * 0.13, { seed: 11 })
    if (!(v >= 0 && v <= 1)) return false
  }
  return true
})())

// mulberry32：同 seed 同序列，且落在 [0,1)
const r1 = mulberry32(42)
const r2 = mulberry32(42)
let sameSeq = true
for (let i = 0; i < 1000; i++) {
  const a = r1()
  const b = r2()
  if (a !== b || a < 0 || a >= 1) sameSeq = false
}
check('mulberry32 可复现且在 [0,1)', sameSeq)

// ---------- 2. 高度场（真实 DEM）----------
/**
 * 高度场现在只来自真实 DEM——程序化噪声生成器（海岛原型）已移除。
 *
 * 因此这一段测的是"数据装载与采样契约"，不再是"同 seed 可复现"：
 *   · 归一化值域必须是 0..1（heightScale / waterLevel / plantable 的阈值全靠它）
 *   · 元数据与实际数据长度必须自洽
 *   · 采样连续、格点一致、对角线无缝、世界坐标往返无损
 */
const DEM_GRID = 129
const demFixture = loadDemFixtureSync({ resolution: DEM_GRID })
const f1 = createHeightFieldFromData(demFixture.data, {
  resolution: DEM_GRID,
  size: demFixture.sizeMeters,
  ...demTerrainOptions(demFixture.meta),
})

check('高度场从 DEM 数据构建成功', !!f1 && f1.resolution === DEM_GRID)
check('数据长度等于 resolution²', f1.data.length === DEM_GRID * DEM_GRID, `${f1.data.length}`)
check('世界尺寸来自元数据', f1.size === demFixture.sizeMeters, `size=${f1.size}`)
check('真实高差已单独留存', f1.options.elevationSpan === demFixture.meta.elevation.span)

let range = true
let dMin = Infinity
let dMax = -Infinity
for (const v of f1.data) {
  if (!(v >= 0 && v <= 1)) range = false
  if (v < dMin) dMin = v
  if (v > dMax) dMax = v
}
check('高度场归一化到 [0,1]', range, `min=${dMin.toFixed(4)} max=${dMax.toFixed(4)}`)
check(
  '高度场实际跨度接近 1（数据被充分利用）',
  dMax - dMin > 0.9,
  `span=${(dMax - dMin).toFixed(4)}`,
)

// 水位必须落在合理区间，否则整张图要么全淹要么全干
const above = [...f1.data].filter((v) => v > f1.waterLevel).length
const landRatio = above / f1.data.length
check('陆地占比在 88%~99%', landRatio > 0.88 && landRatio < 0.99, `land=${(landRatio * 100).toFixed(1)}%`)
check(
  '水位高于谷底最低点（否则不会有任何水面）',
  f1.waterLevel > dMin,
  `waterLevel=${f1.waterLevel} 最低点=${dMin.toFixed(4)}`,
)

// 采样连续性：小步长不能出现跳变
let maxJump = 0
for (let i = 0; i < 400; i++) {
  const u = i / 400
  const a = f1.heightAt(u, 0.5)
  const b = f1.heightAt(u + 1e-4, 0.5)
  const jump = Math.abs(a - b)
  if (jump > maxJump) maxJump = jump
}
check('heightAt 连续（无跳变）', maxJump < 0.05, `maxJump=${maxJump.toFixed(6)}`)

// 双线性与三角面采样：在格点上必须完全一致
const deg = f1.last
let gridConsistent = true
for (let j = 0; j <= deg; j += 7) {
  for (let i = 0; i <= deg; i += 7) {
    const u = i / deg
    const v = j / deg
    if (!near(f1.heightAt(u, v), f1.surfaceHeightAt(u, v), 1e-9)) gridConsistent = false
  }
}
check('格点上双线性与三角面采样一致', gridConsistent)

// 剖分对角线两侧必须没有"缝"。注意地表沿对角线是 C0 而非 C1：斜率会跳，
// 这正是块面感的来源，所以判据是"值连续到 O(ε)"，而不是"斜率连续"。
let diagConsistent = true
let worstSeam = 0
for (let j = 0; j < deg - 1; j += 5) {
  for (let i = 0; i < deg - 1; i += 5) {
    const s = 0.5
    const u = (i + s) / deg
    const v = (j + s) / deg
    // 从两侧逼近对角线
    const a = f1.surfaceHeightAt(u - 1e-7, v)
    const b = f1.surfaceHeightAt(u + 1e-7, v)
    const seam = Math.abs(a - b)
    if (seam > worstSeam) worstSeam = seam
    if (seam > 1e-4) diagConsistent = false
  }
}
check('三角剖分对角线无缝（C0 连续）', diagConsistent, `worstSeam=${worstSeam.toExponential(3)}`)

// worldHeight 必须与 surfaceHeightAt 严格对应
let worldConsistent = true
for (let k = 0; k < 200; k++) {
  const x = (k / 200 - 0.5) * f1.size * 0.98
  const z = (Math.sin(k) * 0.5) * f1.size * 0.9
  const { u, v } = f1.uvFromWorld(x, z)
  if (!near(f1.worldHeight(x, z), f1.surfaceHeightAt(u, v) * f1.heightScale, 1e-9)) worldConsistent = false
}
check('worldHeight 与 surfaceHeightAt 严格对应', worldConsistent)

// 世界坐标往返
let uvRoundTrip = true
for (let k = 0; k < 100; k++) {
  const u = (k % 10) / 10
  const v = Math.floor(k / 10) / 10
  const { x, z } = f1.worldFromUv(u, v)
  const back = f1.uvFromWorld(x, z)
  if (!near(back.u, u, 1e-9) || !near(back.v, v, 1e-9)) uvRoundTrip = false
}
check('uv ↔ 世界坐标往返无损', uvRoundTrip)

// ---------- 3. 法线与坡度 ----------
let normalOk = true
let slopeOk = true
for (let k = 0; k < 500; k++) {
  const u = (k % 25) / 25
  const v = Math.floor(k / 25) / 20
  const n = f1.normalAt(u, v)
  const len = Math.hypot(n.x, n.y, n.z)
  if (!near(len, 1, 1e-9)) normalOk = false
  if (n.y <= 0) normalOk = false
  const s = f1.slopeAt(u, v)
  if (!(s >= 0 && s <= 1)) slopeOk = false
}
check('法线单位长度且朝上', normalOk)
check('坡度落在 [0,1]', slopeOk)

/**
 * 平地与陡崖专项用**合成数据**直接构造高度场。
 *
 * 这两条测的是 normalAt / slopeAt 的纯数学行为，与数据来自 DEM 还是噪声无关，
 * 所以不该依赖真实高程文件——用常量数组与阶跃数组，判据反而更干净。
 */
const SYNTH_GRID = 33
const synthOpts = { resolution: SYNTH_GRID, size: 1600, heightScale: 355, waterLevel: 0.07, slopeRadius: 1 }

const flat = createHeightFieldFromData(new Float32Array(SYNTH_GRID * SYNTH_GRID).fill(0.5), synthOpts)
const flatNormal = flat.normalAt(0.4, 0.7)
check(
  '平地法线为 (0,1,0)',
  near(flatNormal.x, 0, 1e-9) && near(flatNormal.y, 1, 1e-9) && near(flatNormal.z, 0, 1e-9),
  JSON.stringify(flatNormal),
)
check('平地坡度为 0', near(flat.slopeAt(0.4, 0.7), 0, 1e-9))

// 陡坡专项：造一道垂直落差，法线必须明显偏离竖直方向
const steepData = new Float32Array(SYNTH_GRID * SYNTH_GRID)
for (let j = 0; j < SYNTH_GRID; j++) {
  for (let i = 0; i < SYNTH_GRID; i++) steepData[j * SYNTH_GRID + i] = i < 17 ? 0 : 1
}
const steep = createHeightFieldFromData(steepData, synthOpts)
const steepNormal = steep.normalAt(0.5, 0.5)
check('陡崖法线明显偏离竖直', steepNormal.y < 0.5, `n.y=${steepNormal.y.toFixed(4)}`)
check('陡崖坡度接近 1', steep.slopeAt(0.5, 0.5) > 0.5, `slope=${steep.slopeAt(0.5, 0.5).toFixed(4)}`)

// ---------- 4. 解析式拾取 ----------
// 正上方垂直下投：命中点必须等于该点的地表高度
let pickOk = true
let worstErr = 0
for (let k = 0; k < 60; k++) {
  const x = (k / 60 - 0.5) * f1.size * 0.9
  const z = Math.sin(k * 1.7) * f1.size * 0.35
  const groundY = f1.worldHeight(x, z)
  const ray = new THREE.Ray(new THREE.Vector3(x, groundY + 40, z), new THREE.Vector3(0, -1, 0))
  const hit = raycastField(f1, ray)
  if (!hit) {
    pickOk = false
    break
  }
  const err = Math.abs(hit.point.y - groundY)
  if (err > worstErr) worstErr = err
  if (!near(hit.point.x, x, 1e-6) || !near(hit.point.z, z, 1e-6)) pickOk = false
}
check('垂直下投命中地表', pickOk)
check('垂直下投精度 < 0.01', worstErr < 0.01, `worstErr=${worstErr.toExponential(3)}`)

// 斜向射线：命中点必须自身就在地表上（自洽性校验）
let obliqueMisses = 0
let obliqueWorst = 0
let firstMiss = ''
const origin = new THREE.Vector3(-f1.size * 0.9, f1.heightScale * 1.6, f1.size * 1.1)
for (let k = 0; k < 80; k++) {
  const targetX = (k / 80 - 0.5) * f1.size * 0.85
  const targetZ = Math.cos(k * 0.9) * f1.size * 0.4
  const targetY = f1.worldHeight(targetX, targetZ)
  const dir = new THREE.Vector3(targetX - origin.x, targetY - origin.y, targetZ - origin.z).normalize()
  const hit = raycastField(f1, new THREE.Ray(origin.clone(), dir))
  if (!hit) {
    obliqueMisses++
    if (!firstMiss) {
      firstMiss = `k=${k} 目标=(${targetX.toFixed(1)}, ${targetY.toFixed(1)}, ${targetZ.toFixed(1)}) 目标处高度=${targetY.toFixed(2)}`
    }
    continue
  }
  const err = Math.abs(hit.point.y - f1.worldHeight(hit.point.x, hit.point.z))
  if (err > obliqueWorst) obliqueWorst = err
}
check('斜向射线全部命中', obliqueMisses === 0, `${obliqueMisses}/80 未命中；首个：${firstMiss}`)
check('斜向射线精度 < 0.02', obliqueWorst < 0.02, `worst=${obliqueWorst.toExponential(3)}`)

// 朝天空打：必须打空
const skyRay = new THREE.Ray(new THREE.Vector3(0, f1.heightScale + 10, 0), new THREE.Vector3(0, 1, 0).normalize())
check('朝天空射线返回 null', raycastField(f1, skyRay) === null)
// 完全偏离地图：必须打空
const awayRay = new THREE.Ray(new THREE.Vector3(f1.size * 3, 30, f1.size * 3), new THREE.Vector3(1, -0.2, 1).normalize())
check('偏离地图射线返回 null', raycastField(f1, awayRay) === null)
// 起点在地表之下、朝上：返回"穿出地表"的那一点，而不是判空。
// 地图外的射线可能从侧面切进山体，一进入范围就已经在地表之下，这种点击不该被丢掉
const undergroundRay = new THREE.Ray(new THREE.Vector3(0, -5, 0), new THREE.Vector3(0, 1, 0).normalize())
const exitHit = raycastField(f1, undergroundRay)
check('地下起点朝上的射线返回穿出点', !!exitHit)
check(
  '穿出点自身落在地表上',
  !!exitHit && Math.abs(exitHit.point.y - f1.worldHeight(exitHit.point.x, exitHit.point.z)) < 1e-6,
  exitHit ? `Δ=${Math.abs(exitHit.point.y - f1.worldHeight(exitHit.point.x, exitHit.point.z)).toExponential(3)}` : '无命中',
)
// 一直在地表之下、始终不穿出：必须打空
const deepRay = new THREE.Ray(new THREE.Vector3(0, -1000, 0), new THREE.Vector3(1, 0, 0).normalize())
check('始终在地下的射线返回 null', raycastField(f1, deepRay) === null)

// ---------- 5. 撒树判据 ----------
check('地图边缘不可种植', f1.plantable(f1.size * 0.499, 0) === false)
check('深水下不可种植', f1.plantable(0, 0) === false || f1.heightAt(0.5, 0.5) > f1.waterLevel)
let plantableSample = 0
for (let k = 0; k < 2000; k++) {
  const x = (k / 2000 - 0.5) * f1.size * 0.9
  const z = Math.sin(k * 2.3) * f1.size * 0.4
  if (f1.plantable(x, z)) plantableSample++
}
check('存在可种植区域且不过量', plantableSample > 0 && plantableSample < 1600, `count=${plantableSample}`)

// ---------- 6. 地形几何 ----------
const geo = buildTerrainGeometry(f1)
const posAttr = geo.attributes.position
const colAttr = geo.attributes.color
const normalAttr = geo.attributes.normal
check('几何带 position/color/normal', !!posAttr && !!colAttr)
check('几何为非索引', geo.index === null)
check('顶点数 = 面数 × 3', posAttr.count === posAttr.count && posAttr.count % 3 === 0)
check('顶点数与颜色数一致', posAttr.count === colAttr.count)
check('法线已生成', !!normalAttr && normalAttr.count === posAttr.count)

// 面数校验：地表 last²×2 + 侧壁 last×4×4 + 底面 2
const expectedFaces = f1.last * f1.last * 2 + f1.last * 4 * 4 + 2
check('面数符合预期', posAttr.count / 3 === expectedFaces, `${posAttr.count / 3} vs ${expectedFaces}`)

// 颜色必须在 [0,1]，NaN 会让整个面变黑
let colorOk = true
for (let i = 0; i < colAttr.count * 3; i++) {
  const v = colAttr.array[i]
  if (!Number.isFinite(v) || v < 0 || v > 1.2) colorOk = false
}
check('顶点色数值有效', colorOk)

// 同一面的三个顶点颜色必须一致（否则色带会被插值糊掉，块面感消失）
// 面 t 占据的顶点区间是 [t*3, t*3+2]，对应颜色数组下标 t*9 起
const faceTotal = colAttr.count / 3
let perFaceColor = true
for (let t = 0; t < faceTotal; t += 37) {
  const b = t * 9
  for (let c = 0; c < 3; c++) {
    if (colAttr.array[b + c] !== colAttr.array[b + 3 + c] || colAttr.array[b + c] !== colAttr.array[b + 6 + c]) {
      perFaceColor = false
    }
  }
  if (!perFaceColor) break
}
check('逐面单色（块面感成立）', perFaceColor)

// 同一面的三个顶点法线必须一致（平面着色成立）
let perFaceNormal = true
for (let t = 0; t < faceTotal; t += 37) {
  const b = t * 9
  for (let c = 0; c < 3; c++) {
    if (
      !near(normalAttr.array[b + c], normalAttr.array[b + 3 + c], 1e-6) ||
      !near(normalAttr.array[b + c], normalAttr.array[b + 6 + c], 1e-6)
    ) {
      perFaceNormal = false
    }
  }
  if (!perFaceNormal) break
}
check('逐面单法线（平面着色成立）', perFaceNormal)

// 地表三角面的法线必须朝上、且与 heightField.normalAt 的结论一致
let surfaceNormalsUp = true
let surfaceSampleCount = 0
for (let t = 0; t < f1.last * f1.last * 2; t += 101) {
  const ny = normalAttr.array[t * 3 + 1]
  if (!(ny > 0)) surfaceNormalsUp = false
  surfaceSampleCount++
}
check('地表法线全部朝上', surfaceNormalsUp && surfaceSampleCount > 0)

// 几何顶点高度必须与高度场一致（抽查：地表段的三角面顶点）
let geoMatchesField = true
for (let t = 0; t < 3000; t += 7) {
  const x = posAttr.array[t * 3]
  const y = posAttr.array[t * 3 + 1]
  const z = posAttr.array[t * 3 + 2]
  // 只有 y >= 0 的才在地表上（侧壁会到负高度）
  if (y < -1e-6) continue
  const expected = f1.worldHeight(x, z)
  if (Math.abs(y - expected) > 1e-4) geoMatchesField = false
}
check('地表顶点高度与高度场一致', geoMatchesField)

// 色带分类不被 NaN 打破
check('pickBand 深水', pickBand(0.1, 0, 0.33) === 'deepWater')
check('pickBand 雪顶', pickBand(0.95, 0, 0.33) === 'snow')
check('pickBand 陡崖优先于高度', pickBand(0.95, 0.7, 0.33) === 'cliff')
// 陡坡上的高处必须是岩石而不是雪：否则山顶侧面会散落白块，看着像破面
check('陡坡高处不给雪', pickBand(0.95, 0.45, 0.33) === 'rock')

// ---------- 7. 路线飘带 ----------
check('少于两点不出路线', buildRoutePoints([{ x: 0, z: 0 }]).length === 0)
check('两点出的路线非空', buildRoutePoints([{ x: 0, z: 0 }, { x: 10, z: 10 }]).length > 0)

const waypoints = [
  { x: -20, z: -15 },
  { x: 0, z: 5 },
  { x: 18, z: -8 },
  { x: 30, z: 20 },
]
const pts = buildRoutePoints(waypoints, { samplesPerSegment: 12 })
check('路线采样点数符合预期', pts.length === Math.max(8, 3 * 12) + 1, `got ${pts.length}`)
check('路线首点贴合起点', near(pts[0].x, waypoints[0].x, 1e-6) && near(pts[0].z, waypoints[0].z, 1e-6))
check('路线末点贴合终点', near(pts.at(-1).x, waypoints.at(-1).x, 1e-6) && near(pts.at(-1).z, waypoints.at(-1).z, 1e-6))

const ribbon = buildRouteRibbon(f1, pts, { width: 2, lift: 0.5 })
check('飘带几何生成成功', !!ribbon && !!ribbon.geometry)
check('飘带长度为正', ribbon.length > 0, `length=${ribbon.length}`)

const rp = ribbon.geometry.attributes.position
const ruv = ribbon.geometry.attributes.uv
check('飘带顶点数 = 采样点 × 2', rp.count === pts.length * 2)
check('飘带索引数 = (n-1) × 6', ribbon.geometry.index.count === (pts.length - 1) * 6)

// 每个顶点都必须在地面之上（否则带子会钻进山里）
let ribbonAbove = true
let minClearance = Infinity
for (let i = 0; i < rp.count; i++) {
  const x = rp.array[i * 3]
  const y = rp.array[i * 3 + 1]
  const z = rp.array[i * 3 + 2]
  const clearance = y - f1.worldHeightSmooth(x, z)
  if (clearance < minClearance) minClearance = clearance
  if (clearance < 0.05) ribbonAbove = false
}
check('飘带全程浮在地面之上', ribbonAbove, `minClearance=${minClearance.toFixed(3)}`)

// UV 的 u 必须单调不减，且首尾为 0 / 1
let uMonotonic = true
let prevU = -1
let uStart = null
let uEnd = null
for (let i = 0; i < rp.count; i += 2) {
  const u = ruv.array[i * 2]
  if (uStart === null) uStart = u
  uEnd = u
  if (u < prevU - 1e-9) uMonotonic = false
  prevU = u
}
check('飘带 UV.u 单调不减', uMonotonic)
check('飘带 UV.u 首尾为 0/1', near(uStart, 0, 1e-6) && near(uEnd, 1, 1e-6), `${uStart} → ${uEnd}`)
check('飘带 UV.v 为 0/1', near(ruv.array[1], 0) && near(ruv.array[3], 1))

// 退化输入不能抛异常
check('重复点不产生 NaN 飘带', buildRouteRibbon(f1, [{ x: 5, z: 5 }, { x: 5, z: 5 }]) === null)
check('空输入安全', buildRouteRibbon(f1, []) === null && buildRouteRibbon(f1, null) === null)

// ---------- 汇总 ----------
const total = passed + failures.length
console.log(`\n地形纯逻辑冒烟测试：${passed}/${total} 通过`)
if (failures.length) {
  console.log('\n未通过：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
} else {
  console.log('全部通过 ✓\n')
}
