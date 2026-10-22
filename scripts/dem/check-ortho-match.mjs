/**
 * 地形与真实影像的叠合校验。
 *
 * 为什么需要它
 * ------------------------------------------------
 * "地形看起来对"是可以自我欺骗的：只要形状不太离谱，人就会认为它是对的。
 * 唯一能证伪的办法是拿**真实影像**逐像素比。本脚本做三件事：
 *   1. 用与 DEM 完全相同的范围，渲染一张与影像等尺寸的正射俯视图
 *   2. 两者并排拼成一张对照图（左：真实影像；右：地形色带）
 *   3. 算相关性：把地形的"水/砾石滩"判据与影像的"蓝色水面"像素做交并比
 *
 * 第 3 项是真正的断言：如果我把水面判错了地方，IoU 会直接掉下来。
 *
 * 用法：node scripts/dem/check-ortho-match.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import * as THREE from 'three'

import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { buildTerrainGeometry, pickBand, TERRAIN_PALETTE } from '../../src/three/terrainMesh.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT_DIR = join(ROOT, 'docs', 'reference')

const SIZE = 800
const DEM_DIR = join(ROOT, 'public', 'terrain')

// ---------- PNG 解码 / 编码 ----------
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
function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let ct = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const t = buf.toString('ascii', pos + 4, pos + 8)
    const d = buf.subarray(pos + 8, pos + 8 + len)
    if (t === 'IHDR') {
      width = d.readUInt32BE(0)
      height = d.readUInt32BE(4)
      ct = d[9]
    } else if (t === 'IDAT') idat.push(d)
    else if (t === 'IEND') break
    pos += 12 + len
  }
  const ch = ct === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * ch
  const out = Buffer.alloc(width * height * ch)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const f = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const rb = line[i]
      const a = i >= ch ? cur[i - ch] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= ch ? prev[i - ch] : 0
      let v
      switch (f) {
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
        default: throw new Error('未知过滤器 ' + f)
      }
      cur[i] = v & 0xff
    }
  }
  return { width, height, channels: ch, data: out }
}

// ---------- 主流程 ----------
const meta = JSON.parse(await readFile(join(DEM_DIR, 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(DEM_DIR, 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols
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

// 用真实几何 + 正射相机渲染，得到一张与影像等范围的色带图
const geometry = buildTerrainGeometry(field, {
  skirtDepth: field.heightScale * 0.16,
  jitter: 0.015,
})
const pos = geometry.attributes.position
const col = geometry.attributes.color

// 真·正射：fov=7、距离足够远，保证地形恰好铺满 [0,1] 的归一化坐标
const camera = new THREE.PerspectiveCamera(7, 1, field.size * 0.1, field.size * 12)
camera.position.set(0, field.size * 6.5, 0.001)
camera.up.set(0, 0, -1)
camera.lookAt(0, 0, 0)
camera.updateMatrixWorld(true)
camera.updateProjectionMatrix()
camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

const rgbOut = Buffer.alloc(SIZE * SIZE * 3, 255)
const depth = new Float32Array(SIZE * SIZE).fill(Infinity)

// 把地形铺满整幅：正射下，世界 x∈[-half,half] 应映射到像素 [0,SIZE]
// 用相机的 viewProjection 直接投影，再按实际占用的 NDC 范围归一化
let minNdcX = Infinity, maxNdcX = -Infinity, minNdcY = Infinity, maxNdcY = -Infinity
const half = field.size / 2
const probe = new THREE.Vector3()
for (const x of [-half, half]) {
  for (const z of [-half, half]) {
    probe.set(x, 0, z).applyMatrix4(vp)
    minNdcX = Math.min(minNdcX, probe.x); maxNdcX = Math.max(maxNdcX, probe.x)
    minNdcY = Math.min(minNdcY, probe.y); maxNdcY = Math.max(maxNdcY, probe.y)
  }
}
const spanX = maxNdcX - minNdcX
const spanY = maxNdcY - minNdcY

const v = new THREE.Vector3()
const a3 = new THREE.Vector3()
const b3 = new THREE.Vector3()
const c3 = new THREE.Vector3()

for (let f = 0; f < pos.count; f += 3) {
  a3.fromBufferAttribute(pos, f)
  b3.fromBufferAttribute(pos, f + 1)
  c3.fromBufferAttribute(pos, f + 2)

  const pt = [a3, b3, c3].map((p) => {
    v.copy(p).applyMatrix4(vp)
    return {
      x: ((v.x - minNdcX) / spanX) * SIZE,
      y: (1 - (v.y - minNdcY) / spanY) * SIZE,
      z: v.z,
    }
  })

  const [p0, p1, p2] = pt
  const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)
  if (Math.abs(area) < 1e-9) continue

  const cr = col.getX(f)
  const cg = col.getY(f)
  const cb = col.getZ(f)

  const x0 = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)))
  const x1 = Math.min(SIZE - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)))
  const y0 = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)))
  const y1 = Math.min(SIZE - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)))

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const w0 = ((p1.x - p0.x) * (py - p0.y) - (px - p0.x) * (p1.y - p0.y)) / area
      const w1 = ((px - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (py - p0.y)) / area
      const w2 = 1 - w0 - w1
      if (w0 < 0 || w1 < 0 || w2 < 0) continue
      const zz = w1 * p0.z + w2 * p1.z + w0 * p2.z
      const idx = y * SIZE + x
      if (zz >= depth[idx]) continue
      depth[idx] = zz
      const lin = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055)
      rgbOut[idx * 3] = Math.round(Math.min(1, lin(cr)) * 255)
      rgbOut[idx * 3 + 1] = Math.round(Math.min(1, lin(cg)) * 255)
      rgbOut[idx * 3 + 2] = Math.round(Math.min(1, lin(cb)) * 255)
    }
  }
}

// ---------- 读真实影像并做交并比 ----------
const imagery = decodePng(await readFile(join(OUT_DIR, 'top-imagery.png')))

/** 影像上的"水面"判据：蓝色分量明显高于红绿，且偏冷 */
function isImageryWater(r, g, b) {
  return b > r + 18 && b > g + 6 && b > 120
}

