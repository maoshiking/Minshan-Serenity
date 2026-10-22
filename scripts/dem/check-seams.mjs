/**
 * 瓦片接缝检测：判断 DEM 里那些规则条纹是不是 z=15 瓦片拼接的接缝。
 *
 * 做法：把高程场沿行/列做一阶差分，统计"差分异常大"的位置落在哪。
 * 若这些位置的坐标恰好对上瓦片边界，就是接缝；否则是真实地貌（如梯田）。
 *
 * 用法：node scripts/dem/check-seams.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const meta = JSON.parse(await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.bin'))
const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)

const N = meta.grid.cols
const size = meta.sizeMeters
const span = meta.elevation.span
const cell = size / (N - 1)
const z = meta.tileZoom ?? 15

console.log(`网格 ${N}²   格距 ${cell.toFixed(2)} m   瓦片层级 z=${z}`)
console.log('')

// 行列一阶差分的绝对值统计
function diffStats(axis) {
  const diffs = []
  const outer = N
  const inner = N - 1
  for (let a = 0; a < outer; a++) {
    let acc = 0
    for (let b = 0; b < inner; b++) {
      const i = axis === 'row' ? a * N + b : b * N + a
      const j = axis === 'row' ? a * N + b + 1 : (b + 1) * N + a
      acc += Math.abs(data[j] - data[i])
    }
    diffs.push((acc / inner) * span) // 换算成真实米
  }
  return diffs
}

const rowDiffs = diffStats('row') // 沿 x 方向（东西）的变化，反映南北向的接缝
const colDiffs = diffStats('col') // 沿 z 方向（南北）的变化，反映东西向的接缝

function summarize(name, diffs) {
  const sorted = [...diffs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const p90 = sorted[Math.floor(sorted.length * 0.9)]
  const p99 = sorted[Math.floor(sorted.length * 0.99)]
  const max = sorted[sorted.length - 1]
  console.log(`${name}：中位 ${median.toFixed(3)} m   P90 ${p90.toFixed(3)} m   P99 ${p99.toFixed(3)} m   最大 ${max.toFixed(3)} m`)

  // 找出显著异常的索引
  const threshold = median * 3 + 0.5
  const spikes = []
  diffs.forEach((d, i) => {
    if (d > threshold) spikes.push({ i, d })
  })
  spikes.sort((a, b) => b.d - a.d)
  console.log(`  超过阈值 ${threshold.toFixed(3)} m 的位置数：${spikes.length}`)
  if (spikes.length) {
    const top = spikes.slice(0, 8)
    console.log('  最显著的几个位置：')
    for (const s of top) {
      // 换算成经纬度
      const frac = (s.i + 0.5) / (N - 1)
      const lonOrLat = frac
      console.log(
        `    索引 ${String(s.i).padStart(4)}  差分 ${s.d.toFixed(3)} m  位置比例 ${lonOrLat.toFixed(4)}`,
      )
    }
  }
  return { median, p90, p99, max, spikes }
}

const r = summarize('沿 x 的差分（南北向条纹）', rowDiffs)
console.log('')
const c = summarize('沿 z 的差分（东西向条纹）', colDiffs)

console.log('')
console.log('瓦片边界参考位置（z=15，切平面近似）：')
const M_PER_DEG_LAT = 111132.0
const M_PER_DEG_LON = 111320.0 * Math.cos((meta.origin.lat * Math.PI) / 180)
const n = 2 ** z
// 本场景覆盖的瓦片范围
const west = meta.bounds.west
const east = meta.bounds.east
const north = meta.bounds.north
const south = meta.bounds.south
const tx0 = Math.floor(((west + 180) / 360) * n)
const tx1 = Math.floor(((east + 180) / 360) * n)
const deg2ty = (lat) => {
  const r2 = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r2) + 1 / Math.cos(r2)) / Math.PI) / 2) * n
}
const ty0 = Math.floor(deg2ty(north))
const ty1 = Math.floor(deg2ty(south))

const xWorld = (lon) => (lon - meta.origin.lon) * M_PER_DEG_LON
const zWorld = (lat) => -(lat - meta.origin.lat) * M_PER_DEG_LAT
const uOf = (x) => x / size + 0.5
const vOf = (z) => z / size + 0.5

const westEdge = []
for (let tx = tx0 + 1; tx <= tx1; tx++) {
  const lon = (tx / n) * 360 - 180
  westEdge.push({ lon, u: uOf(xWorld(lon)) })
}
console.log('  东西向瓦片边界（u 值）：', westEdge.map((e) => e.u.toFixed(4)).join(', '))
console.log('  东西向瓦片边界（像素索引）：', westEdge.map((e) => Math.round(e.u * (N - 1))).join(', '))

const southEdge = []
for (let ty = ty0 + 1; ty <= ty1; ty++) {
  const mm = Math.PI - (2 * Math.PI * ty) / n
  const lat = (Math.atan(Math.sinh(mm)) * 180) / Math.PI
  southEdge.push({ lat, v: vOf(zWorld(lat)) })
}
console.log('  南北向瓦片边界（v 值）：', southEdge.map((e) => e.v.toFixed(4)).join(', '))
console.log('  南北向瓦片边界（像素索引）：', southEdge.map((e) => Math.round(e.v * (N - 1))).join(', '))

console.log('')
console.log('判读：若上面列出的"最显著位置"与瓦片边界的像素索引吻合，则为接缝伪影；')
console.log('      若完全对不上，则是真实地貌（如水磨一带常见的梯田）。')
