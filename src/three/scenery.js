import * as THREE from 'three'
import { fbm2D, mulberry32, smoothstep } from './noise.js'
import { createToonGradientMap } from './terrainMesh.js'

/**
 * 场景装饰：天空、水面、树林、岩石。
 *
 * 这一层会用到 document（canvas / 贴图），所以不放进 Node 冒烟测试里。
 * 所有材质统一走 MeshToonMaterial + 共享的 gradientMap，保证"赛璐璐"分层在整张图上一致。
 */

/**
 * 低多边形化的通用处理：转非索引 + 重算面法线。
 * 索引几何的顶点法线会被相邻面平均掉，棱角全糊——这一步是"块面感"的开关。
 *
 * 必须写成两条语句，不能链式调用：
 * three 0.186 的 computeVertexNormals() 已经不再返回 this（translate / rotateX 之类仍返回）。
 * 一旦链式写成 `geo.toNonIndexed().computeVertexNormals()`，拿到的是 undefined，
 * 而 InstancedMesh 的默认参数会把它静默换成一个空几何——表现是"树和石头完全不出现"，
 * 且控制台一声不吭。这个坑不能用肉眼之外的任何方式发现，所以这里显式拆开。
 */
export function facet(geometry) {
  const result = geometry.index ? geometry.toNonIndexed() : geometry
  result.computeVertexNormals()
  return result
}

/**
 * 天空三段渐变配色。
 * 抽成模块级常量是为了让离线预览渲染器用同一份来源——
 * 否则"预览图里的天空"和"场景里的天空"会成为两份会各自漂移的抄本。
 */
export const SKY_COLORS = { zenith: '#7cb2da', horizon: '#e8eff3', ground: '#ded2bd' }

const _skyZenith = new THREE.Color(SKY_COLORS.zenith)
const _skyHorizon = new THREE.Color(SKY_COLORS.horizon)
const _skyGround = new THREE.Color(SKY_COLORS.ground)

/** 按方向向量的 y 分量取天空色，公式与 createSkyDome 的顶点色完全一致 */
export function skyColorAt(y, target = new THREE.Color()) {
  const h = y < -1 ? -1 : y > 1 ? 1 : y
  return h >= 0
    ? target.copy(_skyHorizon).lerp(_skyZenith, Math.pow(h, 0.55))
    : target.copy(_skyHorizon).lerp(_skyGround, Math.pow(-h, 0.7))
}

/** 水面按水深的硬边色带，同样只此一份 */
export const WATER_PALETTE = {
  foam: '#e9e5d0',
  shallow: '#63a8bd',
  mid: '#3f7f9c',
  deep: '#2a5f7d',
}

/** 归一化水深（0 = 岸边，1 = 最深）→ 色带名 */
export function pickWaterBand(t) {
  if (t < 0.04) return 'foam'
  if (t < 0.26) return 'shallow'
  if (t < 0.58) return 'mid'
  return 'deep'
}

/**
 * 天空穹顶：用顶点色做垂直渐变。
 *
 * 为什么不用 ShaderMaterial：自定义着色器要自己 include <colorspace_fragment> 才能拿到
 * 正确的输出色彩空间，否则整个天空会偏暗。顶点色走标准管线，色彩空间由 three 负责。
 */
export function createSkyDome({ radius = 620 } = {}) {
  const geometry = new THREE.SphereGeometry(radius, 32, 20)
  const position = geometry.attributes.position
  const colorsAttr = new Float32Array(position.count * 3)

  const c = new THREE.Color()
  for (let i = 0; i < position.count; i++) {
    skyColorAt(position.getY(i) / radius, c)
    colorsAttr[i * 3] = c.r
    colorsAttr[i * 3 + 1] = c.g
    colorsAttr[i * 3 + 2] = c.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colorsAttr, 3))

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    // 不写深度：让它永远待在所有东西后面，不必操心半径够不够大
    depthWrite: false,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = -1
  mesh.frustumCulled = false
  return mesh
}

/**
 * 卡通浪线贴图。
 *
 * 注意底色不能是纯白也不能透明：贴图是乘算的（map × 顶点色），
 * 所以底色要略暗于白，画上去的白线才能比底色更亮，形成浪花高光。
 * 每一笔在 2×2 个偏移上各画一次，平铺时才不会在接缝处断掉。
 */
