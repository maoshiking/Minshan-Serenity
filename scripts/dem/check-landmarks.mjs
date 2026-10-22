/**
 * 地标落位自证：直接调用真实的 resolveLandmarks，把九个地标的世界坐标、
 * 贴地高程、真实海拔列出来，并与 build-dem 元数据里的经纬度交叉核对。
 *
 * 为什么要独立脚本：地标"看起来在那儿"和"确实在那儿"是两件事。
 * 坐标换算一旦有偏差，肉眼在地形上根本看不出来，只能靠数字核对。
 *
 * 用法：node scripts/dem/check-landmarks.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { resolveLandmarks, SHUIMO_LANDMARKS, LANDMARK_COLORS } from '../../src/three/landmarks.js'

const ROOT = process.cwd()
const meta = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols

// 与预览/应用一致：降到 256 格
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

const half = meta.sizeMeters / 2
const list = resolveLandmarks(meta, field)
const all = resolveLandmarks(meta, field, { onlyInside: false })

console.log(`场景 ${meta.sizeMeters} m 见方，中心 ${meta.origin.lat} N ${meta.origin.lon} E`)
console.log(`水位 ${field.waterLevel} → 水面海拔 ${(meta.elevation.min + field.waterLevel * meta.elevation.span).toFixed(0)} m`)
console.log('')
console.log('地标落位（world 坐标 y 为贴地高程；海拔为真实米数）')
console.log(
  '名称'.padEnd(18) + 'x(东)'.padStart(8) + 'z(南)'.padStart(8) + '贴地y'.padStart(9) +
    '海拔'.padStart(8) + '离中心'.padStart(9) + '  类别   核校',
)
console.log('-'.repeat(86))

let minElev = Infinity
let maxElev = -Infinity
for (const lm of all) {
  const dist = Math.hypot(lm.x, lm.z)
  const inside = Math.abs(lm.x) <= half && Math.abs(lm.z) <= half
  if (inside) {
    if (lm.elevation < minElev) minElev = lm.elevation
    if (lm.elevation > maxElev) maxElev = lm.elevation
  }
  console.log(
    lm.name.padEnd(18) +
      lm.x.toFixed(0).padStart(8) +
      lm.z.toFixed(0).padStart(8) +
      lm.y.toFixed(1).padStart(9) +
      lm.elevation.toFixed(0).padStart(8) +
      dist.toFixed(0).padStart(9) +
      `  ${lm.kind.padEnd(7)} ${lm.verified ? '已核' : '待核'}${inside ? '' : '  范围外'}`,
  )
}

console.log('')
console.log(`范围内地标 ${list.length} / ${all.length} 个`)
console.log(`地标海拔范围 ${minElev.toFixed(0)} – ${maxElev.toFixed(0)} m`)

// 与元数据里登记的经纬度交叉核对（防止两处数据走偏）
console.log('')
console.log('与 shuimo-dem.json 的 landmarks 字段交叉核对：')
let mismatch = 0
for (const a of SHUIMO_LANDMARKS) {
  const b = meta.landmarks.find((m) => m.name === a.name)
  if (!b) {
    console.log(`  ${a.name}：元数据里没有，跳过`)
    continue
  }
  const dLon = Math.abs(a.lon - b.lon)
  const dLat = Math.abs(a.lat - b.lat)
  if (dLon > 1e-9 || dLat > 1e-9) {
    mismatch++
    console.log(`  ${a.name}：不一致！Δlon ${dLon} Δlat ${dLat}`)
  }
}
console.log(mismatch === 0 ? '  全部一致 ✓' : `  ${mismatch} 处不一致`)

// 按类别统计
console.log('')
console.log('按类别（决定标记颜色）：')
const byKind = {}
for (const lm of list) byKind[lm.kind] = (byKind[lm.kind] || 0) + 1
for (const [k, n] of Object.entries(byKind)) {
  console.log(`  ${k.padEnd(8)} ${n} 个  色 ${LANDMARK_COLORS[k]}`)
}

// 贴地校验：直接把 y 与地形高度对照
console.log('')
console.log('贴地校验（y 与 surfaceHeightAt × heightScale 的差）：')
let maxErr = 0
for (const lm of list) {
  const u = lm.x / meta.sizeMeters + 0.5
  const v = lm.z / meta.sizeMeters + 0.5
  const expected = field.surfaceHeightAt(u, v) * field.heightScale
  const err = Math.abs(expected - lm.y)
  if (err > maxErr) maxErr = err
}
console.log(`  最大偏差 ${maxErr.toFixed(6)} m  ${maxErr < 1e-3 ? '✓ 严丝合缝' : '✗ 有偏差，需要查'}`)
