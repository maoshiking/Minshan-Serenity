/**
 * 用 OSM 的真实水系矢量校验地形的水面判定。
 *
 * 为什么不用影像像素判据
 * ------------------------------------------------
 * 起初想从截来的地图瓦片里"找蓝色像素"当水面真值，结果失败了：
 * OSM 的黄色公路（#f5d76e 之类）也满足 b > r 之类的粗糙判据，
 * 于是整条 S216 被当成河，IoU 掉到 6.6%，还差点让我以为坐标错位。
 * 教训：拿别人的渲染图做像素级真值，必须先把渲染图里的图例搞清楚。
 *
 * 改用矢量就干净了：waterway=river / natural=water 的多边形与折线
 * 是权威的位置，不受渲染配色影响。
 *
 * 用法：node scripts/dem/check-water-vs-osm.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { pickBand } from '../../src/three/terrainMesh.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DEM_DIR = join(ROOT, 'public', 'terrain')

const meta = JSON.parse(await readFile(join(DEM_DIR, 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(DEM_DIR, 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols

const M_PER_DEG_LAT = 111132.0
const M_PER_DEG_LON = 111320.0 * Math.cos((meta.origin.lat * Math.PI) / 180)
const half = meta.sizeMeters / 2

/**
 * OSM 数据的整体平移修正（米，东正 / 南正）。
 *
 * 由 estimate-datum-shift.mjs 搜出来：需求方给的经纬度虽然标注为 WGS84，
 * 但实测与 DEM 低洼带系统性错开约 480 m，符合 GCJ-02 与 WGS84 之差。
 * 这里把 OSM 矢量平移，用来验证"平移后水系能否与地形低洼带对齐"。
 * 从环境变量读，方便扫描；不设则按 0 处理（原始对齐）。
 */
const SHIFT_X = Number(process.env.SHIFT_X || 0)
const SHIFT_Z = Number(process.env.SHIFT_Z || 0)
const lonOf = (x) => meta.origin.lon + x / M_PER_DEG_LON
const latOf = (z) => meta.origin.lat - z / M_PER_DEG_LAT

