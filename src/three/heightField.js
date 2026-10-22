import { clamp01, lerp } from './noise.js'

/**
 * 高度场：把"二维坐标 → 高度"这件事收敛成唯一入口。
 *
 * 刻意不 import three——这一层是纯数学，既能在浏览器里跑，也能在 Node 里直接做单元测试，
 * 法线也只返回普通对象（{x,y,z}），由调用方按需转成 THREE.Vector3。
 *
 * 高度只来自**外部数据**（真实 DEM 高度场，见 demField.js）。
 * 早先还有一条"程序化噪声生成沙盘"的路径，那是海岛原型的遗留，已移除。
 *
 * 关键设计：网格的三角剖分必须和 terrainMesh 里建几何时完全一致，
 * 否则标记点会浮空或陷进地里。剖分约定（记 A=(i,j) B=(i+1,j) C=(i,j+1) D=(i+1,j+1)）：
 *   三角形 1 = A,B,D（局部坐标里 s >= t 的那一半）
 *   三角形 2 = A,C,D（s <= t 的那一半）
 */

/**
 * 高度场的默认参数。
 *
 * 注意 `size` 与 `heightScale` 这两个**必须由数据来源覆盖**：
 * 它们是场景的真实尺度（米），照默认值用会得到一个 120 单位的小方块。
 * 保留默认值只是为了让下面的解构有兜底，不代表可以被忽略。
 */
export const DEFAULT_TERRAIN_OPTIONS = {
  /** 每边顶点数。涨一倍，三角面涨四倍，是性能的主要旋钮 */
  resolution: 256,
  /** 地图世界尺寸（边长，米）——由 DEM 元数据覆盖 */
  size: 120,
  /** 最高处相对最低处的高差（米）——由 DEM 元数据覆盖 */
  heightScale: 24,
  /** 归一化水位：低于它的地方被水覆盖 */
  waterLevel: 0.07,
  /** 坡度采样半径（格数），DEM 模式取 2 */
  slopeRadius: 2,
}

/**
 * 归一化高度数组（0..1）+ 元信息 → 高度场。
 *
 * 存在意义：把"高度从哪来"和"高度怎么用"彻底解耦。下游的 terrainMesh / scenery /
 * route / picking 只认下面这套接口。
 *
 * 归一化语义必须是 0..1，否则 heightScale、waterLevel、plantable 的阈值全部失准。
 *
 * @param {Float32Array|number[]} normData 行优先，长度必须是 resolution*resolution
 * @param {object} [userOptions] 同 createHeightField，会覆盖默认值
 */
