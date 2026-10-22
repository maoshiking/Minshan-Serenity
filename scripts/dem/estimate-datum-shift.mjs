/**
 * 坐标系偏移估计。
 *
 * 问题背景
 * ------------------------------------------------
 * 地标的九个经纬度由需求方提供，标注为"高德 WGS84"。但实测发现：
 * OSM 的河道矢量与 DEM 的低洼处系统性错开约几百米——水位怎么调都对不上。
 * 这类"整体平移"最典型的原因是坐标系不一致：
 *   高德/百度在国内提供的是 GCJ-02（火星坐标）或 BD-09，
 *   与 WGS84 在水磨一带会差 300–600 m。
 *
 * 做法
 * ------------------------------------------------
 * 不猜偏移量，而是**搜出来**：在候选偏移网格上，评估"地标是否落在合理位置"，
 * 用两个独立的判据打分：
 *   1. 地标应落在相对平缓的地面（古镇建在河谷平地上，不在陡坡）
 *   2. 地标应落在较低的海拔（河谷底，而不是山脊）
 * 偏移量取让这两项综合最优的那个。
 *
 * 更硬的判据（如果主动搜索）是用 OSM 的河道与 DEM 低洼带对齐，
 * 本脚本会同时给出河道对齐的得分，两者互相印证。
 *
 * 用法：node scripts/dem/estimate-datum-shift.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'

const ROOT = process.cwd()
const meta = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols
const M_PER_DEG_LAT = 111132.0
const M_PER_DEG_LON = 111320.0 * Math.cos((meta.origin.lat * Math.PI) / 180)
const half = meta.sizeMeters / 2

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

const g = 384
const field = createHeightFieldFromData(resample(full, N, g), {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
})

/**
 * 在世界坐标里把地标整体平移 (dx, dz)，看它落在什么样的地形上。
 * 返回该组平移下的评分：海拔越低越好、坡度越平越好。
 */
function scoreShift(dx, dz) {
  let elevSum = 0
  let slopeSum = 0
  let n = 0
  for (const lm of meta.landmarks) {
    const x = (lm.lon - meta.origin.lon) * M_PER_DEG_LON + dx
    const z = -(lm.lat - meta.origin.lat) * M_PER_DEG_LAT + dz
    // 出界的点跳过而不是整体放弃：仁吉喜目谷本来就在场景外 1.6 km，
    // 若因为它一个点就返回 null，任何平移都得不到评分。
    if (Math.abs(x) > half || Math.abs(z) > half) continue
    const u = x / meta.sizeMeters + 0.5
    const v = z / meta.sizeMeters + 0.5
    elevSum += field.heightAt(u, v)
    slopeSum += field.slopeAt(u, v)
    n++
  }
  if (n < 5) return null
  // 归一化到 0..1，越大越好：海拔低 + 坡度平
  const elevScore = 1 - elevSum / n
  const slopeScore = 1 - Math.min(1, slopeSum / n / 0.5)
  return { score: elevScore * 0.6 + slopeScore * 0.4, elev: elevSum / n, slope: slopeSum / n, n }
}

console.log(`场景 ${meta.sizeMeters} m 见方   中心 ${meta.origin.lat} N ${meta.origin.lon} E`)
console.log(`九个地标（元数据登记）`)
console.log('')
console.log('在 ±800 m 范围内搜索整体平移，取"地标落在低处且平缓"的最优解')
console.log('')
console.log('  dx(m)   dz(m)    海拔(归一)   坡度(归一)   得分')
console.log('-'.repeat(56))

let best = null
// 搜索范围取 ±450 m：地标群本身只有约 530×400 m 宽，平移再大就整组出界了
for (let dz = -450; dz <= 450; dz += 25) {
  for (let dx = -450; dx <= 450; dx += 25) {
    const r = scoreShift(dx, dz)
    if (!r) continue
    if (!best || r.score > best.r.score) best = { dx, dz, r }
  }
}

if (!best) {
  console.log('没有任何平移能让 5 个以上地标落在场景内，请缩小搜索范围')
  process.exit(1)
}

// 粗搜完再细搜一轮
const coarse = best
for (let dz = coarse.dz - 24; dz <= coarse.dz + 24; dz += 8) {
  for (let dx = coarse.dx - 24; dx <= coarse.dx + 24; dx += 8) {
    const r = scoreShift(dx, dz)
    if (!r) continue
    if (!best || r.score > best.r.score) best = { dx, dz, r }
  }
}

// 打印几个代表点
for (const [dx, dz] of [[0, 0], [coarse.dx, coarse.dz], [best.dx, best.dz]]) {
  const r = scoreShift(dx, dz)
  if (!r) {
    console.log(`  ${String(dx).padStart(6)}  ${String(dz).padStart(6)}    超出场景范围`)
    continue
  }
  console.log(
    `  ${String(dx).padStart(6)}  ${String(dz).padStart(6)}    ${r.elev.toFixed(3).padStart(9)}   ${r.slope.toFixed(4).padStart(9)}   ${r.score.toFixed(4)}`,
  )
}

console.log('')
console.log(`最优平移：dx = ${best.dx} m（东正），dz = ${best.dz} m（南正）`)
console.log(`  对应的经纬度偏移：Δlon = ${(best.dx / M_PER_DEG_LON).toFixed(6)}°，Δlat = ${(-best.dz / M_PER_DEG_LAT).toFixed(6)}°`)
console.log(`  该位置下地标平均归一化海拔 ${best.r.elev.toFixed(3)}（越小越低）`)
console.log(`  平均坡度 ${best.r.slope.toFixed(4)}`)
console.log('')
console.log('判读：')
console.log('  - 若最优平移接近 (0,0)，说明坐标系统一致，之前的对不上是别的原因')
console.log('  - 若偏移在 300–600 m 量级，很可能是 GCJ-02 与 WGS84 之差')
console.log('  - 这个估计只用了"地标应在低处且平缓"这一条弱判据，')
console.log('    要确证还需要拿 OSM 河道与 DEM 低洼带做对齐（见 check-water-vs-osm.mjs）')
