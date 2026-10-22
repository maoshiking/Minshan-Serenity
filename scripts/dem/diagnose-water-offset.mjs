/**
 * 逐点诊断：把 OSM 河道与地形水面沿河道走向切片，比较"实际河道位置的 DEM 高程"
 * 与"地形判为水的位置的 DEM 高程"，定位这 250–330 m 的错位到底出在哪一侧。
 *
 * 背景：分布图显示两者是两条平行斜线。究竟是
 *   (a) OSM 河道标错了位置（落在坡上），还是
 *   (b) 地形水面判错了位置（淹了一片不是河道的地方）
 * 只能靠高程判定——真正的河必然在局部最低处。
 *
 * 用法：node scripts/dem/diagnose-water-offset.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { pickBand } from '../../src/three/terrainMesh.js'

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

const g = 512
const field = createHeightFieldFromData(resample(full, N, g), {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
})
const span = meta.elevation.span
const cellM = meta.sizeMeters / (g - 1)

// ---- OSM 河道 ----
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
let river = null
while ((m = wayRe.exec(xml))) {
  const body = m[2]
  const tags = {}
  const tagRe = /<tag k="([^"]+)" v="([^"]*)"/g
  let t
  while ((t = tagRe.exec(body))) tags[t[1]] = t[2]
  if (tags.waterway !== 'river') continue
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
  if (pts.length > 5 && (!river || pts.length > river.length)) river = pts.map((p) => ({ ...p, name: tags.name }))
}
if (!river) {
  console.log('没取到河道折线')
  process.exit(1)
}
console.log(`河道「${river[0].name}」共 ${river.length} 点`)

/** 世界坐标 → 归一化高度 */
function hAt(x, z) {
  const u = x / meta.sizeMeters + 0.5
  const v = z / meta.sizeMeters + 0.5
  if (u < 0 || u > 1 || v < 0 || v > 1) return null
  return field.heightAt(u, v)
}
function elevAt(x, z) {
  const h = hAt(x, z)
  return h === null ? null : meta.elevation.min + h * span
}

/**
 * 沿河道逐个点，在垂直于河道走向的方向上找**局部最低点**。
 * 若 OSM 河道位置正确，它自己就应该是那个最低点（距离接近 0）。
 * 若河道整体偏了，垂直方向的最低点会落在旁边若干米处。
 */
console.log('')
console.log('沿河道逐点：OSM 河道位置的高程 vs 垂直方向上的局部最低点')
console.log('  点号   河道高程   垂直最低高程   最低点偏移(m)   备注')
console.log('-'.repeat(72))

const SCAN_M = 300
const STEP_M = 10
const offsets = []

for (let i = 2; i + 2 < river.length; i += 2) {
  const p = river[i]
  const a = river[i - 1]
  const b = river[i + 1]
  // 切向与法向
  let tx = b.x - a.x
  let tz = b.z - a.z
  const tl = Math.hypot(tx, tz) || 1
  tx /= tl
  tz /= tl
  const nx = -tz
  const nz = tx

  const base = elevAt(p.x, p.z)
  if (base === null) continue

  let bestE = Infinity
  let bestOff = 0
  for (let o = -SCAN_M; o <= SCAN_M; o += STEP_M) {
    const e = elevAt(p.x + nx * o, p.z + nz * o)
    if (e !== null && e < bestE) {
      bestE = e
      bestOff = o
    }
  }
  offsets.push({ base, bestE, bestOff, x: p.x, z: p.z })
}

// 打印一部分
for (let k = 0; k < offsets.length; k += Math.max(1, Math.floor(offsets.length / 14))) {
  const o = offsets[k]
  console.log(
    `  ${String(k).padStart(4)}   ${o.base.toFixed(0).padStart(7)} m   ${o.bestE.toFixed(0).padStart(10)} m   ${o.bestOff.toFixed(0).padStart(11)}   ${Math.abs(o.bestOff) < 40 ? '河道就在谷底 ✓' : '河道偏离谷底'}`,
  )
}

const nearZero = offsets.filter((o) => Math.abs(o.bestOff) < 40).length
const avgDrop = offsets.reduce((s, o) => s + (o.base - o.bestE), 0) / offsets.length
const avgOffset = offsets.reduce((s, o) => s + o.bestOff, 0) / offsets.length
console.log('')
console.log(`河道点 ${offsets.length} 个，其中 ${nearZero} 个（${((nearZero / offsets.length) * 100).toFixed(0)}%）的垂直最低点就在 40 m 内`)
console.log(`河道位置比局部最低点平均高 ${avgDrop.toFixed(1)} m`)
console.log(`垂直偏移的带符号均值 ${avgOffset.toFixed(1)} m`)

// ---- 地形水面到底在哪 ----
console.log('')
console.log('地形判为水的格点，其高程分布：')
const waterKeys = new Set(['deepWater', 'shallowWater'])
let wCount = 0
let wSum = 0
let wMin = Infinity
let wMax = -Infinity
const wPositions = []
for (let j = 0; j < g; j += 2) {
  for (let i = 0; i < g; i += 2) {
    const u = i / (g - 1)
    const v = j / (g - 1)
    const band = pickBand(field.heightAt(u, v), field.slopeAt(u, v), field.waterLevel, field.heightScale)
    if (!waterKeys.has(band)) continue
    const e = meta.elevation.min + field.heightAt(u, v) * span
    wCount++
    wSum += e
    if (e < wMin) wMin = e
    if (e > wMax) wMax = e
    wPositions.push({ x: (u - 0.5) * meta.sizeMeters, z: (v - 0.5) * meta.sizeMeters })
  }
}
console.log(`  格点数 ${wCount}   高程 ${wMin.toFixed(0)} – ${wMax.toFixed(0)} m   均值 ${(wSum / wCount).toFixed(0)} m`)

/** 地形水点到 OSM 河道的最近距离 */
function distToRiver(px, pz) {
  let best = Infinity
  for (let k = 0; k + 1 < river.length; k++) {
    const a = river[k]
    const b = river[k + 1]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len2 = dx * dx + dz * dz
    let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz))
    if (d < best) best = d
  }
  return best
}
const dists = wPositions.map((p) => distToRiver(p.x, p.z)).sort((a, b) => a - b)
console.log(`  地形水点到 OSM 河道的距离：中位 ${dists[Math.floor(dists.length / 2)].toFixed(0)} m  最小 ${dists[0].toFixed(0)} m  最大 ${dists[dists.length - 1].toFixed(0)} m`)
console.log('')
console.log('判读：')
console.log('  - 若"河道位置比局部最低点平均高"很大（如 > 20 m），说明 OSM 河道画在坡上，')
console.log('    而 DEM 的谷底在别处 → OSM 与 DEM 之间存在系统性错位。')
console.log('  - 若两者接近（< 10 m），说明 OSM 河道位置正确，')
console.log('    那地形水面被判到离河道几百米外，就是水位或色带判据的问题。')
