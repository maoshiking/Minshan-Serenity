/**
 * 水位标定：找出"能覆盖河床、又不淹到地标"的那一档水位。
 *
 * 为什么需要专门标定：古镇与河谷的高差只有二三十米（893 m 河床 vs 937–986 m 地标），
 * 水位定低了河床会被判成草地（水面消失），定高了会把古镇淹掉。
 * 中间就那么窄一条，只能靠实测数字来卡。
 *
 * 用法：node scripts/dem/tune-water-level.mjs [grid]
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'

const g = Number(process.argv[2] || 256)

const meta = JSON.parse(await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols
const min = meta.elevation.min
const span = meta.elevation.span

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

const data = resample(full, N, g)
const field = createHeightFieldFromData(data, {
  resolution: g,
  size: meta.sizeMeters,
  heightScale: span,
  waterLevel: 0.05,
  slopeRadius: 2,
})

const M_PER_DEG_LAT = 111132.0
const M_PER_DEG_LON = 111320.0 * Math.cos((meta.origin.lat * Math.PI) / 180)
const half = meta.sizeMeters / 2

const elevOfNorm = (h) => min + h * span

console.log(`海拔区间 ${min} .. ${min + span} m`)
console.log('')

// 地标高程（用世界坐标反算）
console.log('八个古镇地标的高程与归一化高度：')
const inside = []
for (const lm of meta.landmarks) {
  const x = (lm.lon - meta.origin.lon) * M_PER_DEG_LON
  const z = -(lm.lat - meta.origin.lat) * M_PER_DEG_LAT
  if (Math.abs(x) > half || Math.abs(z) > half) continue
  const h = field.heightAt(x / meta.sizeMeters + 0.5, z / meta.sizeMeters + 0.5)
  inside.push({ name: lm.name, h, elev: elevOfNorm(h) })
}
inside.sort((a, b) => a.h - b.h)
for (const p of inside) {
  console.log(`  ${p.name.padEnd(16)} 归一化 ${p.h.toFixed(4)}   海拔 ${p.elev.toFixed(0)} m`)
}
const lowestLandmark = inside[0]

console.log('')
console.log('水位候选（waterLevel 是归一化值；水面海拔 = min + wl × span）：')
console.log('  水位   水面海拔   被淹格点占比   最低地标是否被淹')
console.log('-'.repeat(64))

const total = g * g
for (const wl of [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1]) {
  let below = 0
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      if (field.heightAt(i / (g - 1), j / (g - 1)) < wl) below++
    }
  }
  const flooded = (below / total) * 100
  const waterElev = elevOfNorm(wl)
  const drowns = wl > lowestLandmark.h
  console.log(
    `  ${wl.toFixed(3)}  ${waterElev.toFixed(0).padStart(6)} m   ${flooded.toFixed(2).padStart(9)}%      ${drowns ? '是 ← 不可用' : '否'}`,
  )
}

console.log('')
console.log(`最低地标是「${lowestLandmark.name}」（归一化 ${lowestLandmark.h.toFixed(4)}，海拔 ${lowestLandmark.elev.toFixed(0)} m）`)
console.log('水位必须低于这个值，否则会把古镇泡在水里。')

// 河床形态：沿河道看高度分布
console.log('')
console.log('最低 3% 高度带的水系面积占比（用于判断水面该多大）：')
const sorted = Float32Array.from(field.data).sort()
for (const p of [0.01, 0.02, 0.03, 0.05]) {
  const idx = Math.floor(p * sorted.length)
  const ele = elevOfNorm(sorted[idx])
  let cnt = 0
  for (let k = 0; k < sorted.length; k++) if (sorted[k] <= sorted[idx]) cnt++
  console.log(`  最低 ${(p * 100).toFixed(0).padStart(2)}% 以下：海拔 ≤ ${ele.toFixed(0)} m   占比 ${((cnt / sorted.length) * 100).toFixed(2)}%`)
}
