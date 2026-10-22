/**
 * 坡度采样半径标定：把 slopeRadius = 1..6 的分位数全部列出来，据此选一个既不被
 * 量化噪声主导、又能表达真实山坡陡缓的基线。
 *
 * 背景：同一个 DEM，半径 1 的中位坡度是 33°，半径 4 只有 2.7°。差这么多，
 * 说明两者量的根本不是同一件事——前者量的是 DEM 像素内的插值斜坡（含噪声），
 * 后者量的是 25 m 尺度的区域坡度。真实山坡的陡缓应该落在中间某个尺度上。
 *
 * 用法：node scripts/dem/tune-slope-radius.mjs [grid]
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'

const g = Number(process.argv[2] || 256)

const meta = JSON.parse(await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.bin'))
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

const data = resample(full, N, g)
const cellMeters = meta.sizeMeters / (g - 1)

console.log(`网格 ${g}²   格距 ${cellMeters.toFixed(2)} m   DEM 原生精度约 4.1 m/像素`)
console.log('')
console.log('半径  物理基线    P50        P75        P90        P95        P99        最大')
console.log('-'.repeat(92))

for (const radius of [1, 2, 3, 4, 6]) {
  const field = createHeightFieldFromData(data, {
    resolution: g,
    size: meta.sizeMeters,
    heightScale: meta.elevation.span,
    waterLevel: meta.waterLevelCandidates?.min10pct ?? 0.1,
    slopeRadius: radius,
  })

  const slopes = []
  for (let j = 0; j < g; j += 2) {
    for (let i = 0; i < g; i += 2) {
      slopes.push(field.slopeAt(i / (g - 1), j / (g - 1)))
    }
  }
  slopes.sort((a, b) => a - b)
  const q = (p) => slopes[Math.min(slopes.length - 1, Math.floor(p * slopes.length))]
  const deg = (v) => `${((Math.asin(Math.min(1, v)) * 180) / Math.PI).toFixed(1)}°`

  console.log(
    `${String(radius).padStart(4)}  ${(radius * cellMeters).toFixed(1).padStart(7)} m  ` +
      `${q(0.5).toFixed(3)} ${deg(q(0.5)).padStart(6)}  ` +
      `${q(0.75).toFixed(3)} ${deg(q(0.75)).padStart(6)}  ` +
      `${q(0.9).toFixed(3)} ${deg(q(0.9)).padStart(6)}  ` +
      `${q(0.95).toFixed(3)} ${deg(q(0.95)).padStart(6)}  ` +
      `${q(0.99).toFixed(3)} ${deg(q(0.99)).padStart(6)}  ` +
      `${q(1).toFixed(3)} ${deg(q(1)).padStart(6)}`,
  )
}

console.log('')
console.log('选取指引：')
console.log('  - 物理基线应不小于 DEM 原生精度（4.1 m），否则量到的是插值噪声')
console.log('  - 也不宜超过约 30 m，否则量到的是区域坡度而不是山坡')
console.log('  - 参考真实地形：谷深 349 m / 谷宽约 800 m，谷壁平均坡度约 22–25°')
