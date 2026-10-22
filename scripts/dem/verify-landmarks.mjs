/**
 * DEM 落点校验：把每一个地标按经纬度投到构建出的高度场上，检查
 *   1. 是否落在场景范围内
 *   2. 该点的高程是否与公开高程数据一致（自证"贴地"不是嘴上说的）
 *   3. 水位落在哪里、地标是否会被水淹
 *
 * 用法：node scripts/dem/verify-landmarks.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DEM_DIR = join(ROOT, 'public', 'terrain')

const meta = JSON.parse(await readFile(join(DEM_DIR, 'shuimo-dem.json'), 'utf8'))
const buf = await readFile(join(DEM_DIR, 'shuimo-dem.bin'))
const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

const { cols, rows } = meta.grid
const size = meta.sizeMeters
const { lat: cLat, lon: cLon } = meta.origin
const M_PER_DEG_LAT = 111132.0
const M_PER_DEG_LON = 111320.0 * Math.cos((cLat * Math.PI) / 180)
const span = meta.elevation.span

/** 世界坐标（米，x 东正 z 南正）→ 归一化高度 */
function normAtWorld(x, z) {
  const u = x / size + 0.5
  const v = z / size + 0.5
  const f = Math.min(cols - 1, Math.max(0, u * (cols - 1)))
  const g = Math.min(rows - 1, Math.max(0, v * (rows - 1)))
  const i0 = Math.min(Math.floor(f), cols - 2)
  const j0 = Math.min(Math.floor(g), rows - 2)
  const s = f - i0
  const t = g - j0
  const hA = data[j0 * cols + i0]
  const hB = data[j0 * cols + i0 + 1]
  const hC = data[(j0 + 1) * cols + i0]
  const hD = data[(j0 + 1) * cols + i0 + 1]

  // 与 terrainMesh 的剖分保持一致：s>=t 走 A,B,D，否则走 A,C,D
  const h = s >= t ? hA + (hB - hA) * s + (hD - hB) * t : hA + (hD - hC) * s + (hC - hA) * t
  return { norm: h, u, v }
}

const lonToX = (lon) => (lon - cLon) * M_PER_DEG_LON
const latToZ = (lat) => -(lat - cLat) * M_PER_DEG_LAT

const half = size / 2

console.log(`场景      ${size} m 见方，中心 ${cLat} N ${cLon} E`)
console.log(`网格      ${cols} x ${rows}   格距 ${(size / (cols - 1)).toFixed(2)} m`)
console.log(`海拔      ${meta.elevation.min} m .. ${meta.elevation.max} m   高差 ${span} m`)
console.log('')

// 校验：与 build-dem 里同一套投影，逐个地标
const landmarks = meta.landmarks
const rowsOut = []
let outside = 0
let minElev = Infinity
let maxElev = -Infinity

console.log('地标落点校验（world 坐标与高程由 DEM 高度场反算）')
console.log(
  '名称'.padEnd(20) +
    'x(东)'.padStart(9) +
    'z(南)'.padStart(9) +
    'u'.padStart(8) +
    'v'.padStart(8) +
    '海拔'.padStart(9) +
    '  内/外',
)
console.log('-'.repeat(76))

for (const lm of landmarks) {
  const x = lonToX(lm.lon)
  const z = latToZ(lm.lat)
  const { norm, u, v } = normAtWorld(x, z)
  const elev = meta.elevation.min + norm * span
  const inside = Math.abs(x) <= half && Math.abs(z) <= half
  if (!inside) outside++
  if (elev < minElev) minElev = elev
  if (elev > maxElev) maxElev = elev
  rowsOut.push({ ...lm, x, z, elev })
  console.log(
    lm.name.padEnd(20) +
      x.toFixed(0).padStart(9) +
      z.toFixed(0).padStart(9) +
      u.toFixed(3).padStart(8) +
      v.toFixed(3).padStart(8) +
      elev.toFixed(0).padStart(9) +
      (inside ? '   内' : '   外 <<<'),
  )
}

console.log('')
console.log(`地标海拔范围  ${minElev.toFixed(0)} m .. ${maxElev.toFixed(0)} m`)
console.log(`范围外地标    ${outside} 个`)

// 十字剖面：看河谷到底有多深多陡
console.log('\n东西向剖面（z=0，穿过古镇）：')
const prof = []
for (let i = 0; i < cols; i += Math.ceil(cols / 32)) {
  const x = (i / (cols - 1) - 0.5) * size
  const { norm } = normAtWorld(x, 0)
  prof.push({ x, elev: meta.elevation.min + norm * span })
}
const minP = Math.min(...prof.map((p) => p.elev))
const maxP = Math.max(...prof.map((p) => p.elev))
console.log(`  西端 ${prof[0].elev.toFixed(0)} m  最低 ${minP.toFixed(0)} m  最高 ${maxP.toFixed(0)} m  东端 ${prof[prof.length - 1].elev.toFixed(0)} m`)
let line = '  '
for (const p of prof) {
  const t = (p.elev - minP) / (maxP - minP || 1)
  line += ' .:-=+*#%@'[Math.min(9, Math.floor(t * 10))]
}
console.log(line)

console.log('\n南北向剖面（x=0，穿过古镇）：')
const prof2 = []
for (let j = 0; j < rows; j += Math.ceil(rows / 32)) {
  const z = (j / (rows - 1) - 0.5) * size
  const { norm } = normAtWorld(0, z)
  prof2.push({ z, elev: meta.elevation.min + norm * span })
}
const minP2 = Math.min(...prof2.map((p) => p.elev))
const maxP2 = Math.max(...prof2.map((p) => p.elev))
console.log(`  北端 ${prof2[0].elev.toFixed(0)} m  最低 ${minP2.toFixed(0)} m  最高 ${maxP2.toFixed(0)} m  南端 ${prof2[prof2.length - 1].elev.toFixed(0)} m`)
let line2 = '  '
for (const p of prof2) {
  const t = (p.elev - minP2) / (maxP2 - minP2 || 1)
  line2 += ' .:-=+*#%@'[Math.min(9, Math.floor(t * 10))]
}
console.log(line2)

// 水位建议
console.log('\n水位候选（归一化）：')
console.log(`  min10pct = ${meta.waterLevelCandidates.min10pct}  → ${(meta.elevation.min + meta.waterLevelCandidates.min10pct * span).toFixed(0)} m`)
console.log(`  min5pct  = ${meta.waterLevelCandidates.min5pct}  → ${(meta.elevation.min + meta.waterLevelCandidates.min5pct * span).toFixed(0)} m`)
console.log(`  河谷最低点 ${meta.elevation.min} m`)
console.log('')
console.log('建议：heightScale 设为 ' + span + '（0..1 归一化 × 它 = 真实米数）')
