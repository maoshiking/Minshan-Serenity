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

import { createHeightField } from '../../src/three/heightField.js'
import { buildTerrainGeometry, pickBand, TERRAIN_PALETTE } from '../../src/three/terrainMesh.js'
import { buildRoutePoints, buildRouteRibbon } from '../../src/three/route.js'
import { createForest, createRocks, pickWaterBand, skyColorAt, WATER_PALETTE } from '../../src/three/scenery.js'
import { SCENE_LOOK, frameTerrainCamera } from '../../src/three/cartoonTerrain.js'

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
const size = 120
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
const field = createHeightField({ seed: SEED, resolution: RESOLUTION })
const terrainGeometry = buildTerrainGeometry(field, { skirtDepth: field.heightScale * 0.85 })

const forest = createForest(field)
const rocks = createRocks(field)

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

function shade(albedo, normal, shadowed, distance, out) {
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

  /** 用天空渐变铺底：逐像素反投影出视线方向，取其 y 分量查天空色 */
  fillSky(camera) {
    const inverse = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert()
    const point = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const cameraPosition = camera.position
    const sky = new THREE.Color()

    for (let y = 0; y < this.height; y++) {
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

    let minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
    let maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)))
    let minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
    let maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)))
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
        // 重心坐标
        let e0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * invArea
        let e1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * invArea
        let e2 = 1 - e0 - e1
        if (e0 < 0 || e1 < 0 || e2 < 0) continue

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

  if (viewName === 'overview') {
    // 与真实场景共用取景函数：预览的构图就是用户第一眼看到的构图
    frameTerrainCamera(camera, {
      size,
      heightScale: field.heightScale,
      aspect: WIDTH / HEIGHT,
    })
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
  const camera = setupCamera(viewName)
  const raster = new Rasterizer(WIDTH, HEIGHT)
  raster.viewProjection = new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .toArray()

  raster.fillSky(camera)

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

  return raster
}

// ---------- 主流程 ----------
fs.mkdirSync(outDir, { recursive: true })
console.log(`地形：seed=${SEED} 网格=${RESOLUTION} 树=${forest.count} 石=${rocks.count} 标记=${picks.length} 路线长=${route ? route.length.toFixed(1) : 0}`)

for (const view of ['overview', 'closeup', 'route', 'low']) {
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
const bandCount = {}
for (let j = 0; j < RESOLUTION - 1; j += 2) {
  for (let i = 0; i < RESOLUTION - 1; i += 2) {
    const band = pickBand(field.heightAt((i + 0.5) / (RESOLUTION - 1), (j + 0.5) / (RESOLUTION - 1)), field.slopeAt((i + 0.5) / (RESOLUTION - 1), (j + 0.5) / (RESOLUTION - 1)), field.waterLevel)
    bandCount[band] = (bandCount[band] ?? 0) + 1
  }
}
const totalFaces = Object.values(bandCount).reduce((a, b) => a + b, 0)
console.log('\n地形色带占比：')
for (const key of Object.keys(TERRAIN_PALETTE)) {
  if (!bandCount[key]) {
    console.log(`  ${key.padEnd(14)} 0.0%  ← 该色带完全没出现`)
    continue
  }
  console.log(`  ${key.padEnd(14)} ${((bandCount[key] / totalFaces) * 100).toFixed(1)}%`)
}
console.log(`\n输出目录：${outDir}`)
