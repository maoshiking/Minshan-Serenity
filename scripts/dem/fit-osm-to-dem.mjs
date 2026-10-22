/**
 * 用 OSM 水系矢量与 DEM 低洼带对齐，直接搜出坐标系偏移量。
 *
 * 为什么用这个判据
 * ------------------------------------------------
 * 之前用"地标应落在低处且平缓"做代理判据，搜出来的是 dx=-300 / dz=-375。
 * 但把 OSM 河道按这个量平移后，河道整条被推出场景、IoU 掉到 0——说明代理判据
 * 把偏移量搜到了错误的方向（它只要求"更平更低"，而场景里最平最低的地方
 * 恰好是河边一大片砾石滩，所以往那一挪分数就涨）。
 *
 * 真正硬的判据只有一个：**OSM 的河道矢量必须落在地形的最低地带**。
 * 河流必然在谷底，这不需要任何假设。所以直接扫偏移网格，
 * 取"OSM 水系掩膜与地形最低 N% 区域重叠最多"的解。
 *
 * 用法：node scripts/dem/fit-osm-to-dem.mjs
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

// ---- 拉 OSM 水系 ----
const bbox = `${(meta.origin.lon - half / M_PER_DEG_LON).toFixed(5)},${(meta.origin.lat - half / M_PER_DEG_LAT).toFixed(5)},${(meta.origin.lon + half / M_PER_DEG_LON).toFixed(5)},${(meta.origin.lat + half / M_PER_DEG_LAT).toFixed(5)}`
const res = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`, {
  headers: { 'User-Agent': 'MinshanShoujing/0.1 (terrain prep)' },
})
const xml = await res.text()

const nodeRe = /<node id="(-?\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g
const nodes = new Map()
let m
while ((m = nodeRe.exec(xml))) nodes.set(m[1], { lat: Number(m[2]), lon: Number(m[3]) })

const wayRe = /<way id="(-?\d+)"[^>]*>([\s\S]*?)<\/way>/g
const riverLines = []
const waterPolys = []
while ((m = wayRe.exec(xml))) {
  const body = m[2]
  const tags = {}
  const tagRe = /<tag k="([^"]+)" v="([^"]*)"/g
  let t
  while ((t = tagRe.exec(body))) tags[t[1]] = t[2]
  const isRiver = ['river', 'stream', 'canal'].includes(tags.waterway)
  const isWater = tags.natural === 'water' || tags.landuse === 'reservoir' || !!tags.water
  if (!isRiver && !isWater) continue
  const refs = []
  const ndRe = /<nd ref="(-?\d+)"/g
  let n2
  while ((n2 = ndRe.exec(body))) refs.push(n2[1])
  const pts = []
  for (const r of refs) {
    const n = nodes.get(r)
    if (!n) continue
    pts.push({ x: (n.lon - meta.origin.lon) * M_PER_DEG_LON, z: -(n.lat - meta.origin.lat) * M_PER_DEG_LAT })
  }
  if (pts.length < 2) continue
  if (isRiver) riverLines.push({ pts })
  else waterPolys.push({ pts })
}
console.log(`OSM：河道 ${riverLines.length} 条，水面多边形 ${waterPolys.length} 个`)

// ---- 地形最低带 ----
const CELL = 4
const cols = Math.ceil(g / CELL)
const elevGrid = new Float32Array(cols * cols)
const samples = []
for (let j = 0; j < g; j += CELL) {
  for (let i = 0; i < g; i += CELL) {
    const by = Math.floor(j / CELL)
    const bx = Math.floor(i / CELL)
    const h = field.heightAt(i / (g - 1), j / (g - 1))
    elevGrid[by * cols + bx] = h
    samples.push({ x: (i / (g - 1) - 0.5) * meta.sizeMeters, z: (j / (g - 1) - 0.5) * meta.sizeMeters, h, by, bx })
  }
}
// 取最低 8% 作为"谷底带"
const sortedH = samples.map((s) => s.h).sort((a, b) => a - b)
const lowThresh = sortedH[Math.floor(sortedH.length * 0.08)]
console.log(`地形最低 8% 阈值 = 归一化 ${lowThresh.toFixed(4)}（海拔 ${(meta.elevation.min + lowThresh * meta.elevation.span).toFixed(0)} m）`)

function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz))
}
function inPoly(px, pz, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.z > pz !== b.z > pz && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

/** 给定平移，算 OSM 水系掩膜与地形谷底带的命中率 */
function scoreShift(dx, dz) {
  let osmCount = 0
  let inLow = 0
  for (const s of samples) {
    const x = s.x - dx
    const z = s.z - dz
    let oW = false
    for (const r of riverLines) {
      for (let k = 0; k + 1 < r.pts.length; k++) {
        if (distToSeg(x, z, r.pts[k].x, r.pts[k].z, r.pts[k + 1].x, r.pts[k + 1].z) <= 14) { oW = true; break }
      }
      if (oW) break
    }
    if (!oW) for (const w of waterPolys) if (inPoly(x, z, w.pts)) { oW = true; break }
    if (!oW) continue
    osmCount++
    if (s.h <= lowThresh) inLow++
  }
  return { osmCount, inLow, hit: osmCount ? inLow / osmCount : 0 }
}

console.log('')
console.log('扫描 OSM 水系掩膜与地形谷底带的重合率（命中率越高说明对齐越好）')
console.log('  dx(m)   dz(m)   OSM落在场景内   其中在谷底带   命中率')
console.log('-'.repeat(62))

let best = null
for (let dz = -500; dz <= 500; dz += 50) {
  for (let dx = -500; dx <= 500; dx += 50) {
    const r = scoreShift(dx, dz)
    if (r.osmCount < 30) continue
    if (!best || r.hit > best.r.hit) best = { dx, dz, r }
  }
}
if (!best) {
  console.log('没有找到足够样本的平移组合')
  process.exit(1)
}
// 细搜
for (let dz = best.dz - 45; dz <= best.dz + 45; dz += 15) {
  for (let dx = best.dx - 45; dx <= best.dx + 45; dx += 15) {
    const r = scoreShift(dx, dz)
    if (r.osmCount < 30) continue
    if (r.hit > best.r.hit) best = { dx, dz, r }
  }
}

for (const [dx, dz] of [[0, 0], [best.dx, best.dz]]) {
  const r = scoreShift(dx, dz)
  console.log(
    `  ${String(dx).padStart(6)}  ${String(dz).padStart(6)}   ${String(r.osmCount).padStart(11)}   ${String(r.inLow).padStart(11)}   ${(r.hit * 100).toFixed(1)}%`,
  )
}

console.log('')
console.log(`最优：把 OSM 矢量平移 dx=${best.dx} m（东正） dz=${best.dz} m（南正）`)
console.log(`      命中率 ${(best.r.hit * 100).toFixed(1)}%（OSM 水系落在 DEM 最低 8% 带内的比例）`)
console.log(`      对应经纬度修正 Δlon=${(best.dx / M_PER_DEG_LON).toFixed(6)}° Δlat=${(-best.dz / M_PER_DEG_LAT).toFixed(6)}°`)
console.log('')
console.log('判读：命中率若明显高于 0 偏移（0 偏移的命中率见上表），说明确实存在坐标不一致；')
console.log('      最优平移量级在 300–600 m 时，基本可断定是 GCJ-02 与 WGS84 之差。')
