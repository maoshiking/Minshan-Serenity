/**
 * 离线软件渲染器：不依赖浏览器 / WebGL / 原生模块，直接把地形算成 PNG。
 *
 *   cd "Minshan Serenity" && node scripts/preview/soft-render.mjs
 *
 * 为什么要有它：沙箱禁止命名管道，Chromium 的 mojo IPC 依赖命名管道，
 * 所以这个环境里起不来浏览器（进程活着但永远初始化不完）。而地形本来就是我自己算出来的，
 * 几何、配色、光照参数、相机矩阵全在手上，那就自己光栅化一遍——纯计算，不受任何环境限制。
 *
 * 保真度说明（哪些是真、哪些是近似）：
 *   真：高度场、地表/侧壁几何与逐面颜色、水面分带、树的实例化位置、路线飘带几何与 UV、
 *       标记几何、相机矩阵与投影、卡通光照的四档量化阈值、半球补光、雾、线性→sRGB 输出
 *   近似：阴影用高度场解析求交（比 shadow map 更准，但不是 PCF 软边）、
 *         水面的浪线贴图用色带代替、没有抗锯齿
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'

import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { buildTerrainGeometry, pickBand, TERRAIN_PALETTE } from '../../src/three/terrainMesh.js'
import { buildRoutePoints, buildRouteRibbon } from '../../src/three/route.js'
import { createForest, createRocks, pickWaterBand, skyColorAt, WATER_PALETTE } from '../../src/three/scenery.js'
import { createLandmarkMarkers, resolveLandmarks, LANDMARK_COLORS } from '../../src/three/landmarks.js'
import { createSettlement } from '../../src/three/settlement.js'
import { createOsmBuildings } from '../../src/three/osmBuildings.js'
import { SCENE_LOOK, frameTerrainCamera, skirtDepthOf } from '../../src/three/cartoonTerrain.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, 'soft-shots')
const WIDTH = 960
const HEIGHT = 640
const SEED = 20261021
const RESOLUTION = 112

// ---------- PNG 编码（zlib 是 Node 内置的，只需要自己写 CRC 和 chunk） ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // 过滤器类型 0 = None
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 真彩色 RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 线性光 → sRGB。three 的输出色彩空间就是这么转的，不走这一步会整体偏暗 */
function linearToSrgb(c) {
  const v = c < 0 ? 0 : c > 1 ? 1 : c
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

// ---------- 场景参数（与 SCENE_LOOK 同源） ----------
// 默认沿用程序化地形的 120 单位沙盘。若 public/terrain 下存在真实 DEM 数据，
// 则自动切到真实地形（1 世界单位 = 1 米），构图、雾距、配色全部按真实尺度走。
const DEM_DIR = path.join(here, '..', '..', 'public', 'terrain')
const DEM_META_PATH = path.join(DEM_DIR, 'shuimo-dem.json')
const DEM_BIN_PATH = path.join(DEM_DIR, 'shuimo-dem.bin')

/** 预览用的网格上限：512 格是 52 万面，软件光栅器跑不动，预览降采样即可 */
const DEM_PREVIEW_RESOLUTION = Number(process.env.DEM_PREVIEW_RESOLUTION || 256)

/** 双线性降采样，避免抽点采样把山脊切出锯齿 */
function resampleGrid(src, n, target) {
  if (target === n) return src
  const last = n - 1
  const out = new Float32Array(target * target)
  for (let j = 0; j < target; j++) {
    const g = (j / (target - 1)) * last
    const j0 = Math.min(Math.floor(g), last - 1)
    const t = g - j0
    for (let i = 0; i < target; i++) {
      const f = (i / (target - 1)) * last
      const i0 = Math.min(Math.floor(f), last - 1)
      const s = f - i0
      const hA = src[j0 * n + i0]
      const hB = src[j0 * n + i0 + 1]
      const hC = src[(j0 + 1) * n + i0]
      const hD = src[(j0 + 1) * n + i0 + 1]
      out[j * target + i] = (hA * (1 - s) + hB * s) * (1 - t) + (hC * (1 - s) + hD * s) * t
    }
  }
  return out
}

let demMeta = null
let demData = null
/** 默认画树石；设 SKIP_SCENERY=1 可关闭（地形形态核对时更清爽） */
const SKIP_SCENERY = process.env.SKIP_SCENERY === '1'
try {
  demMeta = JSON.parse(fs.readFileSync(DEM_META_PATH, 'utf8'))
  const raw = fs.readFileSync(DEM_BIN_PATH)
  const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  const n = demMeta.grid?.cols ?? 0
  demData = resampleGrid(full, n, Math.min(DEM_PREVIEW_RESOLUTION, n))
} catch {
  demMeta = null
  demData = null
}

const size = demMeta ? demMeta.sizeMeters : 120
const keyDir = new THREE.Vector3(...SCENE_LOOK.keyDirection).normalize()
const keyColor = new THREE.Color(SCENE_LOOK.keyColor)
const hemiSky = new THREE.Color(SCENE_LOOK.hemisphereSky)
const hemiGround = new THREE.Color(SCENE_LOOK.hemisphereGround)
const fogColor = new THREE.Color(SCENE_LOOK.fogColor)
const accentColor = new THREE.Color(SCENE_LOOK.accent)
const FOG_NEAR = size * SCENE_LOOK.fogNearFactor
const FOG_FAR = size * SCENE_LOOK.fogFarFactor
const INV_PI = 1 / Math.PI

/**
 * 卡通阶梯量化的真实阈值。
 * three 的 getGradientIrradiance 用 coord = dotNL*0.5+0.5 去采样 4 像素的 gradientMap，
 * NearestFilter 下等价于在 dotNL = -0.5 / 0 / 0.5 处断档——不是想当然的在 0.25/0.5/0.75 断档。
 */
function toonBand(dotNL) {
  if (dotNL < -0.5) return 0.42
  if (dotNL < 0) return 0.66
  if (dotNL < 0.5) return 0.86
  return 1
}

// ---------- 构建场景数据 ----------
console.log('构建高度场与几何……')
/**
 * DEM 模式的 terrain 参数一律取自 demTerrainOptions，不在这里另写一套。
 *
 * 这里曾经硬编码 heightScale / waterLevel / slopeRadius 三个值，
 * 于是应用侧改了纵向放大系数、改了水位，预览却纹丝不动——
 * 出图与真实场景不一致，等于用一张过期的图做判断。
 * 同一份参数只能有一个出处。
 */
const field = createHeightFieldFromData(demData, {
  resolution: demData.length ** 0.5 | 0,
  size,
  ...demTerrainOptions(demMeta),
})
console.log(`  DEM 模式  网格 ${field.resolution}²  场景 ${field.size} m  高差 ${field.heightScale} m`)
/** 底座厚度以真实高差为基数，不随纵向放大走，见 skirtDepthOf 的说明 */
const PREVIEW_SKIRT_DEPTH = skirtDepthOf({ demField: true, elevationSpan: demMeta.elevation.span })
// 允许关掉逐面明暗抖动做对照实验（JITTER=0）
const JITTER = process.env.JITTER === undefined ? 0.015 : Number(process.env.JITTER)
const terrainGeometry = buildTerrainGeometry(field, {
  skirtDepth: PREVIEW_SKIRT_DEPTH,
  jitter: JITTER,
})
// 地标标记。地理位置来自 DEM 元数据里登记的点位
const landmarkList = resolveLandmarks(demMeta, field)
const landmarkMarkers = createLandmarkMarkers(landmarkList, {})
landmarkMarkers.group.userData.list = landmarkList
// 示意性聚落（与真实场景同一套生成逻辑）
const settlement = createSettlement(field, landmarkList, {})
// 真实建筑轮廓（OSM）。取不到就是 null，不影响出图
let osmBuildings = null
try {
  const raw2 = fs.readFileSync(path.join(DEM_DIR, 'shuimo-osm-buildings.json'), 'utf8')
  osmBuildings = createOsmBuildings(field, JSON.parse(raw2), {})
} catch {
  osmBuildings = null
}
if (osmBuildings) {
  console.log(
    '  真实建筑轮廓 ' + osmBuildings.count + ' 栋（三角面 ' + osmBuildings.triangleCount + '）来源 ' + osmBuildings.source,
  )
}

const forest = SKIP_SCENERY
  ? { group: new THREE.Group(), count: 0, layout: [] }
  : createForest(field, {
      sizeScale: field.size / 260,
      slots: 160,
      maxCount: 5200,
      density: 0.34,
      // 与真实场景一致：建筑位置作为禁区，避免树贴着房子长
      exclusions: settlement?.layout
        ? settlement.layout.map((b) => ({ x: b.x, z: b.z, radius: Math.max(b.w, b.d) * 0.5 + 2.5 }))
        : [],
    })
const rocks = SKIP_SCENERY ? { group: new THREE.Group(), count: 0, layout: [] } : createRocks(field)

// 标记点：找陆地上分散的四个点
const picks = []
for (let radius = 9; radius < 54 && picks.length < 4; radius += 2) {
  for (let angle = 0; angle < Math.PI * 2 && picks.length < 4; angle += Math.PI / 10) {
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    if (!field.plantable(x, z)) continue
    if (picks.some((p) => Math.hypot(p.x - x, p.z - z) < 24)) continue
    picks.push({ x, z })
  }
}

const route = buildRouteRibbon(field, buildRoutePoints(picks), { width: 1.9, lift: 0.5 })

/** 解析式阴影：从表面点朝光源步进，看是否被高度场挡住 */
const SHADOW_STEP = field.cellSize * 1.1
function inShadow(x, y, z) {
  const ox = x + keyDir.x * 0.4
  const oy = y + keyDir.y * 0.4
  const oz = z + keyDir.z * 0.4
  for (let t = SHADOW_STEP; t < size * 2.4; t += SHADOW_STEP) {
    const py = oy + keyDir.y * t
    // 已经高过最高峰，后面不可能再被挡
    if (py > field.heightScale + 2) return false
    if (py < field.worldHeight(ox + keyDir.x * t, oz + keyDir.z * t)) return true
  }
  return false
}

const shadowStats = { tested: 0, shadowed: 0 }

/**
 * 纯色带模式：跳过光照与雾，直接输出色带本色。
 * 用来核准"地形分类对不对"——一旦叠上光照和雾，色带占比的差异就看不清了。
 * 只在 top 视图下默认开启（top 视图本来就带俯视核准的用途）。
 */
let FLAT_MODE = false

function shade(albedo, normal, shadowed, distance, out) {
  if (FLAT_MODE) {
    out[0] = albedo.r
    out[1] = albedo.g
    out[2] = albedo.b
    return
  }

  const band = shadowed ? 0 : toonBand(normal.x * keyDir.x + normal.y * keyDir.y + normal.z * keyDir.z)
  const hemiMix = 0.5 * normal.y + 0.5
  const ambientR = hemiGround.r + (hemiSky.r - hemiGround.r) * hemiMix
  const ambientG = hemiGround.g + (hemiSky.g - hemiGround.g) * hemiMix
  const ambientB = hemiGround.b + (hemiSky.b - hemiGround.b) * hemiMix

  let r = albedo.r * INV_PI * (keyColor.r * SCENE_LOOK.keyIntensity * band + ambientR * SCENE_LOOK.hemisphereIntensity)
  let g = albedo.g * INV_PI * (keyColor.g * SCENE_LOOK.keyIntensity * band + ambientG * SCENE_LOOK.hemisphereIntensity)
  let b = albedo.b * INV_PI * (keyColor.b * SCENE_LOOK.keyIntensity * band + ambientB * SCENE_LOOK.hemisphereIntensity)

  // 雾在线性空间里混合，与 three 的顺序一致
  const fog = Math.min(Math.max((distance - FOG_NEAR) / (FOG_FAR - FOG_NEAR), 0), 1)
  if (fog > 0) {
    r += (fogColor.r - r) * fog
    g += (fogColor.g - g) * fog
    b += (fogColor.b - b) * fog
  }

  out[0] = r
  out[1] = g
  out[2] = b
  return out
}

// ---------- 光栅器 ----------
class Rasterizer {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.color = new Float32Array(width * height * 3)
    this.depth = new Float32Array(width * height).fill(Infinity)
    this.vertex = new THREE.Vector3()
    this.clip = new THREE.Vector4()
  }

  /**
   * 用天空渐变铺底：逐像素反投影出视线方向，取其 y 分量查天空色。
   *
   * horizonFraction 控制天空铺到画面的哪个高度（1 = 铺满）。
   * 斜视图里铺满会让地形与背景糊成一片，看不出地形其实只占画面上部，
   * 也就判断不了构图。这纯粹是出图可读性的调整，不影响真实场景。
   */
  fillSky(camera, options = {}) {
    const { horizonFraction = 1 } = options
    const skyRows = Math.max(1, Math.round(this.height * horizonFraction))
    const inverse = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert()
    const point = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const cameraPosition = camera.position
    const sky = new THREE.Color()

    for (let y = 0; y < skyRows; y++) {
      const ndcY = 1 - ((y + 0.5) / this.height) * 2
      for (let x = 0; x < this.width; x++) {
        const ndcX = ((x + 0.5) / this.width) * 2 - 1
        point.set(ndcX, ndcY, 0.5).applyMatrix4(inverse)
        dir.copy(point).sub(cameraPosition).normalize()
        skyColorAt(dir.y, sky)
        const i = (y * this.width + x) * 3
        this.color[i] = sky.r
        this.color[i + 1] = sky.g
        this.color[i + 2] = sky.b
      }
    }
  }

  /**
   * 填一个三角形。颜色逐面恒定（平面着色），所以不必逐像素插值颜色。
   * uv 存在时做透视校正插值，供路线的虚线图案按纹理坐标取形。
   */
  triangle(p0, p1, p2, rgb, uv, alphaFn) {
    const { width, height, depth, color } = this
    const vp = this.viewProjection

    const w0 = vp[3] * p0[0] + vp[7] * p0[1] + vp[11] * p0[2] + vp[15]
    const w1 = vp[3] * p1[0] + vp[7] * p1[1] + vp[11] * p1[2] + vp[15]
    const w2 = vp[3] * p2[0] + vp[7] * p2[1] + vp[11] * p2[2] + vp[15]
    // 近平面裁剪：任一顶点跑到相机后面就整片丢弃（相机远离地形，影响可忽略）
    if (w0 <= 0.5 || w1 <= 0.5 || w2 <= 0.5) return

    const x0 = ((vp[0] * p0[0] + vp[4] * p0[1] + vp[8] * p0[2] + vp[12]) / w0 * 0.5 + 0.5) * width
    const y0 = (0.5 - (vp[1] * p0[0] + vp[5] * p0[1] + vp[9] * p0[2] + vp[13]) / w0 * 0.5) * height
    const x1 = ((vp[0] * p1[0] + vp[4] * p1[1] + vp[8] * p1[2] + vp[12]) / w1 * 0.5 + 0.5) * width
    const y1 = (0.5 - (vp[1] * p1[0] + vp[5] * p1[1] + vp[9] * p1[2] + vp[13]) / w1 * 0.5) * height
    const x2 = ((vp[0] * p2[0] + vp[4] * p2[1] + vp[8] * p2[2] + vp[12]) / w2 * 0.5 + 0.5) * width
    const y2 = (0.5 - (vp[1] * p2[0] + vp[5] * p2[1] + vp[9] * p2[2] + vp[13]) / w2 * 0.5) * height

    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (area === 0) return

    /**
     * 像素包围盒外扩 1 像素 + 重心坐标容差。
     *
     * 这一处是软件光栅器的经典坑：地形是密铺的三角面，相邻面共享边。
     * 若只测试"像素中心严格落在三角形内"，共享边两侧的像素会同时被两个面
     * 判为外部，于是整张图出现规则的缝隙网格——看起来像地形有条纹，
     * 实则是渲染器漏像素。本项目为此排查过好几轮（改抖动、改水位都无效）。
     *
     * 外扩 + 容差让相邻面在边界处重叠；重叠部分由深度测试裁决，不会画错。
     */
    const PAD = 1
    const EPS = 1e-6
    let minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)) - PAD)
    let maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)) + PAD)
    let minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)) - PAD)
    let maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)) + PAD)
    if (minX > maxX || minY > maxY) return

    const invArea = 1 / area
    const r0 = 1 / w0
    const r1 = 1 / w1
    const r2 = 1 / w2
    const [r, g, b] = rgb

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5
        // 重心坐标。容差 EPS 与上面的包围盒外扩配合，消除共享边缝隙
        const e0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * invArea
        const e1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * invArea
        const e2 = 1 - e0 - e1
        if (e0 < -EPS || e1 < -EPS || e2 < -EPS) continue

        const invW = e0 * r0 + e1 * r1 + e2 * r2
        const w = 1 / invW
        const index = y * width + x
        if (w >= depth[index]) continue

        let outR = r
        let outG = g
        let outB = b
        if (alphaFn) {
          const u = (uv[0] * r0 * e0 + uv[2] * r1 * e1 + uv[4] * r2 * e2) * w
          const v = (uv[1] * r0 * e0 + uv[3] * r1 * e1 + uv[5] * r2 * e2) * w
          const a = alphaFn(u, v)
          if (a <= 0) continue
          if (a < 1) {
            const i3 = index * 3
            outR = color[i3] + (r - color[i3]) * a
            outG = color[i3 + 1] + (g - color[i3 + 1]) * a
            outB = color[i3 + 2] + (b - color[i3 + 2]) * a
          }
        }

        depth[index] = w
        const i3 = index * 3
        color[i3] = outR
        color[i3 + 1] = outG
        color[i3 + 2] = outB
      }
    }
  }

  toRgb8() {
    const rgb = new Uint8Array(this.width * this.height * 3)
    for (let i = 0; i < rgb.length; i++) {
      rgb[i] = Math.round(linearToSrgb(this.color[i]) * 255)
    }
    return rgb
  }
}

