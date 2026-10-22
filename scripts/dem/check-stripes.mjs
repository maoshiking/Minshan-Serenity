/**
 * 条纹来源判定：定量分析俯视图里那些规则纹理是真实地貌（梯田）还是数据伪影。
 *
 * 为什么要单独做一次
 * ------------------------------------------------
 * 上一轮只查了"瓦片接缝处是否有异常跳变"，结论是没有接缝。但那只排除了
 * 一种伪影。规则条纹还有两个候选来源：
 *   1. 真实梯田 —— 岷山一带坡地梯田极常见，会是等高线方向的规则台阶
 *   2. 高程量化台阶 —— 30 m 分辨率 + 1/256 m 量化的数据插值后可能出现周期纹理
 *
 * 判据：
 *   - 真实梯田：条纹沿**等高线**方向，且随海拔呈台阶状（相邻条纹高差接近常数）
 *   - 量化伪影：条纹周期与网格步长（cellSize）相关，或与瓦片纹理尺寸相关
 *
 * 用法：node scripts/dem/check-stripes.mjs [grid]
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'

const g = Number(process.argv[2] || 256)
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

const data = resample(full, N, g)
const field = createHeightFieldFromData(data, {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
})
const span = meta.elevation.span
const cellMeters = meta.sizeMeters / (g - 1)

console.log(`网格 ${g}²   格距 ${cellMeters.toFixed(2)} m   DEM 原生精度约 4.1 m/像素`)
console.log('')

/**
 * 沿固定方向做一维高程剖面的自相关，看有没有周期性。
 * 有效的地貌特征（山脊、冲沟、梯田）会给出低频峰；
 * 数值伪影会给出与网格/瓦片尺寸严格对应的尖锐峰。
 */
function autocorrPeriod(series) {
  const n = series.length
  const mean = series.reduce((a, b) => a + b, 0) / n
  const dev = series.map((v) => v - mean)
  let var0 = 0
  for (const d of dev) var0 += d * d
  var0 /= n
  if (var0 < 1e-12) return { peaks: [], var0 }

  const peaks = []
  for (let lag = 2; lag < Math.min(80, n / 2); lag++) {
    let acc = 0
    for (let i = 0; i + lag < n; i++) acc += dev[i] * dev[i + lag]
    acc /= n - lag
    peaks.push({ lag, r: acc / var0 })
  }
  return { peaks, var0 }
}

// 取几条剖面：一块"看起来有条纹"的区域（图幅左上）
console.log('=== 剖面自相关（找出周期峰）===')
const samples = [
  { name: '左上区（条纹最明显）', i0: 60, j0: 60, len: 120, dir: 'x' },
  { name: '左上区（沿 y）', i0: 60, j0: 60, len: 120, dir: 'y' },
  { name: '河谷（对照组）', i0: 100, j0: 150, len: 120, dir: 'x' },
  { name: '右侧林区（对照组）', i0: 190, j0: 100, len: 60, dir: 'x' },
]

for (const s of samples) {
  const series = []
  for (let k = 0; k < s.len; k++) {
    const i = s.dir === 'x' ? s.i0 + k : s.i0
    const j = s.dir === 'y' ? s.j0 + k : s.j0
    if (i >= g || j >= g) break
    series.push(data[j * g + i] * span)
  }
  if (series.length < 20) {
    console.log(`  ${s.name}：样本不足`)
    continue
  }
  const { peaks } = autocorrPeriod(series)
  // 找 r 最大的三个 lag
  const top = [...peaks].sort((a, b) => b.r - a.r).slice(0, 3)
  const range = Math.max(...series) - Math.min(...series)
  console.log(`  ${s.name}  样本 ${series.length}  高差 ${range.toFixed(1)} m`)
  for (const p of top) {
    const periodM = p.lag * cellMeters
    console.log(
      `      周期 ${String(p.lag).padStart(3)} 格 = ${periodM.toFixed(1).padStart(6)} m   自相关 ${p.r.toFixed(3)}`,
    )
  }
}

console.log('')
console.log('=== 判读 ===')
console.log(`网格步长 ${cellMeters.toFixed(2)} m`)
console.log('若周期峰出现在"与格距成简单整数比"的位置（如恰好 4/8/16 格），更像数值伪影；')
console.log('若周期在 8–30 m 且各剖面的周期不一致，更像真实梯田（梯田宽度本就随坡度变化）。')

// 看高程值本身的台阶结构：量化会让高程分布出现梳齿状峰
console.log('')
console.log('=== 高程直方图（细粒度，看是否有量化梳齿）===')
const BINS = 60
const hist = new Array(BINS).fill(0)
const total = g * g
for (let k = 0; k < total; k++) {
  const b = Math.min(BINS - 1, Math.floor(data[k] * BINS))
  hist[b]++
}
const binM = span / BINS
for (let b = 0; b < BINS; b++) {
  const pct = (hist[b] / total) * 100
  if (pct < 0.15) continue
  const elev = (meta.elevation.min + b * binM).toFixed(0)
  console.log(`  ${String(elev).padStart(4)} m  ${pct.toFixed(2).padStart(5)}%  ${'#'.repeat(Math.max(1, Math.round(pct)))}`)
}
console.log('')
console.log('量化步长参考：1/256 m 量化在 ${span} m 高差上只相当于 ${(span/256/span*100).toFixed(4)}% 的归一化步长，')
console.log('在 60 分箱下每箱 ${binM.toFixed(1)} m，量化台阶完全不可见——所以梳齿若存在也不是量化造成的。')
