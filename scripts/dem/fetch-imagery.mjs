/**
 * 抓一张与 DEM 完全对齐的俯视影像，用来判断地形里的规则纹理是真实地貌还是伪影。
 *
 * 输出：docs/reference/top-imagery.png —— 覆盖与 DEM 相同的 1600 m 见方范围，
 *       正北朝上，四角与 DEM 的世界坐标一一对应，可直接与俯视渲染图叠加比对。
 *
 * 用法：node scripts/dem/fetch-imagery.mjs
 */

import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT_DIR = join(ROOT, 'docs', 'reference')
const CACHE = join(process.env.TEMP || '/tmp', 'minshan-osm-cache')

const meta = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))

const Z = 16
const M_PER_DEG_LAT = 111132.0
const M_PER_DEG_LON = 111320.0 * Math.cos((meta.origin.lat * Math.PI) / 180)
const size = meta.sizeMeters
const half = size / 2

const lonOf = (x) => meta.origin.lon + x / M_PER_DEG_LON
const latOf = (z) => meta.origin.lat - z / M_PER_DEG_LAT

const deg2tx = (lon) => ((lon + 180) / 360) * 2 ** Z
const deg2ty = (lat) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z
}
const tx2lon = (x) => (x / 2 ** Z) * 360 - 180
const ty2lat = (y) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** Z
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI
}

// ---- 极简 PNG 解码（与 build-dem.mjs 同一套，支持 8 位 RGB/RGBA 调色板）----
function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let palette = null
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const d = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = d.readUInt32BE(0)
      height = d.readUInt32BE(4)
      bitDepth = d[8]
      colorType = d[9]
      if (bitDepth !== 8) throw new Error(`只支持 8 位，收到 ${bitDepth}`)
      if (d[12] !== 0) throw new Error('不支持隔行')
    } else if (type === 'PLTE') {
      palette = Buffer.from(d)
    } else if (type === 'IDAT') {
      idat.push(d)
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)

  const inflated = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rawPix = Buffer.alloc(width * height * channels)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = inflated[rp++]
    const line = inflated.subarray(rp, rp + stride)
    rp += stride
    const cur = rawPix.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? rawPix.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const rb = line[i]
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let v
      switch (filter) {
        case 0: v = rb; break
        case 1: v = rb + a; break
        case 2: v = rb + b; break
        case 3: v = rb + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`未知过滤器 ${filter}`)
      }
      cur[i] = v & 0xff
    }
  }

  // 统一成 RGB
  const rgb = Buffer.alloc(width * height * 3)
  for (let k = 0; k < width * height; k++) {
    if (colorType === 3) {
      const idx = rawPix[k]
      rgb[k * 3] = palette[idx * 3]
      rgb[k * 3 + 1] = palette[idx * 3 + 1]
      rgb[k * 3 + 2] = palette[idx * 3 + 2]
    } else if (colorType === 6) {
      rgb[k * 3] = rawPix[k * 4]
      rgb[k * 3 + 1] = rawPix[k * 4 + 1]
      rgb[k * 3 + 2] = rawPix[k * 4 + 2]
    } else {
      rgb[k * 3] = rawPix[k * 3]
      rgb[k * 3 + 1] = rawPix[k * 3 + 1]
      rgb[k * 3 + 2] = rawPix[k * 3 + 2]
    }
  }
  return { width, height, rgb }
}

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function encodePng(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 主流程 ----
const west = lonOf(-half)
const east = lonOf(half)
const north = latOf(-half)
const south = latOf(half)

const tx0 = Math.floor(deg2tx(west))
const tx1 = Math.floor(deg2tx(east))
const ty0 = Math.floor(deg2ty(north))
const ty1 = Math.floor(deg2ty(south))
const cols = tx1 - tx0 + 1
const rows = ty1 - ty0 + 1
console.log(`影像瓦片 z=${Z}  x ${tx0}..${tx1} (${cols})  y ${ty0}..${ty1} (${rows})  共 ${cols * rows} 张`)

await mkdir(CACHE, { recursive: true })
const tiles = new Map()
for (let ty = ty0; ty <= ty1; ty++) {
  for (let tx = tx0; tx <= tx1; tx++) {
    const f = join(CACHE, `${Z}-${tx}-${ty}.png`)
    try {
      await access(f)
    } catch {
      const res = await fetch(`https://tile.openstreetmap.org/${Z}/${tx}/${ty}.png`, {
        headers: { 'User-Agent': 'MinshanShoujing/0.1 (terrain prep)' },
      })
      if (!res.ok) {
        console.log(`  失败 ${tx}/${ty} HTTP ${res.status}`)
        continue
      }
      await writeFile(f, Buffer.from(await res.arrayBuffer()))
      await new Promise((r) => setTimeout(r, 220))
    }
    tiles.set(`${tx},${ty}`, decodePng(await readFile(f)))
  }
}
console.log(`瓦片就绪 ${tiles.size} 张`)

// 按 DEM 的世界坐标逐像素采样影像，输出与 DEM 完全对齐的图
const W = 800
const H = Math.round((W * size) / size)
const out = Buffer.alloc(W * H * 3)
let miss = 0
for (let j = 0; j < H; j++) {
  const z = (j / (H - 1) - 0.5) * size
  const lat = latOf(z)
  const fy = deg2ty(lat)
  for (let i = 0; i < W; i++) {
    const x = (i / (W - 1) - 0.5) * size
    const lon = lonOf(x)
    const fx = deg2tx(lon)
    const tx = Math.floor(fx)
    const ty = Math.floor(fy)
    const img = tiles.get(`${tx},${ty}`)
    if (!img) {
      miss++
      continue
    }
    const px = Math.min(img.width - 1, Math.floor((fx - tx) * img.width))
    const py = Math.min(img.height - 1, Math.floor((fy - ty) * img.height))
    const s = (py * img.width + px) * 3
    const d = (j * W + i) * 3
    out[d] = img.rgb[s]
    out[d + 1] = img.rgb[s + 1]
    out[d + 2] = img.rgb[s + 2]
  }
}
console.log(`缺数据像素 ${miss}`)

await mkdir(OUT_DIR, { recursive: true })
const file = join(OUT_DIR, 'top-imagery.png')
await writeFile(file, encodePng(W, H, out))
console.log(`已写出 ${file}`)
console.log(`  覆盖经纬度  ${west.toFixed(6)} .. ${east.toFixed(6)}  /  ${south.toFixed(6)} .. ${north.toFixed(6)}`)
console.log(`  与 DEM 世界坐标 1:1 对齐，正北朝上，可直接与 top.png 叠加比对`)