// ---------- 世界的可渲染面收集 ----------
function eachFace(geometry, matrix, callback) {
  const position = geometry.attributes.position
  const normal = geometry.attributes.normal
  const colorAttr = geometry.attributes.color
  const uvAttr = geometry.attributes.uv
  // 路线飘带是带索引的（buildRouteRibbon 里 setIndex），其余几何是非索引的。
  // 不区分的话，索引几何会被当成"每三个顶点一个三角形"来走，顶点错位成乱三角形。
  const index = geometry.index
  const faceVertexCount = index ? index.count : position.count
  const vertexAt = index ? (k) => index.getX(k) : (k) => k

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const n = new THREE.Vector3()
  const normalMatrix = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : null
  const albedo = new THREE.Color()
  const uv = [0, 0, 0, 0, 0, 0]

  for (let f = 0; f < faceVertexCount; f += 3) {
    const i0 = vertexAt(f)
    const i1 = vertexAt(f + 1)
    const i2 = vertexAt(f + 2)
    a.fromBufferAttribute(position, i0)
    b.fromBufferAttribute(position, i1)
    c.fromBufferAttribute(position, i2)
    if (matrix) {
      a.applyMatrix4(matrix)
      b.applyMatrix4(matrix)
      c.applyMatrix4(matrix)
    }
    if (normal) {
      n.fromBufferAttribute(normal, i0)
      if (normalMatrix) n.applyMatrix3(normalMatrix).normalize()
    } else {
      n.set(0, 1, 0)
    }
    // 逐面单色：取该面第一个顶点的颜色就够（几何本来就是逐面同色的）
    if (colorAttr) albedo.fromBufferAttribute(colorAttr, i0)
    if (uvAttr) {
      const sources = [i0, i1, i2]
      for (let k = 0; k < 3; k++) {
        uv[k * 2] = uvAttr.getX(sources[k])
        uv[k * 2 + 1] = uvAttr.getY(sources[k])
      }
    }
    callback(a, b, c, n, albedo, uvAttr ? uv : null)
  }
}

