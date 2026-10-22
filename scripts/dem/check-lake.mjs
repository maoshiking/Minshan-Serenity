/**
 * 湖体诊断：地形判出的水到底在哪里、面积多大、与 OSM 的"南湖/鱼池"多边形是否对得上。
 *
 * 背景：OSM 在这一带有"南湖"与"鱼池"两个水面多边形，但俯视图里只看得到一小片蓝。
 * 需要确认：是水位不对（湖底高于水面所以没被淹）、还是湖的位置与 DEM 低洼处不重合。
 *
 * 用法：node scripts/dem/check-lake.mjs
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

const g = 512
const field = createHeightFieldFromData(resample(full, N, g), {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
})

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
const polys = []
while ((m = wayRe.exec(xml))) {
  const body = m[2]
  const tags = {}
  const tagRe = /<tag k="([^"]+)" v="([^"]*)"/g
  let t
  while ((t = tagRe.exec(body))) tags[t[1]] = t[2]
  const isWater = tags.natural === 'water' || tags.landuse === 'reservoir' || !!tags.water
  if (!isWater) continue
  const refs = []
  const ndRe = /<nd ref="(-?\d+)"/g
  let n2
  while ((n2 = ndRe.exec(body))) refs.push(n2[1])
  const ring = []
  for (const r of refs) {
    const n = nodes.get(r)
    if (!n) continue
    ring.push({ x: (n.lon - meta.origin.lon) * M_PER_DEG_LON, z: -(n.lat - meta.origin.lat) * M_PER_DEG_LAT })
  }
  if (ring.length < 3) continue
  polys.push({ name: tags.name || '(无名)', ring })
}

function hAtWorld(x, z) {
  const u = x / meta.sizeMeters + 0.5
  const v = z / meta.sizeMeters + 0.5
  if (u < 0 || u > 1 || v < 0 || v > 1) return null
  return field.heightAt(u, v)
}
const elevOf = (h) => meta.elevation.min + h * span

console.log(`水位 ${field.waterLevel} → 水面海拔 ${elevOf(field.waterLevel).toFixed(0)} m`)
console.log('')
console.log('OSM 水面多边形（取多边形内的高程统计）：')
console.log('  名称        顶点   中心(x,z)          高程 min/均/max      会被淹的格点占比')
console.log('-'.repeat(88))

for (const p of polys) {
  let cx = 0
  let cz = 0
  for (const q of p.ring) {
    cx += q.x
    cz += q.z
  }
  cx /= p.ring.length
  cz /= p.ring.length

  // 在多边形的包围盒内逐点采样，只统计"在多边形内"的点
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const q of p.ring) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x)
    minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z)
  }
  function inPoly(px, pz) {
    let inside = false
    const ring = p.ring
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (a.z > pz !== b.z > pz && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) inside = !inside
    }
    return inside
  }

  let n = 0, sum = 0, mn = Infinity, mx = -Infinity, flooded = 0
  const step = 4
  for (let z = minZ; z <= maxZ; z += step) {
    for (let x = minX; x <= maxX; x += step) {
      if (!inPoly(x, z)) continue
      const h = hAtWorld(x, z)
      if (h === null) continue
      const e = elevOf(h)
      n++
      sum += e
      if (e < mn) mn = e
      if (e > mx) mx = e
      if (h < field.waterLevel) flooded++
    }
  }
  if (!n) {
    console.log(`  ${p.name.padEnd(10)}  ${String(p.ring.length).padStart(4)}   采样点在场景外`)
    continue
  }
  console.log(
    `  ${p.name.padEnd(10)}  ${String(p.ring.length).padStart(4)}   (${cx.toFixed(0).padStart(5)}, ${cz.toFixed(0).padStart(5)})   ` +
      `${mn.toFixed(0).padStart(5)}/${(sum / n).toFixed(0).padStart(5)}/${mx.toFixed(0).padStart(5)} m   ` +
      `${((flooded / n) * 100).toFixed(0).padStart(5)}%`,
  )
}

console.log('')
console.log('判读：若"会被淹的格点占比"接近 0，说明湖底高于水面 → 水位偏低，湖出不来；')
console.log('      若接近 100% 但图上看不到，说明湖确实被淹了，只是面积小或颜色与砾石滩接近。')

// 统计地形判为水的连通块，看有几片水
const waterKeys = new Set(['deepWater', 'shallowWater'])
const mask = new Uint8Array(g * g)
let waterCells = 0
for (let j = 0; j < g; j++) {
  for (let i = 0; i < g; i++) {
    const u = i / (g - 1)
    const v = j / (g - 1)
    const band = pickBand(field.heightAt(u, v), field.slopeAt(u, v), field.waterLevel, field.heightScale)
    if (waterKeys.has(band)) {
      mask[j * g + i] = 1
      waterCells++
    }
  }
}
// 洪水填充统计连通块
const seen = new Uint8Array(g * g)
const blobs = []
for (let k = 0; k < g * g; k++) {
  if (!mask[k] || seen[k]) continue
  let size = 0
  let sumX = 0
  let sumZ = 0
  const stack = [k]
  seen[k] = 1
  while (stack.length) {
    const cur = stack.pop()
    const i = cur % g
    const j = (cur - i) / g
    size++
    sumX += i
    sumZ += j
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || nj < 0 || ni >= g || nj >= g) continue
      const nk = nj * g + ni
      if (mask[nk] && !seen[nk]) {
        seen[nk] = 1
        stack.push(nk)
      }
    }
  }
  const cellM = meta.sizeMeters / (g - 1)
  blobs.push({
    size,
    areaM2: size * cellM * cellM,
    cx: (sumX / size / (g - 1) - 0.5) * meta.sizeMeters,
    cz: (sumZ / size / (g - 1) - 0.5) * meta.sizeMeters,
  })
}
blobs.sort((a, b) => b.size - a.size)

console.log('')
console.log(`地形判为水的连通块 ${blobs.length} 个（总格点 ${waterCells}）：`)
for (const b of blobs.slice(0, 8)) {
  console.log(
    `  面积 ${(b.areaM2 / 10000).toFixed(2).padStart(6)} 公顷   中心 (${b.cx.toFixed(0).padStart(5)}, ${b.cz.toFixed(0).padStart(5)})   格点 ${b.size}`,
  )
}
console.log('')
console.log('对照：OSM 的"南湖"若面积明显大于最大连通块，说明湖没被完整淹出来。')