// ---- 从 OSM 拉水系 ----
const bbox = `${lonOf(-half).toFixed(5)},${latOf(half).toFixed(5)},${lonOf(half).toFixed(5)},${latOf(-half).toFixed(5)}`
console.log(`OSM 矢量平移修正 dx=${SHIFT_X} m dz=${SHIFT_Z} m`)
console.log(`向 OSM 请求水系，bbox=${bbox}`)
const res = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`, {
  headers: { 'User-Agent': 'MinshanShoujing/0.1 (terrain prep)' },
})
if (!res.ok) {
  console.error(`OSM 请求失败 HTTP ${res.status}`)
  process.exit(1)
}
const xml = await res.text()
console.log(`收到 ${(xml.length / 1024).toFixed(0)} KB`)

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

  const isRiver = tags.waterway === 'river' || tags.waterway === 'stream' || tags.waterway === 'canal'
  const isWater = tags.natural === 'water' || tags.landuse === 'reservoir' || tags.water
  if (!isRiver && !isWater) continue

  const refs = []
  const ndRe = /<nd ref="(-?\d+)"/g
  let n2
  while ((n2 = ndRe.exec(body))) refs.push(n2[1])

  const pts = []
  for (const r of refs) {
    const n = nodes.get(r)
    if (!n) continue
    pts.push({
      x: (n.lon - meta.origin.lon) * M_PER_DEG_LON + SHIFT_X,
      z: -(n.lat - meta.origin.lat) * M_PER_DEG_LAT + SHIFT_Z,
    })
  }
  if (pts.length < 2) continue

  if (isRiver) riverLines.push({ id: m[1], name: tags.name || '', pts, tags })
  if (isWater) waterPolys.push({ id: m[1], name: tags.name || '', pts, tags })
}

console.log(`河道折线 ${riverLines.length} 条，水面多边形 ${waterPolys.length} 个`)
const namedRivers = riverLines.filter((r) => r.name)
for (const r of namedRivers.slice(0, 8)) console.log(`  河：${r.name}（${r.pts.length} 点）`)
const namedWater = waterPolys.filter((w) => w.name)
for (const w of waterNamed(namedWater).slice(0, 8)) console.log(`  水：${w.name}（${w.pts.length} 点）`)
function waterNamed(a) {
  return a
}

// ---- 在网格上比对 ----
const g = 384
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

const field = createHeightFieldFromData(resample(full, N, g), {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
})

/** 点到线段距离（XZ 平面） */
function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cz = az + t * dz
  return Math.hypot(px - cx, pz - cz)
}

/** 点是否在多边形内（射线法） */
function inPoly(px, pz, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.z > pz !== b.z > pz && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

const waterKeys = new Set(['deepWater', 'shallowWater'])
const CELL = 4
const cols = Math.ceil(g / CELL)

let inter = 0
let terrainWater = 0
let osmWater = 0
let union = 0
const tGrid = Array.from({ length: cols }, () => new Array(cols).fill(0))
const oGrid = Array.from({ length: cols }, () => new Array(cols).fill(0))

// OSM 河道按"离折线 12 m 内算水面"处理——OSM 的 river 是中心线，没有宽度
const RIVER_HALF_WIDTH = 12

for (let j = 0; j < g; j += CELL) {
  for (let i = 0; i < g; i += CELL) {
    const u = i / (g - 1)
    const v = j / (g - 1)
    const x = (u - 0.5) * meta.sizeMeters
    const z = (v - 0.5) * meta.sizeMeters

    const band = pickBand(field.heightAt(u, v), field.slopeAt(u, v), field.waterLevel, field.heightScale)
    const tW = waterKeys.has(band)

    let oW = false
    for (const r of riverLines) {
      for (let k = 0; k + 1 < r.pts.length; k++) {
        if (distToSeg(x, z, r.pts[k].x, r.pts[k].z, r.pts[k + 1].x, r.pts[k + 1].z) <= RIVER_HALF_WIDTH) {
          oW = true
          break
        }
      }
      if (oW) break
    }
    if (!oW) {
      for (const w of waterPolys) {
        if (inPoly(x, z, w.pts)) {
          oW = true
          break
        }
      }
    }

    const by = Math.floor(j / CELL)
    const bx = Math.floor(i / CELL)
    if (tW) tGrid[by][bx]++
    if (oW) oGrid[by][bx]++

    if (tW) terrainWater++
    if (oW) osmWater++
    if (tW && oW) inter++
    if (tW || oW) union++
  }
}

const iou = union ? inter / union : 0
console.log('')
console.log('=== 地形水面 vs OSM 水系（矢量真值）===')
console.log(`  采样格点      ${cols}×${cols}（每点 ${CELL} 格 = ${(CELL * meta.sizeMeters / (g - 1)).toFixed(1)} m）`)
console.log(`  地形判为水    ${terrainWater}`)
console.log(`  OSM 判为水    ${osmWater}`)
console.log(`  两者一致      ${inter}`)
console.log(`  IoU           ${(iou * 100).toFixed(1)}%`)

console.log('')
console.log('分布对照（左：地形判据   右：OSM 矢量）')
const sym = (n) => {
  if (n === 0) return ' '
  if (n < 8) return '.'
  if (n < 16) return ':'
  if (n < 24) return '*'
  return '#'
}
for (let r = 0; r < cols; r++) {
  let l = ''
  let rr = ''
  for (let c = 0; c < cols; c++) {
    l += sym(tGrid[r][c])
    rr += sym(oGrid[r][c])
  }
  console.log(`  ${l}    ${rr}`)
}
console.log('')
console.log('判读：右图的 # 应构成一条贯穿的河道（OSM 河道中心线 + 12 m 半宽）。')
console.log('      IoU 反映"地形判出的水面是否落在河位上"。')
