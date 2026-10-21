import * as THREE from 'three'

/**
 * 解析式地形拾取。
 *
 * 不走 Raycaster 打七万个三角面——那在 pointermove 里是灾难（每次几毫秒，还随精度线性恶化）。
 * 地形本质上是 h = f(x,z)，射线与它的交点可以用"光线步进 + 二分收敛"直接解出来，
 * 代价只有几百次高度采样，精度反而更高（不受三角面离散化影响）。
 */

/** 射线与一条轴向区间 [min,max] 的相交参数范围 */
function slabRange(origin, direction, min, max) {
  if (Math.abs(direction) < 1e-9) {
    return origin >= min && origin <= max ? [-Infinity, Infinity] : null
  }
  let t1 = (min - origin) / direction
  let t2 = (max - origin) / direction
  if (t1 > t2) {
    const tmp = t1
    t1 = t2
    t2 = tmp
  }
  return [t1, t2]
}

/**
 * @param {object} field createHeightField 的返回值
 * @param {{origin: THREE.Vector3, direction: THREE.Vector3}} ray 一般是 raycaster.ray
 * @param {object} [options]
 * @param {number} [options.maxDistance] 最远拾取距离，默认地图边长的 4 倍
 * @param {number} [options.maxSteps] 步进上限，默认 2048
 * @param {number} [options.precision] 二分迭代次数，默认 22（约 2^-22 的区间收敛）
 * @returns {{point: THREE.Vector3, normal: THREE.Vector3, u: number, v: number, distance: number} | null}
 */
export function raycastField(field, ray, options = {}) {
  const {
    maxDistance = field.size * 4,
    maxSteps = 2048,
    precision = 22,
  } = options

  const o = ray.origin
  const d = ray.direction
  const half = field.size / 2

  // 先把参数范围收到"射线位于地图正上方"的那一段，后面的步进只在有效区间里跑
  const rx = slabRange(o.x, d.x, -half, half)
  if (!rx) return null
  const rz = slabRange(o.z, d.z, -half, half)
  if (!rz) return null

  const tMin = Math.max(rx[0], rz[0], 0)
  const tMax = Math.min(rx[1], rz[1], maxDistance)
  if (!(tMax > tMin)) return null

  const gap = (t) => o.y + d.y * t - field.worldHeight(o.x + d.x * t, o.z + d.z * t)

  // 步长取半个格子，保证不会整格跨过一个山头；同时用 maxSteps 兜住极端掠射
  const step = Math.max(field.cellSize * 0.5, (tMax - tMin) / maxSteps)

  let tPrev = tMin
  let gPrev = gap(tPrev)
  // 相机在地形内部或地下（理论上不会发生，但别让它把画面点得到处是标记）
  if (gPrev <= 0) return null

  for (let t = tMin + step; t <= tMax; t += step) {
    const g = gap(t)
    if (g <= 0) {
      // 找到符号翻转的区间，二分收敛到交点
      let lo = tPrev
      let hi = t
      for (let k = 0; k < precision; k++) {
        const mid = (lo + hi) * 0.5
        if (gap(mid) > 0) lo = mid
        else hi = mid
      }
      const tHit = (lo + hi) * 0.5
      return hitAt(field, o, d, tHit)
    }
    tPrev = t
    gPrev = g
  }

  return null
}

function hitAt(field, origin, direction, t) {
  const point = new THREE.Vector3(
    origin.x + direction.x * t,
    origin.y + direction.y * t,
    origin.z + direction.z * t,
  )
  const { u, v } = field.uvFromWorld(point.x, point.z)
  const n = field.normalAt(u, v)
  return {
    point,
    normal: new THREE.Vector3(n.x, n.y, n.z),
    u,
    v,
    distance: t,
  }
}
