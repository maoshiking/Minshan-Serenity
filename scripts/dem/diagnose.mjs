/**
 * 地形诊断：量化 DEM 的坡度与高度分布，用来给色带阈值定标。
 *
 * 为什么需要它：现有 pickBand 的阈值（0.38 / 0.6）是为程序化地形调的，
 * 真实岷山地形陡得多，沿用会把 80% 的面积判成裸岩。阈值该定在哪，
 * 只能由实测分布决定，不能凭感觉调。
 *
 * 用法：node scripts/dem/diagnose.mjs [gridSize]
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DEM_DIR = join(ROOT, 'public', 'terrain')

const gridArg = Number(process.argv[2] || 256)

const meta = JSON.parse(await readFile(join(DEM_DIR, 'shuimo-dem.json'), 'utf8'))
const buf = await readFile(join(DEM_DIR, 'shuimo-dem.bin'))
const full = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

// 降采样到诊断网格（双线性）
function resample(src, n, target) {
  if (target === n) return src
  const last = n - 1
  const out = new Float32Array(target * target)
  for (let j = 0; j < target; j++) {
    const g = (j / (target - 1)) * last
    const j0 = Math.min(Math.floor(g), last - 1)
    const t = g - j0
    for (let i = 0; i < target; i++) {
      const f = (i / (target - 1)) * last
      const i0 = Math.min(Math.floor(f), last - 1)
      const s = f - i0
      const hA = src[j0 * n + i0]
      const hB = src[j0 * n + i0 + 1]
      const hC = src[(j0 + 1) * n + i0]
      const hD = src[(j0 + 1) * n + i0 + 1]
      out[j * target + i] = (hA * (1 - s) + hB * s) * (1 - t) + (hC * (1 - s) + hD * s) * t
    }
  }
  return out
}

const N = Math.min(gridArg, meta.grid.cols)
const data = resample(full, meta.grid.cols, N)
const last = N - 1
const size = meta.sizeMeters
const cellSize = size / last
const span = meta.elevation.span

/** 与 heightField.normalAt 同一个算法：坡度 = 1 - normal.y，0 水平、1 垂直 */
function slopeAt(i, j) {
  const i0 = Math.min(i, last - 1)
  const j0 = Math.min(j, last - 1)
  const hA = data[j0 * N + i0]
  const hB = data[j0 * N + i0 + 1]
  const hC = data[(j0 + 1) * N + i0]
  const hD = data[(j0 + 1) * N + i0 + 1]

  let e1x, e1y, e1z, e2x, e2y, e2z
  if ((i - i0) >= (j - j0)) {
    e1x = cellSize; e1y = (hB - hA) * span; e1z = 0
    e2x = cellSize; e2y = (hD - hA) * span; e2z = cellSize
  } else {
    e1x = 0; e1y = (hC - hA) * span; e1z = cellSize
    e2x = cellSize; e2y = (hD - hA) * span; e2z = cellSize
  }
  let nx = e1y * e2z - e1z * e2y
  let ny = e1z * e2x - e1x * e2z
  let nz = e1x * e2y - e1y * e2x
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz }
  const len = Math.hypot(nx, ny, nz) || 1
  return 1 - ny / len
}

console.log(`诊断网格  ${N} x ${N}   格距 ${cellSize.toFixed(2)} m`)
console.log(`海拔      ${meta.elevation.min} .. ${meta.elevation.max} m  (高差 ${span} m)`)
console.log('')

// 坡度分布
const BINS = 20
const slopeHist = new Array(BINS).fill(0)
const slopes = new Float64Array(N * N)
let sum = 0
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const s = slopeAt(i, j)
    slopes[j * N + i] = s
    sum += s
    const b = Math.min(BINS - 1, Math.floor(s * BINS))
    slopeHist[b]++
  }
}

console.log('坡度分布（坡度 = 1 - 法线.y，数值越大越陡）')
let cum = 0
const total = N * N
for (let b = 0; b < BINS; b++) {
  const pct = (slopeHist[b] / total) * 100
  cum += pct
  const lo = (b / BINS).toFixed(2)
  const angle = (Math.asin(Math.min(1, b / BINS + 1 / BINS / 2)) * 180 / Math.PI).toFixed(0)
  console.log(
    `  ${lo.padStart(5)}  约 ${String(angle).padStart(2)}°  ${pct.toFixed(2).padStart(6)}%  累计 ${cum
      .toFixed(1)
      .padStart(5)}%  ${'#'.repeat(Math.max(1, Math.round(pct * 1.2)))}`,
  )
}
console.log(`\n平均坡度 ${(sum / total).toFixed(4)}   约 ${(Math.asin(Math.min(1, sum / total)) * 180 / Math.PI).toFixed(1)}°`)

// 分位数：给阈值定标用
const sorted = Float64Array.from(slopes).sort()
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
console.log('\n坡度分位数（现用阈值 0.38=岩 / 0.6=崖，看它们落在哪个分位）')
for (const p of [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
  const v = q(p)
  const ang = (Math.asin(Math.min(1, v)) * 180 / Math.PI).toFixed(1)
  console.log(`  P${String(Math.round(p * 100)).padStart(2)}  ${v.toFixed(4)}   约 ${ang.padStart(4)}°`)
}

// 按现用阈值统计配色结果
const waterLevel = meta.waterLevelCandidates?.min10pct ?? 0.1
let cliff = 0, rock = 0, other = 0
for (let k = 0; k < total; k++) {
  const s = slopes[k]
  if (s > 0.6) cliff++
  else if (s > 0.38) rock++
  else other++
}
console.log(`\n按现用阈值（>0.6 崖 / >0.38 岩）：`)
console.log(`  cliff ${((cliff / total) * 100).toFixed(1)}%   rock ${((rock / total) * 100).toFixed(1)}%   其余 ${((other / total) * 100).toFixed(1)}%`)

// 分辨率敏感性：格距变小，坡度会变大（DEM 的固有性质）
console.log('\n坡度对分辨率的敏感性（同一地形，不同网格）：')
for (const target of [128, 256, 512]) {
  const d = resample(full, meta.grid.cols, target)
  const cs = size / (target - 1)
  let acc = 0
  let cnt = 0
  for (let j = 0; j < target - 1; j += 2) {
    for (let i = 0; i < target - 1; i += 2) {
      const hA = d[j * target + i]
      const hB = d[j * target + i + 1]
      const hC = d[(j + 1) * target + i]
      const hD = d[(j + 1) * target + i + 1]
      const e1x = cs, e1y = (hB - hA) * span, e1z = 0
      const e2x = cs, e2y = (hD - hA) * span, e2z = cs
      const nx = e1y * e2z - e1z * e2y
      const ny = e1z * e2x - e1x * e2z
      const nz = e1x * e2y - e1y * e2x
      const len = Math.hypot(nx, ny, nz) || 1
      acc += 1 - Math.abs(ny) / len
      cnt++
    }
  }
  const avg = acc / cnt
  console.log(`  网格 ${String(target).padStart(3)}²  格距 ${cs.toFixed(2).padStart(6)} m   平均坡度 ${avg.toFixed(4)}  约 ${(Math.asin(Math.min(1, avg)) * 180 / Math.PI).toFixed(1)}°`)
}