export function createHeightFieldFromData(normData, userOptions = {}) {
  const options = { ...DEFAULT_TERRAIN_OPTIONS, ...userOptions }
  const { resolution, size, heightScale, waterLevel } = options

  /**
   * 坡度的采样半径（格数）。默认 1 就是相邻格点，与程序化路径一致。
   *
   * 为什么 DEM 模式必须调大：相邻格点的坡度会被 DEM 的量化噪声主导。
   * 本项目的 DEM 原生精度是 4.1 m/像素，而 256 格网格的格距只有 6.3 m，
   * 于是"格点间高差"里混进的插值锯齿比真实地形起伏还大——实测用半径 1
   * 统计出的裸岩+陡崖占 56%，而按 25 m 物理基线量只有 9%。
   *
   * 取 radius=2（约 12.5 m 基线）是测绘上的常规做法：坡度应当表达"山坡有多陡"，
   * 而不是"两个相邻采样点差多少"。
   */
  const slopeRadius = Math.max(1, Math.min(userOptions.slopeRadius ?? 1, 16))

  /**
   * 算坡度用的高差，**不含纵向放大**。
   *
   * 为什么不直接用 heightScale：DEM 模式会给 heightScale 乘一个放大系数（1.5），
   * 那是为了让地形"看起来更陡"的渲染手段。若坡度也跟着放大，附属物的分类会整体偏移——
   * 实测 rock 从 7% 涨到 20.5%、forest 从 47.9% 掉到 37.7%，
   * 山体表面会被大面积涂成裸岩。**视觉放大不该改变"这里长什么"这个判断。**
   */
  const slopeSpan = userOptions.elevationSpan ?? heightScale

  const count = resolution * resolution
  if (!normData || normData.length !== count) {
    throw new Error(`createHeightFieldFromData: 数据长度应为 ${count}，实际 ${normData?.length}`)
  }

  // 复制一份，避免调用方之后复用同一个 buffer（重建地形时会踩到）
  const data = new Float32Array(count)
  for (let k = 0; k < count; k++) data[k] = clamp01(normData[k])

  const last = resolution - 1
  const cellSize = size / last

  function cellOf(t) {
    const f = clamp01(t) * last
    const i0 = Math.min(Math.floor(f), last - 1)
    return [i0, f - i0]
  }

  function heightAt(u, v) {
    const [i0, s] = cellOf(u)
    const [j0, r] = cellOf(v)
    const hA = data[j0 * resolution + i0]
    const hB = data[j0 * resolution + i0 + 1]
    const hC = data[(j0 + 1) * resolution + i0]
    const hD = data[(j0 + 1) * resolution + i0 + 1]
    return lerp(lerp(hA, hB, s), lerp(hC, hD, s), r)
  }

  function surfaceHeightAt(u, v) {
    const [i0, s] = cellOf(u)
    const [j0, r] = cellOf(v)
    const hA = data[j0 * resolution + i0]
    const hB = data[j0 * resolution + i0 + 1]
    const hC = data[(j0 + 1) * resolution + i0]
    const hD = data[(j0 + 1) * resolution + i0 + 1]
    return s >= r
      ? hA + (hB - hA) * s + (hD - hB) * r
      : hA + (hD - hC) * s + (hC - hA) * r
  }

  function worldFromUv(u, v) {
    return { x: (u - 0.5) * size, z: (v - 0.5) * size }
  }

  function uvFromWorld(x, z) {
    return { u: x / size + 0.5, v: z / size + 0.5 }
  }

  function worldHeight(x, z) {
    const { u, v } = uvFromWorld(x, z)
    return surfaceHeightAt(u, v) * heightScale
  }

  function worldHeightSmooth(x, z) {
    const { u, v } = uvFromWorld(x, z)
    return heightAt(u, v) * heightScale
  }

  function normalAt(u, v) {
    const [i0, s] = cellOf(u)
    const [j0, r] = cellOf(v)

    // slopeRadius = 1 时退化成原来的相邻格点差分，行为与程序化路径完全一致
    const rad = slopeRadius
    const ia = Math.max(0, i0 - rad)
    const ib = Math.min(resolution - 1, i0 + rad)
    const ja = Math.max(0, j0 - rad)
    const jb = Math.min(resolution - 1, j0 + rad)

    const hA = data[j0 * resolution + i0]
    const hB = data[j0 * resolution + i0 + 1]
    const hC = data[(j0 + 1) * resolution + i0]
    const hD = data[(j0 + 1) * resolution + i0 + 1]

    if (rad > 1) {
      // 用中心点的跨距差分：基线更长，量化噪声被平均掉
      const spanX = (ib - ia) * cellSize || cellSize
      const spanZ = (jb - ja) * cellSize || cellSize
      const hx0 = data[j0 * resolution + ia]
      const hx1 = data[j0 * resolution + ib]
      const hz0 = data[ja * resolution + i0]
      const hz1 = data[jb * resolution + i0]

      const e1x = spanX
      const e1y = (hx1 - hx0) * slopeSpan
      const e1z = 0
      const e2x = 0
      const e2y = (hz1 - hz0) * slopeSpan
      const e2z = spanZ

      let nx = e1y * e2z - e1z * e2y
      let ny = e1z * e2x - e1x * e2z
      let nz = e1x * e2y - e1y * e2x
      if (ny < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      const len = Math.hypot(nx, ny, nz) || 1
      return { x: nx / len, y: ny / len, z: nz / len }
    }

    let e1x
    let e1y
    let e1z
    let e2x
    let e2y
    let e2z
    if (s >= r) {
      e1x = cellSize
      e1y = (hB - hA) * slopeSpan
      e1z = 0
      e2x = cellSize
      e2y = (hD - hA) * slopeSpan
      e2z = cellSize
    } else {
      e1x = 0
      e1y = (hC - hA) * slopeSpan
      e1z = cellSize
      e2x = cellSize
      e2y = (hD - hA) * slopeSpan
      e2z = cellSize
    }

    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    if (ny < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    const len = Math.hypot(nx, ny, nz) || 1
    return { x: nx / len, y: ny / len, z: nz / len }
  }

  function slopeAt(u, v) {
    return clamp01(1 - normalAt(u, v).y)
  }

  function waterY() {
    return waterLevel * heightScale
  }

  function plantable(x, z, options2 = {}) {
    const {
      minHeight = waterLevel + 0.07,
      maxHeight = 0.82,
      maxSlope = 0.42,
      edgeMargin = 0.02,
    } = options2

    const { u, v } = uvFromWorld(x, z)
    if (u < edgeMargin || u > 1 - edgeMargin || v < edgeMargin || v > 1 - edgeMargin) return false

    const h = heightAt(u, v)
    if (h < minHeight || h > maxHeight) return false
    if (slopeAt(u, v) > maxSlope) return false

    const d = 1.6 / size
    const dx = Math.abs(heightAt(u + d, v) - heightAt(u - d, v))
    const dz = Math.abs(heightAt(u, v + d) - heightAt(u, v - d))
    return Math.max(dx, dz) < 0.13
  }

  return {
    options,
    data,
    resolution,
    size,
    last,
    cellSize,
    heightScale,
    waterLevel,
    heightAt,
    surfaceHeightAt,
    worldFromUv,
    uvFromWorld,
    worldHeight,
    worldHeightSmooth,
    normalAt,
    slopeAt,
    waterY,
    plantable,
  }
}
