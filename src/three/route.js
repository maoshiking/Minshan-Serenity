import * as THREE from 'three'

/**
 * 路线：把标记点串成一条贴着地形起伏的飘带。
 *
 * 为什么不用 Line：three 的线宽在多数平台被硬件钉死成 1px，做不出"导航带"的质感。
 * 用一条有宽度的带子，还能贴虚线贴图做流动动画。
 */

/**
 * 在 XZ 平面上用 Catmull-Rom 穿过所有标记点，得到平滑的二维路径。
 * 只用 centripetal 参数化：uniform 参数化在点距不均时会自交打结。
 */
export function buildRoutePoints(waypoints, options = {}) {
  const { samplesPerSegment = 16 } = options
  if (!waypoints || waypoints.length < 2) return []

  const curve = new THREE.CatmullRomCurve3(
    waypoints.map((p) => new THREE.Vector3(p.x, 0, p.z)),
    false,
    'centripetal',
  )

  const divisions = Math.max(8, (waypoints.length - 1) * samplesPerSegment)
  return curve.getPoints(divisions).map((p) => ({ x: p.x, z: p.z }))
}

/**
 * 把二维路径拉成一条贴地的飘带。
 *
 * 抬高策略：取"左缘 / 中线 / 右缘"三点地面的最大值再加 lift。
 * 直接用中线高度的话，带子在横向过坎时会被地形切掉半截。
 *
 * @returns {{ geometry: THREE.BufferGeometry, length: number } | null}
 */
export function buildRouteRibbon(field, points, options = {}) {
  const { width = 1.9, lift = 0.5 } = options
  const n = points?.length ?? 0
  if (n < 2) return null

  // 累计弧长：UV 按弧长分配，虚线在弯道和直道上才会一样长
  const arc = new Float32Array(n)
  let total = 0
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z)
    arc[i] = total
  }
  if (total < 1e-4) return null

  const positions = new Float32Array(n * 2 * 3)
  const uvs = new Float32Array(n * 2 * 2)

  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(n - 1, i + 1)]

    let tx = next.x - prev.x
    let tz = next.z - prev.z
    const tlen = Math.hypot(tx, tz) || 1
    tx /= tlen
    tz /= tlen

    // XZ 平面内的左法线
    const nx = -tz
    const nz = tx
    const hw = width * 0.5

    const lx = points[i].x + nx * hw
    const lz = points[i].z + nz * hw
    const rx = points[i].x - nx * hw
    const rz = points[i].z - nz * hw

    const y =
      Math.max(
        field.worldHeightSmooth(lx, lz),
        field.worldHeightSmooth(points[i].x, points[i].z),
        field.worldHeightSmooth(rx, rz),
      ) + lift

    const base = i * 6
    positions[base] = lx
    positions[base + 1] = y
    positions[base + 2] = lz
    positions[base + 3] = rx
    positions[base + 4] = y
    positions[base + 5] = rz

    const uvBase = i * 4
    const u = arc[i] / total
    uvs[uvBase] = u
    uvs[uvBase + 1] = 0
    uvs[uvBase + 2] = u
    uvs[uvBase + 3] = 1
  }

  const indices = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    const b = i * 2 + 1
    const c = i * 2 + 2
    const d = i * 2 + 3
    indices.push(a, b, d, a, d, c)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()

  return { geometry, length: total }
}

/**
 * 导航虚线贴图：一个周期里一段实线 + 一个箭头，重复后就是流动的导航带。
 * 箭头指向 +u，配合 offset.x 递减，视觉流向就是从起点到终点。
 */
export function createDashTexture({ width = 128, height = 32 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.globalAlpha = 1

  const cy = height / 2
  // 实线段
  ctx.fillRect(4, cy - 5, 42, 10)
  // 箭头
  ctx.beginPath()
  ctx.moveTo(64, cy - 11)
  ctx.lineTo(94, cy)
  ctx.lineTo(64, cy + 11)
  ctx.closePath()
  ctx.fill()

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}