/** 地形上的"水"判据：色带为 deepWater 或 shallowWater */
const waterKeys = new Set(['deepWater', 'shallowWater'])
const bandByName = {}
for (const [k, hex] of Object.entries(TERRAIN_PALETTE)) {
  bandByName[k] = new THREE.Color(hex)
}

let inter = 0
let union = 0
let terrainWater = 0
let imageryWater = 0
let both = 0
let terrainOnly = 0
let imageryOnly = 0

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const it = (y * SIZE + x) * 3
    const ii = (y * imagery.width + x) * imagery.channels

    /**
     * 地形色带：直接按像素位置调 pickBand，而不是"反向查渲染出来的字节颜色"。
     *
     * 为什么要改：渲染输出是 sRGB 字节，色板比较又要把色板转成 sRGB，
     * 于是同一个颜色被做了两次色彩空间转换，大量像素会匹配到错误的色带。
     * 直接调分类函数没有这个问题，而且与画面显示的是同一个判据。
     */
    const u = (x + 0.5) / SIZE
    const v = (y + 0.5) / SIZE
    const best = pickBand(field.heightAt(u, v), field.slopeAt(u, v), field.waterLevel, field.heightScale)
    const tWater = waterKeys.has(best)
    const iWater = isImageryWater(imagery.data[ii], imagery.data[ii + 1], imagery.data[ii + 2])

    if (tWater) terrainWater++
    if (iWater) imageryWater++
    if (tWater && iWater) { inter++; both++ }
    if (tWater && !iWater) terrainOnly++
    if (!tWater && iWater) imageryOnly++
    if (tWater || iWater) union++
  }
}

