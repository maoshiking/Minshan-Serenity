/**
 * 确定性噪声工具。
 *
 * 地图必须可复现：同一个 seed 永远生成同一张地形。所以这里全部基于整数哈希，
 * 不使用 Math.random，也不持有任何跨调用的状态——同一个入参永远得到同一个结果。
 */

/**
 * 二维整数哈希 → [0, 1)。
 * 必须用 Math.imul：JS 的 * 在超过 2^53 之后会丢低位，噪声会出现明显的重复纹理。
 */
export function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * 可复现的伪随机序列（mulberry32）。
 * 用于撒树、撒石头、抖动这些"非噪声"用途，和 hash2 的区别是它带游标、按调用顺序推进。
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}

export function smoothstep(edge0, edge1, x) {
  const span = edge1 - edge0
  const t = clamp01(span === 0 ? (x < edge0 ? 0 : 1) : (x - edge0) / span)
  return t * t * (3 - 2 * t)
}

/** 五次平滑：一阶、二阶导都连续，value noise 才不会出现网格状的棱线 */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** 二维 value noise，返回 [0, 1] */
export function valueNoise2D(x, y, seed = 0) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = fade(x - x0)
  const ty = fade(y - y0)

  const n00 = hash2(x0, y0, seed)
  const n10 = hash2(x0 + 1, y0, seed)
  const n01 = hash2(x0, y0 + 1, seed)
  const n11 = hash2(x0 + 1, y0 + 1, seed)

  return lerp(lerp(n00, n10, tx), lerp(n01, n11, tx), ty)
}

/**
 * 分形叠加（fBm），返回 [0, 1]。
 * 每层用不同 seed 偏移，避免各倍频的格点重合导致重复花纹。
 */
export function fbm2D(x, y, options = {}) {
  const { seed = 0, octaves = 5, lacunarity = 2.05, gain = 0.5 } = options

  let amplitude = 1
  let total = 0
  let sum = 0
  let fx = x
  let fy = y

  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2D(fx, fy, seed + o * 131) * amplitude
    total += amplitude
    amplitude *= gain
    fx *= lacunarity
    fy *= lacunarity
  }

  return total > 0 ? sum / total : 0
}

/**
 * 山脊噪声：把 noise 折成 1-|2n-1| 再叠加，得到连绵的山脊线而不是圆滚滚的土丘。
 * 卡通地形的"山"靠它，否则整张图看起来像馒头。
 */
export function ridgedFbm2D(x, y, options = {}) {
  const { seed = 0, octaves = 4, lacunarity = 2.05, gain = 0.5, sharpness = 1.1 } = options

  let amplitude = 1
  let total = 0
  let sum = 0
  let fx = x
  let fy = y

  for (let o = 0; o < octaves; o++) {
    const n = valueNoise2D(fx, fy, seed + o * 197)
    sum += Math.pow(1 - Math.abs(n * 2 - 1), sharpness) * amplitude
    total += amplitude
    amplitude *= gain
    fx *= lacunarity
    fy *= lacunarity
  }

  return total > 0 ? sum / total : 0
}
