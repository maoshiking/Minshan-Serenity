import * as THREE from 'three'
import { createToonGradientMap } from './terrainMesh.js'
import { createWaterTexture, pickWaterBand, WATER_PALETTE } from './scenery.js'

/**
 * 水系：只在"地形低于水面"的格子上生成水面，而不是铺一整张平面。
 *
 * 为什么必须这么做
 * ----------------
 * scenery.createWater 用的是 size × size 的完整 PlaneGeometry，对程序化海岛是对的——
 * 那种地形四周本来就设计成下沉入水。但真实 DEM 不是海岛：
 *   - 水面高度只有 918 m，而场景大部分地面在 920–1250 m；
 *   - 一整张平面要么几乎全被地形盖住（看不见水），要么水位一抬高就淹掉古镇；
 *   - 更糟的是它会把"水面"画到山脊上方去。
 * 所以真实地形需要的是"河床形状的水面"，即只给淹没的格子铺面。
 *
 * 本函数与 createWater 共用配色与贴图（WATER_PALETTE / createWaterTexture），
 * 保持两边的观感一致；区别只在几何的生成范围。
 *
 * @param {object} field 高度场
 * @param {object} [options]
 * @returns {{ mesh: THREE.Mesh, update: Function, dispose: Function, areaRatio: number }}
 */
export function createRiverbedWater(field, options = {}) {
  const { gradientMap, waveSpeed = 0.022, textureRepeat = 5 } = options

  const N = field.resolution
  const last = N - 1
  const size = field.size
  const waterY = field.waterY()
  const cs = size / last
  const half = size / 2

  const ownedGradient = gradientMap ? null : createToonGradientMap()
  const gm = gradientMap ?? ownedGradient

  const bandColors = {
    foam: new THREE.Color(WATER_PALETTE.foam),
    shallow: new THREE.Color(WATER_PALETTE.shallow),
    mid: new THREE.Color(WATER_PALETTE.mid),
    deep: new THREE.Color(WATER_PALETTE.deep),
  }

  // 逐格判断是否淹没，并算出该格的淹没深度
  const depthAt = (i, j) => Math.max(waterY - field.heightAt(i / last, j / last) * field.heightScale, 0)

  let submergedFaces = 0
  let totalFaces = 0
  let maxDepth = 1e-3

  // 先扫一遍求最大深度，用于色带归一化
  for (let j = 0; j < last; j++) {
    for (let i = 0; i < last; i++) {
      totalFaces++
      const d =
        (depthAt(i, j) + depthAt(i + 1, j) + depthAt(i, j + 1) + depthAt(i + 1, j + 1)) / 4
      if (d > 0) {
        submergedFaces++
        if (d > maxDepth) maxDepth = d
      }
    }
  }

  const positions = new Float32Array(submergedFaces * 2 * 9)
  const colorsAttr = new Float32Array(submergedFaces * 2 * 9)
  /**
   * UV：按世界坐标线性映射。
   *
   * 必须显式生成——这个几何是手写的非索引三角面，没有 UV，
   * 不生成的话贴图根本铺不上去（材质里有 map 也会被忽略）。
   * 用世界 XZ 除以 sizeMeters 再乘 repeat，水流贴图才会沿河均匀铺开。
   */
  const uvs = new Float32Array(submergedFaces * 2 * 6)
  let cursor = 0
  let uvCursor = 0
  const c = new THREE.Color()

  const px = (i) => (i / last - 0.5) * size
  const pz = (j) => (j / last - 0.5) * size
  /** 世界坐标 → UV。repeat 由贴图的 texture.repeat 控制，这里给 0..1 的相对值 */
  const uOf = (x) => x / size + 0.5
  const vOf = (z) => z / size + 0.5

  function pushFace(ax, az, bx, bz, cx, cz, color) {
    positions[cursor] = ax
    positions[cursor + 1] = 0
    positions[cursor + 2] = az
    positions[cursor + 3] = bx
    positions[cursor + 4] = 0
    positions[cursor + 5] = bz
    positions[cursor + 6] = cx
    positions[cursor + 7] = 0
    positions[cursor + 8] = cz
    for (let k = 0; k < 3; k++) {
      colorsAttr[cursor + k * 3] = color.r
      colorsAttr[cursor + k * 3 + 1] = color.g
      colorsAttr[cursor + k * 3 + 2] = color.b
    }
    uvs[uvCursor] = uOf(ax)
    uvs[uvCursor + 1] = vOf(az)
    uvs[uvCursor + 2] = uOf(bx)
    uvs[uvCursor + 3] = vOf(bz)
    uvs[uvCursor + 4] = uOf(cx)
    uvs[uvCursor + 5] = vOf(cz)
    cursor += 9
    uvCursor += 6
  }

  for (let j = 0; j < last; j++) {
    for (let i = 0; i < last; i++) {
      const d00 = depthAt(i, j)
      const d10 = depthAt(i + 1, j)
      const d01 = depthAt(i, j + 1)
      const d11 = depthAt(i + 1, j + 1)
      const avg = (d00 + d10 + d01 + d11) / 4
      if (avg <= 0) continue

      c.copy(bandColors[pickWaterBand(Math.min(avg / maxDepth, 1))])

      const x0 = px(i)
      const x1 = px(i + 1)
      const z0 = pz(j)
      const z1 = pz(j + 1)
      // 绕序与地形地表一致：法线朝上
      pushFace(x0, z0, x1, z1, x1, z0, c)
      pushFace(x0, z0, x0, z1, x1, z1, c)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(positions.subarray(0, cursor), 3),
  )
  geometry.setAttribute(
    'color',
    new THREE.BufferAttribute(colorsAttr.subarray(0, cursor), 3),
  )
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs.subarray(0, uvCursor), 2))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()

  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: gm,
    side: THREE.DoubleSide,
  })

  /**
   * 水流贴图。
   *
   * 这里原来写的是 `texture = null`，注释说"仅浏览器挂，Node 预览跳过"——
   * 但那个分支在浏览器里也走同一行，于是河面**永远是一块纯色**，贴图从未生效。
   * 现在按需创建：createWaterTexture 依赖 canvas，没有 DOM 的环境（Node 出图）跳过即可，
   * 但这不该阻止浏览器里正常挂上。
   */
  let texture = null
  if (typeof document !== 'undefined') {
    texture = createWaterTexture({ seed: 31 })
    texture.repeat.set(textureRepeat, textureRepeat)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
  }
  if (texture) material.map = texture
  material.needsUpdate = true

  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = waterY
  mesh.receiveShadow = true
  // 略微抬一点，避免与地形地表同深度打架产生 z-fighting
  mesh.renderOrder = 1

  function update(delta, elapsed) {
    if (texture) {
      texture.offset.x += delta * waveSpeed
      texture.offset.y -= delta * waveSpeed * 0.45
    }
    mesh.position.y = waterY + Math.sin(elapsed * 0.7) * 0.04
  }

  function dispose() {
    geometry.dispose()
    material.dispose()
    texture?.dispose()
    ownedGradient?.dispose()
  }

  return {
    mesh,
    update,
    dispose,
    areaRatio: totalFaces ? submergedFaces / totalFaces : 0,
  }
}