export function createWaterTexture({ size = 256, seed = 7 } = {}) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const random = mulberry32(seed)

  ctx.fillStyle = '#cfe3ea'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = '#ffffff'
  ctx.lineCap = 'round'

  for (let i = 0; i < 30; i++) {
    const x = random() * size
    const y = random() * size
    const len = 16 + random() * 44
    const bend = 4 + random() * 6
    ctx.globalAlpha = 0.32 + random() * 0.42
    ctx.lineWidth = 1.5 + random() * 2.2

    for (const dx of [0, -size]) {
      for (const dy of [0, -size]) {
        ctx.beginPath()
        ctx.moveTo(x + dx, y + dy)
        ctx.quadraticCurveTo(x + dx + len / 2, y + dy - bend, x + dx + len, y + dy)
        ctx.stroke()
      }
    }
  }
  ctx.globalAlpha = 1

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/**
 * 水面：一块贴满地图的平面，颜色按水深分成硬色带。
 *
 * 不做半透明——不透明才能彻底绕开透明排序问题，而"能看见水下"对卡通地图毫无必要；
 * 深度感由色带表达就够了。
 */
export function createWater(field, options = {}) {
  const { segments = 72, repeat = 5, gradientMap, waveSpeed = 0.022 } = options

  const waterY = field.waterY()
  const texture = createWaterTexture({ seed: field.options.seed + 31 })
  const ownedGradient = gradientMap ? null : createToonGradientMap()
  const gm = gradientMap ?? ownedGradient

  const geometry = new THREE.PlaneGeometry(field.size, field.size, segments, segments)
  // 平移到 XZ 平面，法线朝上
  geometry.rotateX(-Math.PI / 2)

  const position = geometry.attributes.position
  const colorsAttr = new Float32Array(position.count * 3)
  const bandColors = {
    foam: new THREE.Color(WATER_PALETTE.foam),
    shallow: new THREE.Color(WATER_PALETTE.shallow),
    mid: new THREE.Color(WATER_PALETTE.mid),
    deep: new THREE.Color(WATER_PALETTE.deep),
  }
  const c = new THREE.Color()
  const maxDepth = Math.max(waterY, 1e-3)

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    const z = position.getZ(i)
    const depth = Math.max(waterY - field.worldHeightSmooth(x, z), 0)
    // 硬边分层：卡通水面靠色带，一上渐变立刻变写实
    c.copy(bandColors[pickWaterBand(Math.min(depth / maxDepth, 1))])

    colorsAttr[i * 3] = c.r
    colorsAttr[i * 3 + 1] = c.g
    colorsAttr[i * 3 + 2] = c.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colorsAttr, 3))

  texture.repeat.set(repeat, repeat)

  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    map: texture,
    gradientMap: gm,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = waterY
  mesh.receiveShadow = true

  function update(delta, elapsed) {
    // 滚动贴图 = 水流。比顶点位移便宜一个数量级，卡通水体也看不出区别
    texture.offset.x += delta * waveSpeed
    texture.offset.y -= delta * waveSpeed * 0.45
    mesh.position.y = waterY + Math.sin(elapsed * 0.7) * 0.05
  }

  function dispose() {
    geometry.dispose()
    material.dispose()
    texture.dispose()
    ownedGradient?.dispose()
  }

  return { mesh, update, dispose }
}

/**
 * 树林：三棵一组（树干 + 下层锥 + 上层锥）用 InstancedMesh 铺开。
 *
 * 用实例化而不是 merge 成一个巨大几何：三次 draw call 就能画出近千棵树，
 * 而且每棵树还能有独立的缩放、朝向和色差。
 */
