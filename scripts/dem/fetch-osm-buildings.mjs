/**
 * 从 OpenStreetMap 提取真实建筑轮廓，转成本项目的高度场坐标。
 *
 * 为什么值得做
 * ------------------------------------------------
 * 水磨古镇主街区在 OSM 上几乎是空白，但**阿坝师范学院校区有真实建筑轮廓**
 * （体育馆、学术交流中心、校大门、操场等 16 个要素）。这些是唯一拿得到的
 * 真实建筑数据，用上它能让场景里至少一片区域是"真的"，而不是全部示意。
 *
 * 必须同时产出的是"哪些是真实、哪些是示意"的清单：界面上要能区分，
 * 不能把真实数据与程序生成混在一起当成测绘成果。
 *
 * 数据来源：https://api.openstreetmap.org/api/0.6/map?bbox=...
 * 许可：ODbL，需署名。
 *
 * 用法：node scripts/dem/fetch-osm-buildings.mjs
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT_DIR = join(ROOT, 'public', 'terrain')

const meta = JSON.parse(await readFile(join(OUT_DIR, 'shuimo-dem.json'), 'utf8'))

const M_PER_DEG_LAT = 111132.0
const M_PER_DEG_LON = 111320.0 * Math.cos((meta.origin.lat * Math.PI) / 180)
const half = meta.sizeMeters / 2
const lonOf = (x) => meta.origin.lon + x / M_PER_DEG_LON
const latOf = (z) => meta.origin.lat - z / M_PER_DEG_LAT

// 场景范围的经纬度四至（略微收一点，避免请求边界外的数据）
const west = lonOf(-half)
const east = lonOf(half)
const north = latOf(-half)
const south = latOf(half)

const bbox = `${west.toFixed(5)},${south.toFixed(5)},${east.toFixed(5)},${north.toFixed(5)}`
console.log(`请求范围 bbox=${bbox}`)

const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`
const res = await fetch(url, { headers: { 'User-Agent': 'MinshanShoujing/0.1 (terrain prep)' } })
if (!res.ok) {
  console.error(`OSM 请求失败 HTTP ${res.status}（这片范围可能太大，OSM 主 API 有面积上限）`)
  process.exit(1)
}
const xml = await res.text()
console.log(`收到 ${(xml.length / 1024).toFixed(0)} KB`)

// ---- 解析 XML（不引依赖：格式简单，逐个正则抽）----
const nodeRe = /<node id="(-?\d+)"[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g
const nodes = new Map()
let m
while ((m = nodeRe.exec(xml))) {
  const id = m[1]
  // 若 lat/lon 顺序与上面正则不符，用备用匹配
  nodes.set(id, { lat: Number(m[2]), lon: Number(m[3]) })
}
console.log(`节点 ${nodes.size}`)

// way：抽出 nd 引用与 tag
const wayRe = /<way id="(-?\d+)"[^>]*>([\s\S]*?)<\/way>/g
const ways = []
while ((m = wayRe.exec(xml))) {
  const body = m[2]
  const refs = []
  const ndRe = /<nd ref="(-?\d+)"/g
  let n2
  while ((n2 = ndRe.exec(body))) refs.push(n2[1])

  const tags = {}
  const tagRe = /<tag k="([^"]+)" v="([^"]*)"/g
  let t
  while ((t = tagRe.exec(body))) tags[t[1]] = t[2]

  ways.push({ id: m[1], refs, tags })
}
console.log(`way ${ways.length}`)

/** 采样点 → 世界坐标 */
function toWorld(lat, lon) {
  return { x: (lon - meta.origin.lon) * M_PER_DEG_LON, z: -(lat - meta.origin.lat) * M_PER_DEG_LAT }
}

const buildings = []
let dropped = 0
for (const w of ways) {
  // building 标签存在即算建筑（值可能是 yes / residential / school 等）
  if (!('building' in w.tags)) continue
  if (w.refs.length < 3) continue

  // 抽取轮廓
  const ring = []
  let ok = true
  for (const r of w.refs) {
    const n = nodes.get(r)
    if (!n) {
      ok = false
      break
    }
    const p = toWorld(n.lat, n.lon)
    if (Math.abs(p.x) > half || Math.abs(p.z) > half) {
      // 少数跨边界的轮廓直接丢弃，不做裁剪（裁剪会引入自交风险）
      ok = false
      break
    }
    ring.push(p)
  }
  if (!ok || ring.length < 3) {
    dropped++
    continue
  }

  // 计算面积（鞋带公式）与质心，用于过滤掉退化轮廓
  let area2 = 0
  let cx = 0
  let cz = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    area2 += a.x * b.z - b.x * a.z
    cx += a.x
    cz += a.z
  }
  const area = Math.abs(area2) / 2
  cx /= ring.length
  cz /= ring.length
  if (area < 40) {
    dropped++
    continue
  }

  // OSM 里建筑默认层数，可按 building:levels 覆盖
  const levels = Number(w.tags['building:levels'] || 0)
  const height = levels > 0 ? levels * 3.2 : w.tags.building === 'school' ? 12 : 9

  buildings.push({
    id: w.id,
    name: w.tags.name || '',
    kind: w.tags.building,
    ring,
    area: Math.round(area),
    center: { x: Math.round(cx * 10) / 10, z: Math.round(cz * 10) / 10 },
    height,
    levels: levels || null,
  })
}

buildings.sort((a, b) => b.area - a.area)
console.log(`\n真实建筑轮廓 ${buildings.length} 个（丢弃退化/越界 ${dropped} 个）`)
console.log('面积最大的 12 个：')
for (const b of buildings.slice(0, 12)) {
  console.log(
    `  ${(b.name || '(无名)').padEnd(14)} ${String(b.kind).padEnd(10)} 面积 ${String(b.area).padStart(6)} m²  中心 x=${String(b.center.x).padStart(6)} z=${String(b.center.z).padStart(6)}`,
  )
}
const totalArea = buildings.reduce((s, b) => s + b.area, 0)
console.log(`\n真实建筑总面积 ${totalArea.toLocaleString('zh-CN')} m²`)

const out = {
  id: 'shuimo-osm-buildings',
  generatedAt: new Date().toISOString(),
  source: 'OpenStreetMap (api.openstreetmap.org)',
  license: 'ODbL 1.0 —— 使用需署名 OpenStreetMap contributors，并以相同方式共享',
  bbox,
  /** 注意：OSM 只覆盖阿坝师范学院校区一带，古镇主街区为空 */
  coverageNote: 'OSM 在水磨古镇主街区的建筑数据基本为空，这里的轮廓几乎全部属于阿坝师范学院校区',
  count: buildings.length,
  totalArea,
  buildings,
}
await mkdir(OUT_DIR, { recursive: true })
const file = join(OUT_DIR, 'shuimo-osm-buildings.json')
await writeFile(file, `${JSON.stringify(out, null, 2)}\n`)
console.log(`\n已写出 ${file}`)