const iou = union ? inter / union : 0
console.log('=== 水面判定的交并比（IoU）===')
console.log(`  地形判为水    ${terrainWater.toLocaleString('zh-CN')} px`)
console.log(`  影像判为水    ${imageryWater.toLocaleString('zh-CN')} px`)
console.log(`  两者一致      ${both.toLocaleString('zh-CN')} px`)
console.log(`  仅地形判水    ${terrainOnly.toLocaleString('zh-CN')} px`)
console.log(`  仅影像判水    ${imageryOnly.toLocaleString('zh-CN')} px`)
console.log(`  IoU           ${(iou * 100).toFixed(1)}%`)

/**
 * 把两边的水面分布降采样成字符图并排打印。
 * IoU 只给一个数字，"错在哪一侧、错多少"必须看图——这是定位错位最快的办法。
 */
const CB = 40
const tGrid = Array.from({ length: CB }, () => new Array(CB).fill(0))
const iGrid = Array.from({ length: CB }, () => new Array(CB).fill(0))
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const by = Math.min(CB - 1, Math.floor((y / SIZE) * CB))
    const bx = Math.min(CB - 1, Math.floor((x / SIZE) * CB))

    const u = (x + 0.5) / SIZE
    const v = (y + 0.5) / SIZE
    const band = pickBand(field.heightAt(u, v), field.slopeAt(u, v), field.waterLevel, field.heightScale)
    if (waterKeys.has(band)) tGrid[by][bx]++

    const ii = (y * imagery.width + x) * imagery.channels
    if (isImageryWater(imagery.data[ii], imagery.data[ii + 1], imagery.data[ii + 2])) iGrid[by][bx]++
  }
}
const cellPx = (SIZE / CB) * (SIZE / CB)
console.log('')
console.log('水面分布对照（每格 20×20 px；符号按该格水面像素占比）')
console.log('  左：地形判据      右：真实影像')
const sym = (n) => {
  const f = n / cellPx
  if (f < 0.05) return ' '
  if (f < 0.25) return '.'
  if (f < 0.5) return ':'
  if (f < 0.75) return '*'
  return '#'
}
for (let r = 0; r < CB; r++) {
  let l = ''
  let rr = ''
  for (let c = 0; c < CB; c++) {
    l += sym(tGrid[r][c])
    rr += sym(iGrid[r][c])
  }
  console.log(`  ${l}    ${rr}`)
}
console.log('')
console.log('若左图的 # 区域与右图明显不在同一行/列，就是坐标或投影错位；')
console.log('若位置一致但左图更碎，是水位或分辨率问题。')

// ---------- 输出并排对照图 ----------
const OUT_W = SIZE * 2 + 8
const compare = Buffer.alloc(OUT_W * SIZE * 3, 24)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const di = (y * OUT_W + x) * 3
    const si = (y * imagery.width + x) * imagery.channels
    compare[di] = imagery.data[si]
    compare[di + 1] = imagery.data[si + 1]
    compare[di + 2] = imagery.data[si + 2]

    const di2 = (y * OUT_W + SIZE + 8 + x) * 3
    const si2 = (y * SIZE + x) * 3
    compare[di2] = rgbOut[si2]
    compare[di2 + 1] = rgbOut[si2 + 1]
    compare[di2 + 2] = rgbOut[si2 + 2]
  }
}

await mkdir(OUT_DIR, { recursive: true })
await writeFile(join(OUT_DIR, 'ortho-compare.png'), encodePng(OUT_W, SIZE, compare))
await writeFile(join(OUT_DIR, 'ortho-terrain.png'), encodePng(SIZE, SIZE, rgbOut))
console.log('')
console.log(`已写出 ${join(OUT_DIR, 'ortho-compare.png')}（左：真实影像  右：地形色带）`)
console.log(`已写出 ${join(OUT_DIR, 'ortho-terrain.png')}`)
console.log('')
console.log('判读：IoU 低于 30% 说明水面位置判错了（要么水位不对，要么坐标错位）；')
console.log('      30–60% 属正常区间——影像里的水面还包含 DEM 分辨率看不到的窄水面；')
console.log('      高于 60% 说明水系与真实高度吻合得很好。')