// ---------- 渲染 ----------
function setupCamera(viewName) {
  const camera = new THREE.PerspectiveCamera(SCENE_LOOK.fov, WIDTH / HEIGHT, 0.5, size * 8)
  const targetHeight = field.heightScale * SCENE_LOOK.targetHeightFactor

  if (viewName === 'top') {
    // 正射俯视：地形核准最有用的一张图。用极小 fov + 远距离近似正射，
    // 避免透视把边缘压扁，这样图上量到的比例才可信。
    camera.fov = 7
    camera.position.set(0, size * 6.5, 0.001)
    camera.up.set(0, 0, -1)
    camera.lookAt(0, 0, 0)
    camera.near = size * 0.1
    camera.far = size * 12
    camera.updateProjectionMatrix()
  } else if (viewName === 'overview') {
    // 与真实场景共用取景函数：预览的构图就是用户第一眼看到的构图
    frameTerrainCamera(camera, {
      size,
      heightScale: field.heightScale,
      aspect: WIDTH / HEIGHT,
      // DEM 模式用更低的俯角，否则 1:4.5 的纵横比会把地形压成薄饼
      offset: SCENE_LOOK.cameraOffset,
      skirtDepth: PREVIEW_SKIRT_DEPTH,
      fill: SCENE_LOOK.frameFill,
      targetHeightFactor: SCENE_LOOK.targetHeightFactor,
    })
  } else if (viewName === 'settlement') {
    /**
     * 聚落特写：中空斜视，用来核对建筑形制与配色。
     *
     * 相机不能太近太低：起初用 (190, 130, 240)，前景的树被近裁剪面切断、
     * 又被极近距离放大，画面上出现一片竖板状条纹——**看起来像建筑几何坏了，
     * 其实只是相机位置不对**。核对建筑就该退到能看清整片街区的地方。
     */
    const c = settlement?.layout?.length
      ? {
          x: settlement.layout.reduce((s2, b) => s2 + b.x, 0) / settlement.layout.length,
          z: settlement.layout.reduce((s2, b) => s2 + b.z, 0) / settlement.layout.length,
        }
      : { x: 0, z: 0 }
    const gy = field.worldHeightSmooth(c.x, c.z)
    camera.fov = 50
    camera.position.set(c.x + 430, gy + 320, c.z + 540)
    camera.lookAt(c.x, gy + 20, c.z)
    camera.near = 5
    camera.far = size * 6
    camera.updateProjectionMatrix()
  } else if (viewName === 'closeup') {
    const p = picks[0]
    const y = field.worldHeight(p.x, p.z)
    camera.position.set(p.x + 26, y + 30, p.z + 38)
    camera.lookAt(p.x, y, p.z)
  } else if (viewName === 'route') {
    camera.position.set(size * 0.35, size * 1.25, size * 0.5)
    camera.lookAt(0, field.heightScale * 0.3, 0)
  } else {
    camera.position.set(-size * 1.15, size * 0.28, size * 1.05)
    camera.lookAt(0, field.heightScale * 0.1, 0)
  }

  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
  return camera
}

