/**
 * 聚落布局自证：检查建筑数量、落点高度、是否压在水面下或陡坡上、
 * 三角面预算，以及街巷轴向是否与地标主轴一致。
 *
 * 用法：node scripts/dem/check-settlement.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { resolveLandmarks } from '../../src/three/landmarks.js'
import {
  generateSettlementLayout,
  buildSettlementGeometry,
  townAxisFromLandmarks,
  valleySpineFromField,
  SETTLEMENT_PALETTE,
} from '../../src/three/settlement.js'

const ROOT = process.cwd()
const meta = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols

function resample(src, n, t) {
  if (t === n) return src
  const last = n - 1
  const out = new Float32Array(t * t)
  for (let j = 0; j < t; j++) {
    const gg = (j / (t - 1)) * last
    const j0 = Math.min(Math.floor(gg), last - 1)
    const tt = gg - j0
    for (let i = 0; i < t; i++) {
      const f = (i / (t - 1)) * last
      const i0 = Math.min(Math.floor(f), last - 1)
      const s = f - i0
      const A = src[j0 * n + i0]
      const B = src[j0 * n + i0 + 1]
      const C = src[(j0 + 1) * n + i0]
      const D = src[(j0 + 1) * n + i0 + 1]
      out[j * t + i] = (A * (1 - s) + B * s) * (1 - tt) + (C * (1 - s) + D * s) * tt
    }
  }
  return out
}

const g = 256
const data = resample(full, N, g)
const field = createHeightFieldFromData(data, {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
})

const landmarks = resolveLandmarks(meta, field)
const river = valleySpineFromField(field)
const axis = river ?? townAxisFromLandmarks(landmarks)
const axisDeg = (Math.atan2(axis.dir.x, axis.dir.z) * 180) / Math.PI

console.log(`场景 ${meta.sizeMeters} m 见方   水位 ${field.waterLevel} → 水面 ${(meta.elevation.min + field.waterLevel * meta.elevation.span).toFixed(0)} m`)
console.log(`谷底脊线  切片 ${river?.sampleCount ?? 0} 段   脊线中心 x=${(river?.center.x ?? 0).toFixed(0)} m z=${(river?.center.z ?? 0).toFixed(0)} m`)
console.log(`街巷轴向  方位角 ${axisDeg.toFixed(1)}°（0=北，90=东）  x=${axis.dir.x.toFixed(3)} z=${axis.dir.z.toFixed(3)}`)
console.log(`主轴中心  x=${axis.center.x.toFixed(0)} m  z=${axis.center.z.toFixed(0)} m`)
console.log('')

const layout = generateSettlementLayout(field, landmarks)
const { triangleCount } = buildSettlementGeometry(layout)

console.log(`建筑数量   ${layout.length} 栋`)
console.log(`三角面数   ${triangleCount.toLocaleString('zh-CN')}（每栋 36 面）`)

if (!layout.length) {
  console.log('没有任何建筑，需要放宽约束')
  process.exit(0)
}

// 落点合理性
const waterY = field.waterY()
let underwater = 0
let tooSteep = 0
let minY = Infinity
let maxY = -Infinity
let sumFloors = 0
let minX = Infinity
let maxX = -Infinity
let minZ = Infinity
let maxZ = -Infinity

for (const b of layout) {
  if (b.y < waterY) underwater++
  const u = b.x / field.size + 0.5
  const v = b.z / field.size + 0.5
  if (field.slopeAt(u, v) > 0.34) tooSteep++
  if (b.y < minY) minY = b.y
  if (b.y > maxY) maxY = b.y
  sumFloors += b.floors
  if (b.x < minX) minX = b.x
  if (b.x > maxX) maxX = b.x
  if (b.z < minZ) minZ = b.z
  if (b.z > maxZ) maxZ = b.z
}

console.log('')
console.log('落点检查')
console.log(`  低于水面（会被淹）  ${underwater} 栋  ${underwater === 0 ? '✓' : '✗'}`)
console.log(`  落在陡坡上          ${tooSteep} 栋  ${tooSteep === 0 ? '✓' : '✗'}`)
console.log(`  贴地高程范围        ${minY.toFixed(1)} – ${maxY.toFixed(1)} m（相对场景最低点）`)
console.log(`  对应真实海拔        ${(meta.elevation.min + minY).toFixed(0)} – ${(meta.elevation.min + maxY).toFixed(0)} m`)
console.log(`  平均层数            ${(sumFloors / layout.length).toFixed(1)} 层`)
console.log('')
console.log('聚落范围')
console.log(`  东西 ${minX.toFixed(0)} .. ${maxX.toFixed(0)} m   跨度 ${(maxX - minX).toFixed(0)} m`)
console.log(`  南北 ${minZ.toFixed(0)} .. ${maxZ.toFixed(0)} m   跨度 ${(maxZ - minZ).toFixed(0)} m`)
console.log(`  面积约 ${(((maxX - minX) * (maxZ - minZ)) / 1e6).toFixed(3)} 平方公里`)

// 密度检查：古镇街区应有的密度
const streets = 16
console.log('')
console.log('密度参考')
console.log(`  按 ${streets} 条街巷估算，平均每条 ${(layout.length / streets).toFixed(1)} 栋`)

// 地标是否都落在聚落范围内（否则会出现"景点在房子外面"的怪事）
console.log('')
console.log('地标与聚落的关系')
for (const lm of landmarks) {
  let nearest = Infinity
  for (const b of layout) {
    const dd = Math.hypot(b.x - lm.x, b.z - lm.z)
    if (dd < nearest) nearest = dd
  }
  const ok = nearest < 120
  console.log(`  ${lm.name.padEnd(16)} 最近建筑 ${nearest.toFixed(0).padStart(4)} m  ${ok ? '✓ 在街区内' : '△ 较空旷'}`)
}

console.log('')
console.log('配色')
for (const [k, v] of Object.entries(SETTLEMENT_PALETTE)) console.log(`  ${k.padEnd(10)} ${v}`)
console.log('')
console.log('注意：这是**示意性聚落**，不是真实测绘轮廓。真实建筑轮廓数据我方无法获取，')
console.log('      OSM 在水磨古镇主街区几乎是空白。界面上必须标注"示意"。')
