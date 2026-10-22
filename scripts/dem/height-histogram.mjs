/**
 * 打印 DEM 的归一化高程分布，确认色带阈值该落在哪。
 *
 * 背景：色带统计一度显示 forest/darkForest 为 0%，但渲染图里明显有深绿林带。
 * 这种"统计与观感不符"只能靠直接打分布来定位，猜是猜不出来的。
 *
 * 用法：node scripts/dem/height-histogram.mjs [grid]
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
const field = createHeightFieldFromData(data, {
  resolution: g,
  size: meta.sizeMeters,
  heightScale: meta.elevation.span,
  waterLevel: meta.waterLevelCandidates?.min10pct ?? 0.1,
})

console.log(`waterLevel = ${field.waterLevel}`)
console.log(`海拔区间   ${meta.elevation.min} .. ${meta.elevation.max} m   高差 ${meta.elevation.span} m`)
console.log('')

// 归一化高程直方图
const BINS = 25
const hist = new Array(BINS).fill(0)
let sum = 0
for (let j = 0; j < g; j++) {
  for (let i = 0; i < g; i++) {
    const h = field.heightAt(i / (g - 1), j / (g - 1))
    sum += h
    hist[Math.min(BINS - 1, Math.floor(h * BINS))]++
  }
}
const total = g * g
console.log(`归一化高程分布（均值 ${(sum / total).toFixed(3)}）`)
let cum = 0
for (let b = 0; b < BINS; b++) {
  const pct = (hist[b] / total) * 100
  cum += pct
  const lo = (b / BINS).toFixed(2)
  const elev = (meta.elevation.min + (b / BINS) * meta.elevation.span).toFixed(0)
  console.log(
    `  ${lo}  ${String(elev).padStart(4)} m  ${pct.toFixed(2).padStart(6)}%  累计 ${cum
      .toFixed(1)
      .padStart(5)}%  ${'#'.repeat(Math.max(1, Math.round(pct * 1.5)))}`,
  )
}

// 当前阈值会切出什么
const wl = field.waterLevel
console.log('\n当前 pickBand 的高度分界（由 waterLevel 推算）：')
const cuts = [
  ['deepWater 以下', wl - 0.035],
  ['shallowWater', wl + 0.004],
  ['sand', wl + 0.045],
  ['field', wl + 0.062],
  ['meadow', 0.34],
  ['forest', 0.52],
  ['darkForest', 0.7],
  ['forest', 0.88],
  ['meadow', 0.95],
]
for (const [name, v] of cuts) {
  const elev = (meta.elevation.min + v * meta.elevation.span).toFixed(0)
  console.log(`  < ${v.toFixed(3)}  (${elev} m)  → ${name}`)
}

// 按当前阈值算实际占比，并和渲染统计交叉验证
const counts = {}
for (let j = 0; j < g; j++) {
  for (let i = 0; i < g; i++) {
    const u = i / (g - 1)
    const v = j / (g - 1)
    const { pickBand } = await import('../../src/three/terrainMesh.js')
    const band = pickBand(field.heightAt(u, v), field.slopeAt(u, v), wl, field.heightScale)
    counts[band] = (counts[band] || 0) + 1
  }
}
console.log('\n按 pickBand 实算的占比（应与预览脚本的统计一致）：')
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(13)} ${((v / total) * 100).toFixed(2).padStart(6)}%`)
}
