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
  if (gPrev === 0) return hitAt(field, o, d, tMin)

  // 记录整条射线上最接近地表的一点，供"相切"兜底使用
  let closestT = tMin
  let closestGap = Math.abs(gPrev)

  for (let t = tMin + step; t <= tMax; t += step) {
    const g = gap(t)
    const absGap = Math.abs(g)
    if (absGap < closestGap) {
      closestGap = absGap
      closestT = t
    }

    // 找第一个"上下穿面"的位置，两个方向都要认。
    //
    // 从上方穿到下方是正常的落点。从下方穿到上方则发生在射线从地图侧面切进山体时：
    // 地表只存在于地图范围内，所以射线一进入范围就可能已经在地表之下（起点在"山体内部"），
    // 这时往前穿出的那一点，才是使用者实际看到并点中的那个表面。
    // 早先这里直接判定"起点在地下就返回 null"，表现就是地图边缘的山点不中。
    if ((gPrev > 0 && g <= 0) || (gPrev < 0 && g >= 0)) {
      const above = gPrev > 0
      let lo = tPrev
      let hi = t
      for (let k = 0; k < precision; k++) {
        const mid = (lo + hi) * 0.5
        const gm = gap(mid)
        if (above ? gm > 0 : gm < 0) lo = mid
        else hi = mid
      }
      return hitAt(field, o, d, (lo + hi) * 0.5)
    }

    tPrev = t
    gPrev = g
  }

  /*
   * 没有任何穿面，但有可能是射线正好与地表「相切」——擦着山脊过去，
   * gap 触零后立刻回升，符号始终不变。这种情况数学上交点确实存在，
   * 而且对应"点山脊边缘/轮廓线"这个真实操作，不该判空。
   *
   * 阈值取 heightScale 的 1%（远小于一个格子的起伏），所以悬空点击不会被误判成命中。
   */
  if (closestGap < field.heightScale * 0.01) {
    // 切点处 gap 不变号，二分法用不上，改用三分搜索把 |gap| 的最小值收敛出来，
    // 否则返回的只是最近的采样点，在脊线附近会有几个百分点的误差
    let lo = Math.max(tMin, closestT - step)
    let hi = Math.min(tMax, closestT + step)
    for (let k = 0; k < 40; k++) {
      const m1 = lo + (hi - lo) / 3
      const m2 = hi - (hi - lo) / 3
      if (Math.abs(gap(m1)) < Math.abs(gap(m2))) hi = m2
      else lo = m1
    }
    return hitAt(field, o, d, (lo + hi) * 0.5)
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
