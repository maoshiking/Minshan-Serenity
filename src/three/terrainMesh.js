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
  deepWater: '#1f4a63',
  shallowWater: '#46809b',
  /** 河床砾石滩。岷山河谷枯水期露出大片砾石，是这个场景最有辨识度的特征之一 */
  sand: '#cfc4ae',
  /** 农田/河滩草甸。水磨古镇河谷有大量耕作带 */
  field: '#9fb469',
  grass: '#7a9e4e',
  /** 岷山以林山为主，森林必须是最宽的色带，不能是点缀 */
  forest: '#3f6238',
  /** 阴坡密林：比 forest 更深，用来表现真实山体的沟壑层次 */
  darkForest: '#2c4830',
  /** 高海拔草甸：岷山 1200 m 以上林线附近的开阔地 */
  alpineMeadow: '#a0ab6b',
  rock: '#8b8578',
  cliff: '#655e54',
  snow: '#eef1f3',
  /** 沙盘侧壁与底面。要够浅，否则底座会在画面里变成一大块黑，抢掉地形的视觉重量 */
  wallTop: '#a89a86',
  wallBottom: '#857867',
  base: '#6b6053',
}

/**
 * 高度 + 坡度 → 色带。
 *
 * 岷山与海岛的区别（这是阈值必须重定的原因）
 * ------------------------------------------------
 * 海岛沙盘的地形是噪声生成的，坡度温和，0.38 判岩、0.6 判崖刚好。
 * 真实岷山地形实测坡度中位数就有 ~0.74（约 48°），沿用旧阈值会把
 * 66% 的面积画成裸岩，整座山变成灰扑扑的石头堆——但真实的岷山是**林山**，
 * 陡坡上照样长满树。
 *
 * 所以判据改成"覆盖物"而不是"坡度"：
 *   - 水与砾石滩按高度判（水面最平，也是最低处）
 *   - 植被在很陡的坡上仍然存在（0.86 约 58° 才开始露岩）
 *   - 裸岩只在真正的陡崖上出现
 * 这样既保留真实地形的陡峭感，又符合岷山以林为主的视觉事实。
 */
/**
 * 高度 + 坡度 → 色带。
 *
 * 有两条既有约定不能破（terrain-smoke 里有断言，它们是对的）：
 *   1. **陡崖优先于高度**：够陡就是崖，不管它在多高（pickBand(0.95, 0.7) 必须是 cliff）
 *   2. **陡坡一律给岩石不给雪**：否则山顶侧面会散落白块，看着像破面
 *
 * 阈值怎么定的（全部来自实测，不是感觉）
 * ------------------------------------------------
 * 用 12.5 m 物理基线（slopeRadius = 2）的 slopeAt 分位数：
 *   P50 4.2° · P90 14.6° · P95 18.9° · P98 24.5° · P99 28.4° · 最大 51.1°
 * 分布形态是对的：多数面积是平缓的河谷与台地，陡的谷壁在尾部。
 *
 * @param {number} height01   归一化高度 0..1
 * @param {number} slope01    坡度 0..1（1 - 法线.y）
 * @param {number} [waterLevel] 归一化水位
 * @param {number} [elevSpan] 场景真实高差（米）。用于把"水深几米"换算成归一化偏移。
 *                            不传则按 355 m（本项目的实际高差）处理。
 */
export function pickBand(height01, slope01, waterLevel = 0.33, elevSpan = 355) {
  /**
   * 水与滩先判。
   *
   * 分界按**物理深度**定，而不是拍一个归一化偏移。实测本场景：
   *   河谷最低点归一化 0.053（海拔 912 m）
   *   水面        归一化 0.070（海拔 918 m）
   * 水面最深处只有约 7 m，所以深水取"水面下 4 m"，覆盖约 0.6%。
   *
   * 这个色带被写坏过三次，每次症状都一样：占比 0.02%、视觉上不存在。
   * 根因都是拿一个固定归一化偏移去套，而没算过"那到底相当于几米"。
   * 所以这里改成由 elevSpan 现算，不再写死。
   */
  const deepOffset = 4 / elevSpan
  if (height01 < waterLevel - deepOffset) return 'deepWater'
  if (height01 < waterLevel + 0.004) return 'shallowWater'
  if (height01 < waterLevel + 0.045) return 'sand'

  // 陡崖优先于高度：够陡就是崖
  if (slope01 > 0.5) return 'cliff'
  // 陡坡一律给岩石，不看高度——否则山顶侧面会出现零散雪块，像破面
  if (slope01 > 0.27) return 'rock'

  // 雪只在最高的平缓处（岷山这个高差约 350 m，雪线本就该很高）
  if (height01 > 0.93) return 'snow'

  /**
   * 植被：按海拔分层。
   *
   * 关键的纠正：早先给 0.34 以下留了一大段 grass，结果 grass 占到 48.6%。
   * 但实测河谷底在归一化 0.13–0.25（海拔 940–980 m），这个高度在岷山
   * **满山都是树**，不该是大片草地。grass 只该留给镇子附近的开阔地，
   * 所以把它压到 waterLevel 以上很窄的一段。
   */
  if (height01 < waterLevel + 0.062) return 'field'
  if (height01 < waterLevel + 0.1) return 'grass'
  if (height01 < 0.46) return 'forest'
  if (height01 < 0.68) return 'darkForest'
  if (height01 < 0.88) return 'forest'
  return 'alpineMeadow'
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
      /**
       * 传真实高差而不是 heightScale。
       *
       * 因为 heightScale 可能带纵向放大系数（DEM 模式为 1.5），
       * 而 pickBand 里"水面下 4 m 算深水"的换算必须用真实米数，否则深度判据会偏。
       * 归一化高度本身与放大无关，所以只有这个换算比例需要修正。
       */
      const trueSpan = field.options?.elevationSpan ?? heightScale
      const band = pickBand(field.heightAt(u, v), field.slopeAt(u, v), field.waterLevel, trueSpan)
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
