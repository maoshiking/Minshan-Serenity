/**
 * 水位扫描：用 OSM 河道矢量做真值，找出让"地形判出的水面"最贴合河位的那一档水位。
 *
 * 背景：水位 0.07 时，地形判出的水面与 OSM 河道是两条平行斜线，相隔 250–330 m。
 * 说明水位偏高，把河岸旁一片低地一并淹了。水位该定在哪，只能扫出来。
 *
 * 用法：node scripts/dem/tune-water-vs-osm.mjs
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

// 复用已抓到的 OSM 数据（避免重复请求）
const res = await fetch(
  `https://api.openstreetmap.org/api/0.6/map?bbox=${(meta.origin.lon - half / M_PER_DEG_LON).toFixed(5)},${(meta.origin.lat - half / M_PER_DEG_LAT).toFixed(5)},${(meta.origin.lon + half / M_PER_DEG_LON).toFixed(5)},${(meta.origin.lat + half / M_PER_DEG_LAT).toFixed(5)}`,
  { headers: { 'User-Agent': 'MinshanShoujing/0.1 (terrain prep)' } },
)
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

const g = 512
const data = resample(full, N, g)
const waterKeys = new Set(['deepWater', 'shallowWater'])

// 预先算好每个采样点的 OSM 真值与高程/坡度（与水位无关，只算一次）
const STEP = 2
const pts = []
for (let j = 0; j < g; j += STEP) {
  for (let i = 0; i < g; i += STEP) {
    const u = i / (g - 1)
    const v = j / (g - 1)
    const x = (u - 0.5) * meta.sizeMeters
    const z = (v - 0.5) * meta.sizeMeters

    let oW = false
    for (const r of riverLines) {
      for (let k = 0; k + 1 < r.pts.length; k++) {
        if (distToSeg(x, z, r.pts[k].x, r.pts[k].z, r.pts[k + 1].x, r.pts[k + 1].z) <= 12) {
          oW = true
          break
        }
      }
      if (oW) break
    }
    if (!oW) for (const w of waterPolys) if (inPoly(x, z, w.pts)) { oW = true; break }

    pts.push({ u, v, oW })
  }
}
const osmCount = pts.filter((p) => p.oW).length
console.log(`采样点 ${pts.length}，其中 OSM 判为水 ${osmCount} 个`)
console.log('')

// 扫描水位
console.log('水位      水面海拔    地形判水   命中 OSM   误判   漏判    IoU')
console.log('-'.repeat(72))

let best = null
for (const wl of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.07, 0.09, 0.12]) {
  const field = createHeightFieldFromData(data, {
    resolution: g,
    size: meta.sizeMeters,
    heightScale: meta.elevation.span,
    waterLevel: wl,
    slopeRadius: 2,
  })

  let tCount = 0
  let hit = 0
  let fp = 0
  let fn = 0
  for (const p of pts) {
    const band = pickBand(field.heightAt(p.u, p.v), field.slopeAt(p.u, p.v), wl, field.heightScale)
    const tW = waterKeys.has(band)
    if (tW) tCount++
    if (tW && p.oW) hit++
    else if (tW && !p.oW) fp++
    else if (!tW && p.oW) fn++
  }
  const iou = hit + fp + fn > 0 ? hit / (hit + fp + fn) : 0
  const elev = meta.elevation.min + wl * meta.elevation.span
  const mark = iou >= 0.45 ? ' ← 较好' : ''
  if (!best || iou > best.iou) best = { wl, iou, elev }
  console.log(
    `${wl.toFixed(3)}    ${elev.toFixed(0).padStart(5)} m    ${String(tCount).padStart(7)}    ${String(hit).padStart(6)}    ` +
      `${String(fp).padStart(5)}    ${String(fn).padStart(5)}    ${(iou * 100).toFixed(1)}%${mark}`,
  )
}

console.log('')
console.log(`最优水位 ${best.wl}（水面海拔 ${best.elev.toFixed(0)} m），IoU ${(best.iou * 100).toFixed(1)}%`)
console.log('')
console.log('参考：河谷最低点 ' + meta.elevation.min + ' m；最低地标（羌碉、西羌汇）940 m。')
console.log('水位必须在"能覆盖河床"与"不淹古镇"之间，这条窗口只有几十米宽。')