export function createForest(field, options = {}) {
  const {
    seed = field.options.seed + 101,
    slots = 64,
    density = 0.72,
    maxCount = 900,
    minHeight = field.waterLevel + 0.07,
    maxHeight = 0.82,
    maxSlope = 0.42,
    gradientMap,
  } = options

  const random = mulberry32(seed)
  const ownedGradient = gradientMap ? null : createToonGradientMap()
  const gm = gradientMap ?? ownedGradient

  const half = field.size / 2
  const cell = field.size / slots
  const placements = []

  for (let j = 0; j < slots && placements.length < maxCount; j++) {
    for (let i = 0; i < slots && placements.length < maxCount; i++) {
      const x = -half + (i + 0.5) * cell + (random() - 0.5) * cell * 0.85
      const z = -half + (j + 0.5) * cell + (random() - 0.5) * cell * 0.85

      // 低频噪声当"林班"遮罩：树成片长，而不是均匀撒胡椒面
      const mask = fbm2D((x / field.size + 0.5) * 3.4, (z / field.size + 0.5) * 3.4, {
        seed: seed + 4093,
        octaves: 3,
      })
      if (random() > density * smoothstep(0.34, 0.74, mask)) continue
      if (!field.plantable(x, z, { minHeight, maxHeight, maxSlope })) continue

      placements.push({
        x,
        z,
        y: field.worldHeight(x, z),
        scale: 0.62 + random() * 0.72,
        stretch: 0.85 + random() * 0.45,
        rotation: random() * Math.PI * 2,
        // 实例色是"乘算"的色调偏移，围绕 1 波动，得到同色系里的深浅变化
        tint: new THREE.Color().setRGB(
          0.8 + random() * 0.3,
          0.92 + random() * 0.18,
          0.76 + random() * 0.24,
        ),
      })
    }
  }

  const group = new THREE.Group()
  const count = placements.length
  if (count === 0) {
    return { group, count: 0, dispose: () => ownedGradient?.dispose() }
  }

  const trunkGeometry = facet(new THREE.CylinderGeometry(0.1, 0.17, 0.75, 5, 1).translate(0, 0.375, 0))
  const lowerGeometry = facet(new THREE.ConeGeometry(0.66, 1.25, 6, 1).translate(0, 1.18, 0))
  const upperGeometry = facet(new THREE.ConeGeometry(0.44, 0.95, 6, 1).translate(0, 2.02, 0))

  const trunkMaterial = new THREE.MeshToonMaterial({ color: '#7d5a3c', gradientMap: gm })
  const foliageMaterial = new THREE.MeshToonMaterial({ color: '#5f8f47', gradientMap: gm })

  const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, count)
  const lowerMesh = new THREE.InstancedMesh(lowerGeometry, foliageMaterial, count)
  const upperMesh = new THREE.InstancedMesh(upperGeometry, foliageMaterial, count)

  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const axis = new THREE.Vector3(0, 1, 0)

  for (let i = 0; i < count; i++) {
    const p = placements[i]
    position.set(p.x, p.y, p.z)
    quaternion.setFromAxisAngle(axis, p.rotation)
    scale.set(p.scale, p.scale * p.stretch, p.scale)
    matrix.compose(position, quaternion, scale)

    trunkMesh.setMatrixAt(i, matrix)
    lowerMesh.setMatrixAt(i, matrix)
    upperMesh.setMatrixAt(i, matrix)
    lowerMesh.setColorAt(i, p.tint)
    upperMesh.setColorAt(i, p.tint)
  }

  for (const mesh of [trunkMesh, lowerMesh, upperMesh]) {
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    // 实例散落在整张图上，包围球必须按实例算，否则相机动一下整片树林会被误剔除
    if (typeof mesh.computeBoundingSphere === 'function') mesh.computeBoundingSphere()
    group.add(mesh)
  }
  if (lowerMesh.instanceColor) lowerMesh.instanceColor.needsUpdate = true
  if (upperMesh.instanceColor) upperMesh.instanceColor.needsUpdate = true

  return { group, count, dispose: () => ownedGradient?.dispose() }
}

/**
 * 岩石：丢在陡坡脚下和水边，让地形不至于只有树和草。
 */
export function createRocks(field, options = {}) {
  const { seed = field.options.seed + 211, count = 44, gradientMap } = options

  const random = mulberry32(seed)
  const ownedGradient = gradientMap ? null : createToonGradientMap()
  const gm = gradientMap ?? ownedGradient

  const placements = []
  let tries = 0
  while (placements.length < count && tries < count * 60) {
    tries++
    const x = (random() - 0.5) * field.size * 0.94
    const z = (random() - 0.5) * field.size * 0.94
    const { u, v } = field.uvFromWorld(x, z)
    const h = field.heightAt(u, v)
    const slope = field.slopeAt(u, v)

    const nearShore = h > field.waterLevel - 0.03 && h < field.waterLevel + 0.09
    const onSlope = slope > 0.2 && slope < 0.72 && h > field.waterLevel + 0.02
    if (!nearShore && !onSlope) continue

    placements.push({
      x,
      z,
      y: field.worldHeight(x, z),
      scale: 0.34 + random() * 0.75,
      flatten: 0.55 + random() * 0.5,
      rotation: random() * Math.PI * 2,
    })
  }

  const group = new THREE.Group()
  const instanceCount = placements.length
  if (instanceCount === 0) {
    return { group, count: 0, dispose: () => ownedGradient?.dispose() }
  }

  const geometry = facet(new THREE.DodecahedronGeometry(0.5, 0))
  const material = new THREE.MeshToonMaterial({ color: '#8d8579', gradientMap: gm })
  const mesh = new THREE.InstancedMesh(geometry, material, instanceCount)

  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const axis = new THREE.Vector3(0, 1, 0)

  for (let i = 0; i < instanceCount; i++) {
    const p = placements[i]
    position.set(p.x, p.y - p.scale * 0.18, p.z)
    quaternion.setFromAxisAngle(axis, p.rotation)
    scale.set(p.scale, p.scale * p.flatten, p.scale)
    mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale))
  }

  mesh.instanceMatrix.needsUpdate = true
  mesh.castShadow = true
  mesh.receiveShadow = true
  if (typeof mesh.computeBoundingSphere === 'function') mesh.computeBoundingSphere()
  group.add(mesh)

  return { group, count: instanceCount, dispose: () => ownedGradient?.dispose() }
}
