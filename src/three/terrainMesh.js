import * as THREE from 'three'
import { hash2 } from './noise.js'

/**
 * 卡通地形的几何构建。
 *
 * 出"块面感"的三个关键，缺一个就会变成圆滚滚的塑料山：
 *  1. 非索引几何（每个三角面独占三个顶点）——索引几何的顶点法线会被邻面平均掉，棱角全糊
 *  2. computeVertexNormals 在非索引几何上给出的是面法线 → 天然平面着色
 *     （顺带说明：MeshToonMaterial 没有 flatShading 属性，所以平面着色只能靠几何实现）
 *  3. 每个三角面一个颜色（在面心采样色带），而不是逐顶点插值 → 色带边界是硬的
 */

export const TERRAIN_PALETTE = {
  deepWater: '#24506b',
  shallowWater: '#4d94ad',
  sand: '#ecd9a4',
  grass: '#86b45c',
  meadow: '#a6c86d',
  forest: '#4e7c46',
  rock: '#918a7c',
  cliff: '#6f675c',
  snow: '#f4f6f7',
  /** 沙盘侧壁与底面 */
  wallTop: '#6f675c',
  wallBottom: '#4a443c',
  base: '#332e29',
}

/**
 * 高度 + 坡度 → 色带。
 * 全是硬阈值：卡通地形靠"分层"表达地形，靠渐变就变成写实了。
 */
export function pickBand(height01, slope01, waterLevel = 0.33) {
  if (slope01 > 0.6) return 'cliff'
  // 陡坡一律给岩石。早先让"高处 + 中等陡"也判成雪，结果山顶侧面出现零散白块，
  // 看着像破面而不是雪线——雪只该留给平缓的高处。
  if (slope01 > 0.38) return 'rock'
  if (height01 < waterLevel - 0.045) return 'deepWater'
  if (height01 < waterLevel + 0.012) return 'shallowWater'
  if (height01 < waterLevel + 0.06) return 'sand'
  if (height01 < 0.5) return 'grass'
  if (height01 < 0.66) return 'meadow'
  if (height01 < 0.8) return 'forest'
  if (height01 < 0.9) return 'rock'
  return 'snow'
}

/**
 * 构建地形几何：地表 + 一圈侧壁 + 底面，做成一块"沙盘"。
 * 有底座才像一块可以拿在手里的地图，而不是一张悬空的纸。
 *
 * 材质统一用 DoubleSide，所以这里不追求侧壁的缠绕顺序正确——缠绕对了是加分，
 * 错了也不会漏面。地表顶面的缠绕顺序是校验过的（朝上）。
 */
export function buildTerrainGeometry(field, options = {}) {
  const {
    palette = TERRAIN_PALETTE,
    /** 逐面明暗抖动幅度：低多边形的手绘感就来自这点不均匀 */
    jitter = 0.075,
    skirtDepth = field.heightScale * 0.8,
    withBase = true,
  } = options

  const { resolution, size, heightScale, data, last } = field
  const cs = size / last

  const resolved = {}
  for (const key of Object.keys(palette)) resolved[key] = new THREE.Color(palette[key])

  const surfaceFaces = last * last * 2
  const wallEdges = last * 4
  const wallFaces = wallEdges * 4
  const baseFaces = 2
  const faceCount = surfaceFaces + (withBase ? wallFaces + baseFaces : 0)

  const positions = new Float32Array(faceCount * 9)
  const colorAttr = new Float32Array(faceCount * 9)
  let cursor = 0

  const px = (i) => (i / last - 0.5) * size
  const pz = (j) => (j / last - 0.5) * size
  const py = (i, j) => data[j * resolution + i] * heightScale

  const tmp = new THREE.Color()

  function pushFace(ax, ay, az, bx, by, bz, cx, cy, cz, color) {
    positions[cursor] = ax
    positions[cursor + 1] = ay
    positions[cursor + 2] = az
    positions[cursor + 3] = bx
    positions[cursor + 4] = by
    positions[cursor + 5] = bz
    positions[cursor + 6] = cx
    positions[cursor + 7] = cy
    positions[cursor + 8] = cz
    for (let k = 0; k < 3; k++) {
      colorAttr[cursor + k * 3] = color.r
      colorAttr[cursor + k * 3 + 1] = color.g
      colorAttr[cursor + k * 3 + 2] = color.b
    }
    cursor += 9
  }

  // ---- 地表：逐面取色，缠绕顺序 (A,D,B) 与 (A,C,D) 保证法线朝上 ----
  for (let j = 0; j < last; j++) {
    for (let i = 0; i < last; i++) {
      const u = (i + 0.5) / last
      const v = (j + 0.5) / last
      const band = pickBand(field.heightAt(u, v), field.slopeAt(u, v), field.waterLevel)
      tmp.copy(resolved[band]).multiplyScalar(1 + (hash2(i, j, 0x51ed) - 0.5) * jitter)

      const x0 = px(i)
      const x1 = px(i + 1)
      const z0 = pz(j)
      const z1 = pz(j + 1)
      const yA = py(i, j)
      const yB = py(i + 1, j)
      const yC = py(i, j + 1)
      const yD = py(i + 1, j + 1)

      pushFace(x0, yA, z0, x1, yD, z1, x1, yB, z0, tmp)
      pushFace(x0, yA, z0, x0, yC, z1, x1, yD, z1, tmp)
    }
  }

  if (withBase) {
    // ---- 侧壁：沿四条边界围一圈。分上下两条色带，做出沉积岩的层理 ----
    const bottomY = -skirtDepth
    const midY = bottomY * 0.42

    const loop = []
    for (let i = 0; i <= last; i++) loop.push([i, 0])
    for (let j = 1; j <= last; j++) loop.push([last, j])
    for (let i = last - 1; i >= 0; i--) loop.push([i, last])
    for (let j = last - 1; j >= 1; j--) loop.push([0, j])

    for (let k = 0; k < loop.length; k++) {
      const [i0, j0] = loop[k]
      const [i1, j1] = loop[(k + 1) % loop.length]
      const x0 = px(i0)
      const z0 = pz(j0)
      const y0 = py(i0, j0)
      const x1 = px(i1)
      const z1 = pz(j1)
      const y1 = py(i1, j1)

      pushFace(x0, y0, z0, x1, y1, z1, x1, midY, z1, resolved.wallTop)
      pushFace(x0, y0, z0, x1, midY, z1, x0, midY, z0, resolved.wallTop)
      pushFace(x0, midY, z0, x1, midY, z1, x1, bottomY, z1, resolved.wallBottom)
      pushFace(x0, midY, z0, x1, bottomY, z1, x0, bottomY, z0, resolved.wallBottom)
    }

    // ---- 底面 ----
    const h = size / 2
    pushFace(-h, bottomY, -h, h, bottomY, h, h, bottomY, -h, resolved.base)
    pushFace(-h, bottomY, -h, -h, bottomY, h, h, bottomY, h, resolved.base)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3))
  // 非索引几何 → 这里得到的是面法线，正是要的块面感
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * 卡通阶梯渐变贴图：把受光压成 4 档硬边，MeshToonMaterial 靠它出赛璐璐感。
 * 尺寸只有 4 像素、NearestFilter 不过滤，所以"档"是硬的而不是渐变的。
 */
export function createToonGradientMap(steps = [0.42, 0.66, 0.86, 1]) {
  const data = new Uint8Array(steps.map((s) => Math.round(s * 255)))
  const texture = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
