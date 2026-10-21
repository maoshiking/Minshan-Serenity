import { clamp01, fbm2D, lerp, ridgedFbm2D, smoothstep } from './noise.js'

/**
 * 高度场：把"二维坐标 → 高度"这件事收敛成唯一入口。
 *
 * 刻意不 import three——这一层是纯数学，既能在浏览器里跑，也能在 Node 里直接做单元测试，
 * 法线也只返回普通对象（{x,y,z}），由调用方按需转成 THREE.Vector3。
 *
 * 关键设计：网格的三角剖分必须和 terrainMesh 里建几何时完全一致，
 * 否则标记点会浮空或陷进地里。剖分约定（记 A=(i,j) B=(i+1,j) C=(i,j+1) D=(i+1,j+1)）：
 *   三角形 1 = A,B,D（局部坐标里 s >= t 的那一半）
 *   三角形 2 = A,C,D（s <= t 的那一半）
 */

export const DEFAULT_TERRAIN_OPTIONS = {
  /** 每边顶点数。涨一倍，三角面涨四倍，是性能的主要旋钮 */
  resolution: 112,
  /** 地图世界尺寸（边长） */
  size: 120,
  seed: 20261021,
  octaves: 5,
  frequency: 1.9,
  lacunarity: 2.05,
  gain: 0.5,
  /** 山脊噪声的权重：越大越"险"，越小越"缓" */
  ridge: 0.55,
  /** 岛屿化强度：边缘往水下压，地图四周自然长出水域。太大会让陆地缩成湖心小岛 */
  island: 0.42,
  /** 梯田化强度：让高度往最近的台阶靠拢，出卡通台地感 */
  terrace: 0.32,
  terraceSteps: 11,
  /** 最高峰的世界高度 */
  heightScale: 17,
  /** 归一化水位：低于它的地方被水覆盖 */
  waterLevel: 0.33,
  ridgeSeedOffset: 977,
}

export function createHeightField(userOptions = {}) {
  const options = { ...DEFAULT_TERRAIN_OPTIONS, ...userOptions }
  const {
    resolution,
    size,
    seed,
    octaves,
    frequency,
    lacunarity,
    gain,
    ridge,
    island,
    terrace,
    terraceSteps,
    heightScale,
    waterLevel,
    ridgeSeedOffset,
  } = options

  const last = resolution - 1
  const count = resolution * resolution
  const raw = new Float32Array(count)

  let min = Infinity
  let max = -Infinity

  for (let j = 0; j < resolution; j++) {
    const v = j / last
    for (let i = 0; i < resolution; i++) {
      const u = i / last
      // 以地图中心为原点、范围 [-1,1] 的采样域，方便做径向衰减
      const nx = (u - 0.5) * 2
      const nz = (v - 0.5) * 2

      const base = fbm2D(nx * frequency, nz * frequency, { seed, octaves, lacunarity, gain })
      // 山脊层用不同的偏移和频率，避免和 base 的纹路对齐成"米字格"
      const crest = ridgedFbm2D(
        nx * frequency * 1.3 + 11.3,
        nz * frequency * 1.3 - 7.1,
        { seed: seed + ridgeSeedOffset, octaves: Math.max(3, octaves - 1), lacunarity, gain },
      )

      let h = base * (1 - ridge) + crest * ridge

      // 岛屿化：距中心越远压得越低，四周自然形成水域，地图不会"切边"
      h *= 1 - smoothstep(1 - island, 1.35, Math.hypot(nx, nz))

      // 梯田化：向最近的台阶靠拢。只靠一部分（terrace），保留自然起伏
      if (terrace > 0) {
        const stepped = Math.round(h * terraceSteps) / terraceSteps
        h += (stepped - h) * terrace
      }

      // 抬高高地、压平低地，海岸线更利落，山地也更挺拔
      h = Math.pow(Math.max(h, 0), 1.18)

      raw[j * resolution + i] = h
      if (h < min) min = h
      if (h > max) max = h
    }
  }

  // 归一化到 0..1：waterLevel 这类阈值才有跨 seed 的稳定含义
  const span = max - min || 1
  const data = new Float32Array(count)
  for (let k = 0; k < count; k++) data[k] = (raw[k] - min) / span

  const cellSize = size / last

  /** 归一化坐标 → 所在格子与格内余量 */
  function cellOf(t) {
    const f = clamp01(t) * last
    const i0 = Math.min(Math.floor(f), last - 1)
    return [i0, f - i0]
  }

  /** 双线性采样（归一化高度）。平滑，适合铺树、铺路面这种不该有硬折角的地方 */
  function heightAt(u, v) {
    const [i0, s] = cellOf(u)
    const [j0, r] = cellOf(v)
    const hA = data[j0 * resolution + i0]
    const hB = data[j0 * resolution + i0 + 1]
    const hC = data[(j0 + 1) * resolution + i0]
    const hD = data[(j0 + 1) * resolution + i0 + 1]
    return lerp(lerp(hA, hB, s), lerp(hC, hD, s), r)
  }

  /**
   * 三角面精确采样（归一化高度）。与地形网格的剖分逐字对齐，
   * 标记点、拾取、撒树都走这条，保证"贴地"严丝合缝。
   */
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

  /** 世界 xz → 世界 y（精确贴合可见三角面） */
  function worldHeight(x, z) {
    const { u, v } = uvFromWorld(x, z)
    return surfaceHeightAt(u, v) * heightScale
  }

  /** 世界 xz → 世界 y（双线性，光滑；飘带、水面用它） */
  function worldHeightSmooth(x, z) {
    const { u, v } = uvFromWorld(x, z)
    return heightAt(u, v) * heightScale
  }

  /**
   * 所在三角面的法线（世界空间，已归一化）。
   * 悬停光标靠它贴着坡面躺下，而不是永远水平插进山里。
   */
  function normalAt(u, v) {
    const [i0, s] = cellOf(u)
    const [j0, r] = cellOf(v)

    const hA = data[j0 * resolution + i0]
    const hB = data[j0 * resolution + i0 + 1]
    const hC = data[(j0 + 1) * resolution + i0]
    const hD = data[(j0 + 1) * resolution + i0 + 1]

    // 沿三角面两条边取向量，叉乘出法线
    let e1x
    let e1y
    let e1z
    let e2x
    let e2y
    let e2z
    if (s >= r) {
      e1x = cellSize
      e1y = (hB - hA) * heightScale
      e1z = 0
      e2x = cellSize
      e2y = (hD - hA) * heightScale
      e2z = cellSize
    } else {
      e1x = 0
      e1y = (hC - hA) * heightScale
      e1z = cellSize
      e2x = cellSize
      e2y = (hD - hA) * heightScale
      e2z = cellSize
    }

    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    // 统一朝上：叉乘的顺序随剖分分支翻转，这里强制 y 分量为正
    if (ny < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    const len = Math.hypot(nx, ny, nz) || 1
    return { x: nx / len, y: ny / len, z: nz / len }
  }

  /** 坡度：0 = 水平，1 = 垂直。直接用 1 - normal.y，和着色判据天然一致 */
  function slopeAt(u, v) {
    return clamp01(1 - normalAt(u, v).y)
  }

  /** 水面高度（世界 y） */
  function waterY() {
    return waterLevel * heightScale
  }

  /**
   * 这个点能不能长树/放石头：高度在带内、不太陡、且邻域不能是悬崖边（否则树会悬空）。
   */
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

    // 邻域再查一遍：坡度的中心差分对"崖边一条线"不敏感，这里补上
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