function renderView(viewName) {
  // 俯视核准图用纯色带，避免光照与雾把分类差异洗掉
  FLAT_MODE = viewName === 'top'
  const camera = setupCamera(viewName)
  const raster = new Rasterizer(WIDTH, HEIGHT)
  raster.viewProjection = new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .toArray()

  if (!FLAT_MODE) {
    // 天空只铺上半屏，下半留灰底，便于看清地形在画面里到底占多少
    raster.fillSky(camera, { horizonFraction: 0.5 })
  } else {
    // Rasterizer 没有 clear()，直接刷颜色缓冲：中灰底，便于分辨地形外的区域
    raster.color.fill(0.16)
  }

  // 天空未覆盖的下半屏刷中灰，便于分辨地形边界
  if (!FLAT_MODE) {
    const startRow = Math.round(HEIGHT * 0.5) * WIDTH * 3
    for (let k = startRow; k < raster.color.length; k++) raster.color[k] = 0.34
  }

  const rgb = [0, 0, 0]
  const centroid = new THREE.Vector3()

  // 地形
  eachFace(terrainGeometry, null, (a, b, c, n, albedo) => {
    centroid.set((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3)
    shadowStats.tested++
    const shadowed = inShadow(centroid.x, centroid.y, centroid.z)
    if (shadowed) shadowStats.shadowed++
    shade(albedo, n, shadowed, camera.position.distanceTo(centroid), rgb)
    raster.triangle([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], rgb)
  })

  // 水面：与真实水面同样按水深分带，只是这里按面取色（真实场景是逐顶点插值）
  const waterY = field.waterY()
  const waterSegments = 96
  const waterFaces = []
  const waterPalette = {}
  for (const key of Object.keys(WATER_PALETTE)) waterPalette[key] = new THREE.Color(WATER_PALETTE[key])
  const half = size / 2
  const stepSize = size / waterSegments
  const maxDepth = Math.max(waterY, 1e-3)
  const waterNormal = new THREE.Vector3(0, 1, 0)
  for (let j = 0; j < waterSegments; j++) {
    for (let i = 0; i < waterSegments; i++) {
      const x0 = -half + i * stepSize
      const z0 = -half + j * stepSize
      const x1 = x0 + stepSize
      const z1 = z0 + stepSize
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      const depth = Math.max(waterY - field.worldHeightSmooth(cx, cz), 0)
      const albedo = waterPalette[pickWaterBand(Math.min(depth / maxDepth, 1))]
      const distance = Math.hypot(camera.position.x - cx, camera.position.y - waterY, camera.position.z - cz)
      shadowStats.tested++
      const shadowed = inShadow(cx, waterY, cz)
      if (shadowed) shadowStats.shadowed++
      shade(albedo, waterNormal, shadowed, distance, rgb)
      raster.triangle([x0, waterY, z0], [x0, waterY, z1], [x1, waterY, z1], rgb)
      raster.triangle([x0, waterY, z0], [x1, waterY, z1], [x1, waterY, z0], rgb)
    }
  }

  // 地标标记：与真实场景同样的几何（细柱 + 八面体），按类别取色
  if (demData && landmarkMarkers) {
    landmarkMarkers.group.updateMatrixWorld(true)
    for (const child of landmarkMarkers.group.children) {
      const color = child.material?.color ?? new THREE.Color('#ffffff')
      eachFace(child.geometry, child.matrixWorld, (a, b, c, n) => {
        const cx2 = (a.x + b.x + c.x) / 3
        const cy2 = (a.y + b.y + c.y) / 3
        const cz2 = (a.z + b.z + c.z) / 3
        const dist = camera.position.distanceTo(new THREE.Vector3(cx2, cy2, cz2))
        // 标记自发光、不吃阴影，避免在陡坡上被地形阴影吞掉
        shade(color, n, false, dist, rgb)
        raster.triangle([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], rgb)
      })
    }
  }
  // 聚落建筑体块：与真实场景同一份几何（逐面单色，非索引）
  if (settlement) {
    settlement.group.updateMatrixWorld(true)
    for (const child of settlement.group.children) {
      // 注意 eachFace 的回调签名是 (a, b, c, n, albedo)——
      // 第三个参数 c 是三角形的第三个顶点，不是颜色。
      // 这里曾经把 c 当 albedo 用，结果整片镇子渲染成纯黑
      // （把顶点对象当 THREE.Color 读，分量全是 undefined）。别再犯。
      eachFace(child.geometry, child.matrixWorld, (a, b, c, n, albedo) => {
        const cx3 = (a.x + b.x + c.x) / 3
        const cy3 = (a.y + b.y + c.y) / 3
        const cz3 = (a.z + b.z + c.z) / 3
        const dist = camera.position.distanceTo(new THREE.Vector3(cx3, cy3, cz3))
        // 竖直墙面几乎接不到主光，全靠半球补光。地形侧那套 shade() 是按
        // "朝上的地表"调的（补光权重 1.35），直接套到墙面上会严重欠曝，
        // 整片镇子会糊成一团黑。这里把补光按竖直面的实际接收量单独算足。
        const dotNL = Math.max(0, n.x * keyDir.x + n.y * keyDir.y + n.z * keyDir.z)
        const hemiMix = 0.5 * n.y + 0.5
        const ambR = hemiGround.r + (hemiSky.r - hemiGround.r) * hemiMix
        const ambG = hemiGround.g + (hemiSky.g - hemiGround.g) * hemiMix
        const ambB = hemiGround.b + (hemiSky.b - hemiGround.b) * hemiMix
        // 与真实场景 material.emissive 的强度对应
        const emissive = 0.28
        let r = albedo.r * (INV_PI * (keyColor.r * SCENE_LOOK.keyIntensity * toonBand(dotNL) + ambR * 2.2) + emissive)
        let g = albedo.g * (INV_PI * (keyColor.g * SCENE_LOOK.keyIntensity * toonBand(dotNL) + ambG * 2.2) + emissive)
        let bl = albedo.b * (INV_PI * (keyColor.b * SCENE_LOOK.keyIntensity * toonBand(dotNL) + ambB * 2.2) + emissive)
        const fog2 = Math.min(Math.max((dist - FOG_NEAR) / (FOG_FAR - FOG_NEAR), 0), 1)
        if (fog2 > 0) {
          r += (fogColor.r - r) * fog2
          g += (fogColor.g - g) * fog2
          bl += (fogColor.b - bl) * fog2
        }
        rgb[0] = r
        rgb[1] = g
        rgb[2] = bl
        raster.triangle([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], rgb)
      })
    }
  }

  // 真实建筑轮廓（OSM）：与示意性聚落同样的着色方式
  if (osmBuildings) {
    osmBuildings.group.updateMatrixWorld(true)
    for (const child of osmBuildings.group.children) {
      eachFace(child.geometry, child.matrixWorld, (a, b, c, n, albedo) => {
        const cx4 = (a.x + b.x + c.x) / 3
        const cy4 = (a.y + b.y + c.y) / 3
        const cz4 = (a.z + b.z + c.z) / 3
        const dist = camera.position.distanceTo(new THREE.Vector3(cx4, cy4, cz4))
        const dotNL = Math.max(0, n.x * keyDir.x + n.y * keyDir.y + n.z * keyDir.z)
        const hemiMix = 0.5 * n.y + 0.5
        const ambR = hemiGround.r + (hemiSky.r - hemiGround.r) * hemiMix
        const ambG = hemiGround.g + (hemiSky.g - hemiGround.g) * hemiMix
        const ambB = hemiGround.b + (hemiSky.b - hemiGround.b) * hemiMix
        const emissive = 0.28
        let r = albedo.r * (INV_PI * (keyColor.r * SCENE_LOOK.keyIntensity * toonBand(dotNL) + ambR * 2.2) + emissive)
        let g = albedo.g * (INV_PI * (keyColor.g * SCENE_LOOK.keyIntensity * toonBand(dotNL) + ambG * 2.2) + emissive)
        let bl = albedo.b * (INV_PI * (keyColor.b * SCENE_LOOK.keyIntensity * toonBand(dotNL) + ambB * 2.2) + emissive)
        const fog3 = Math.min(Math.max((dist - FOG_NEAR) / (FOG_FAR - FOG_NEAR), 0), 1)
        if (fog3 > 0) {
          r += (fogColor.r - r) * fog3
          g += (fogColor.g - g) * fog3
          bl += (fogColor.b - bl) * fog3
        }
        rgb[0] = r
        rgb[1] = g
        rgb[2] = bl
        raster.triangle([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], rgb)
      })
    }
  }

  // 树与石：直接用真实的实例矩阵
  for (const source of [forest.group, rocks.group]) {
    for (const mesh of source.children) {
      if (!mesh.isInstancedMesh) continue
      if (!mesh.geometry?.attributes?.position) {
        console.log(
          `  !! 跳过异常实例网格：type=${mesh.type} count=${mesh.count} geometry=${mesh.geometry ? Object.keys(mesh.geometry.attributes).join(',') : '无'}`,
        )
        continue
      }
      const baseColor = mesh.material.color
      const matrix = new THREE.Matrix4()
      const tint = new THREE.Color()
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix)
        if (mesh.instanceColor) tint.fromArray(mesh.instanceColor.array, i * 3)
        else tint.setRGB(1, 1, 1)
        const albedo = new THREE.Color(
          baseColor.r * tint.r,
          baseColor.g * tint.g,
          baseColor.b * tint.b,
        )
        eachFace(mesh.geometry, matrix, (a, b, c, n) => {
          centroid.set((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3)
          shade(albedo, n, false, camera.position.distanceTo(centroid), rgb)
          raster.triangle([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], rgb)
        })
      }
    }
  }

  // 路线飘带：MeshBasicMaterial 不受光，但吃雾；虚线图案按 UV 复刻贴图的形状
  if (route) {
    const repeat = Math.max(1, Math.round(route.length / 5))
    const flow = 0.35 * 3 // 相当于播放 3 秒后的贴图偏移
    const dashAlpha = (u, v) => {
      const t = u * repeat - flow
      const frac = t - Math.floor(t)
      if (frac >= 0.03 && frac <= 0.36) return 1
      if (frac >= 0.5 && frac <= 0.73) {
        const k = (frac - 0.5) / 0.23
        return Math.abs(v - 0.5) <= 0.34 * (1 - k) ? 1 : 0
      }
      return 0
    }
    eachFace(route.geometry, null, (a, b, c, n, albedo, uv) => {
      centroid.set((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3)
      const distance = camera.position.distanceTo(centroid)
      const fog = Math.min(Math.max((distance - FOG_NEAR) / (FOG_FAR - FOG_NEAR), 0), 1)
      const r = accentColor.r + (fogColor.r - accentColor.r) * fog
      const g = accentColor.g + (fogColor.g - accentColor.g) * fog
      const bl = accentColor.b + (fogColor.b - accentColor.b) * fog
      raster.triangle([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], [r, g, bl], uv, dashAlpha)
    })
  }

  // 标记：几何与真实场景完全一致，摆到落点动画结束后的位置
  const markerGeometries = [
    { geometry: new THREE.RingGeometry(1.15, 1.52, 28).rotateX(-Math.PI / 2), unlit: true },
    { geometry: new THREE.ConeGeometry(0.52, 1.3, 12).rotateX(Math.PI).translate(0, 0.8, 0), unlit: false },
    { geometry: new THREE.SphereGeometry(0.6, 14, 10).translate(0, 1.7, 0), unlit: false },
  ]
  const markerMatrix = new THREE.Matrix4()
  for (const pick of picks) {
    const y = field.worldHeight(pick.x, pick.z)
    markerMatrix.makeTranslation(pick.x, y, pick.z)
    for (const { geometry, unlit } of markerGeometries) {
      eachFace(geometry, markerMatrix, (a, b, c, n) => {
        centroid.set((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3)
        const distance = camera.position.distanceTo(centroid)
        const fog = Math.min(Math.max((distance - FOG_NEAR) / (FOG_FAR - FOG_NEAR), 0), 1)
        let r
        let g
        let bl
        if (unlit) {
          r = accentColor.r
          g = accentColor.g
          bl = accentColor.b
        } else {
          shade(accentColor, n, false, distance, rgb)
          r = rgb[0]
          g = rgb[1]
          bl = rgb[2]
        }
        r += (fogColor.r - r) * fog
        g += (fogColor.g - g) * fog
        bl += (fogColor.b - bl) * fog
        raster.triangle([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], [r, g, bl])
      })
    }
  }

  // 俯视核准图额外叠一层地标圈：真实标记只有 56 m，在 960 px 的整幅图上
  // 不到 4 px，肉眼无法确认落位。这里按类别放大成明显的圈，只为核对位置。
  if (FLAT_MODE && demData && landmarkMarkers) {
    const list = landmarkMarkers.group.userData.list ?? []
    for (const lm of list) {
      const color = new THREE.Color(LANDMARK_COLORS[lm.kind] ?? '#ffffff')
      const r = size * 0.012
      const seg = 16
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2
        const a1 = ((k + 1) / seg) * Math.PI * 2
        const p0 = [lm.x + Math.cos(a0) * r, lm.y + 30, lm.z + Math.sin(a0) * r]
        const p1 = [lm.x + Math.cos(a1) * r, lm.y + 30, lm.z + Math.sin(a1) * r]
        const pc = [lm.x, lm.y + 30, lm.z]
        raster.triangle(p0, p1, pc, [color.r, color.g, color.b])
      }
    }
  }

  return raster
}

// ---------- 主流程 ----------
fs.mkdirSync(outDir, { recursive: true })
console.log(`地形：seed=${SEED} 网格=${RESOLUTION} 树=${forest.count} 石=${rocks.count} 标记=${picks.length} 路线长=${route ? route.length.toFixed(1) : 0}`)

for (const view of ['overview', 'top', 'settlement', 'closeup', 'route', 'low']) {
  shadowStats.tested = 0
  shadowStats.shadowed = 0
  const started = Date.now()
  const raster = renderView(view)
  const file = path.join(outDir, `${view}.png`)
  fs.writeFileSync(file, encodePng(WIDTH, HEIGHT, raster.toRgb8()))
  const ratio = shadowStats.tested ? (shadowStats.shadowed / shadowStats.tested) * 100 : 0
  console.log(`  ✓ ${view}.png  ${Date.now() - started}ms  阴影面占比 ${ratio.toFixed(1)}%`)
}

// 顺手把地形色带的分布打出来：如果某个色带几乎没出现，说明配色阈值偏了
//
// 直接从几何的 color 属性统计，而不是用 field 重跑一遍 pickBand。
// 几何颜色才是画面真正显示的东西；用 field 反算会与渲染脱节
// （本项目已踩过这个坑：统计报 forest 0%，而图里明显有深绿林带）。
const geoColor = terrainGeometry.attributes.color
const paletteEntries = Object.entries(TERRAIN_PALETTE).map(([key, hex]) => [
  key,
  new THREE.Color(hex),
])
const bandCount = {}
let unmatched = 0
for (let f = 0; f < geoColor.count; f += 3) {
  const r = geoColor.getX(f)
  const g = geoColor.getY(f)
  const b = geoColor.getZ(f)
  let best = null
  let bestD = Infinity
  for (const [key, c] of paletteEntries) {
    const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2
    if (d < bestD) {
      bestD = d
      best = key
    }
  }
  // 逐面有 ±7.5% 抖动，颜色不会精确等于色板值；距离过大说明没匹配上
  if (bestD > 0.02) unmatched++
  bandCount[best] = (bandCount[best] ?? 0) + 1
}
const totalFaces = geoColor.count / 3
console.log(`\n地形色带占比（直接统计几何颜色，${totalFaces} 面）`)
for (const key of Object.keys(TERRAIN_PALETTE)) {
  if (!bandCount[key]) {
    console.log(`  ${key.padEnd(14)} 0.0%  ← 该色带完全没出现`)
    continue
  }
  console.log(`  ${key.padEnd(14)} ${((bandCount[key] / totalFaces) * 100).toFixed(1)}%`)
}
console.log(`\n输出目录：${outDir}`)
