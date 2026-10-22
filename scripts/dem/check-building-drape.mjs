/**
 * 建筑贴地自证：检查每栋建筑底面与地形的贴合情况。
 *
 * 为什么需要：建筑是矩形体块，而地形是起伏曲面。若建筑底面取的是四个角
 * 的最低点，在坡地上会出现一部分悬空；若取最高点，则会陷进地里。
 * 这两种情况从远景看不出来，走近了就很明显。
 *
 * 用法：node scripts/dem/check-building-drape.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { resolveLandmarks } from '../../src/three/landmarks.js'
import { generateSettlementLayout } from '../../src/three/settlement.js'
import { buildOsmBuildingGeometry } from '../../src/three/osmBuildings.js'

const ROOT = process.cwd()
const meta = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols

function resample(src, n, t) {
  if (t === n) return src
  const last = n - 1
  const out = new Float32Array(t * t)
  for (let j = 0; j < t; j++) {
    const gg = (j / (t - 1)) * last
    const j0 = Math.min(Math.floor(gg), last - 1)
    const tt = gg - j0
    for (let i = 0; i < t; i++) {
      const f = (i / (t - 1)) * last
      const i0 = Math.min(Math.floor(f), last - 1)
      const s = f - i0
      const A = src[j0 * n + i0]
      const B = src[j0 * n + i0 + 1]
      const C = src[(j0 + 1) * n + i0]
      const D = src[(j0 + 1) * n + i0 + 1]
      out[j * t + i] = (A * (1 - s) + B * s) * (1 - tt) + (C * (1 - s) + D * s) * tt
    }
  }
  return out
}

const g = 512
const field = createHeightFieldFromData(resample(full, N, g), {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
})

/** 取真实米数：用 elevationSpan，不用带放大的 heightScale */
const trueSpan = field.options?.elevationSpan ?? field.heightScale
const hAt = (x, z) => field.surfaceHeightAt(x / field.size + 0.5, z / field.size + 0.5) * trueSpan

const landmarks = resolveLandmarks(meta, field)
const layout = generateSettlementLayout(field, landmarks)
console.log(`示意性聚落 ${layout.length} 栋，逐栋检查底面与地形的贴合`)
console.log('')

/**
 * 对每栋建筑，在它占地矩形的中心与四角采样地形，比较：
 *   baseY（几何里用的底面高度）与各地形采样点的关系
 *   - floatGap：底面高于地形的最大空档（悬空）
 *   - sinkDepth：底面低于地形的最大深度（陷入）
 */
let maxFloat = 0
let maxSink = 0
let floatCount = 0
let sinkCount = 0
const floatSamples = []
const sinkSamples = []

for (const b of layout) {
  const cos = Math.cos(b.rotation)
  const sin = Math.sin(b.rotation)
  const hw = b.w / 2
  const hd = b.d / 2
  // 四角 + 中心（局部 → 世界）
  const pts = [
    [0, 0],
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]
  const ter = pts.map(([lx, lz]) => hAt(b.x + lx * cos - lz * sin, b.z + lx * sin + lz * cos))
  const minT = Math.min(...ter)
  const maxT = Math.max(...ter)
  /**
   * 几何里底面 = 占地最低点 − (relief + 0.5)，见 settlement.js 的 sunkDepth。
   * 必须用下延后的底面判断悬空——用 b.y 判断会把"有意埋进坡里"误报成缺陷。
   */
  // b.relief 与 b.y 同为世界坐标尺度，直接用
  const baseY = minT - (b.relief ?? 0) - 0.5
  const floatGap = Math.max(0, minT - baseY) // 底面到最低地形点的空档
  const sinkDepth = Math.max(0, maxT - baseY) // 地形高于底面的最大量
  if (floatGap > 1.5) {
    floatCount++
    floatSamples.push({ name: '建筑', floatGap })
  }
  if (sinkDepth > 3) {
    sinkCount++
    sinkSamples.push({ name: '建筑', sinkDepth })
  }
  maxFloat = Math.max(maxFloat, floatGap)
  maxSink = Math.max(maxSink, sinkDepth)
}

console.log('示意性聚落（底面 = 占地最低点 - 0.4 m）')
console.log(`  最大悬空    ${maxFloat.toFixed(2)} m`)
console.log(`  最大陷入    ${maxSink.toFixed(2)} m（地形高出底面的量；这部分被地形包住，视觉上是"埋进坡里"）`)
console.log(`  悬空 > 1.5 m 的栋数  ${floatCount}`)
console.log(`  陷入 > 3 m 的栋数    ${sinkCount}`)

// 坡地建筑的占比：四角地形高差
let steep = 0
let maxSpread = 0
for (const b of layout) {
  const cos = Math.cos(b.rotation)
  const sin = Math.sin(b.rotation)
  const hw = b.w / 2
  const hd = b.d / 2
  const pts = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]
  const ter = pts.map(([lx, lz]) => hAt(b.x + lx * cos - lz * sin, b.z + lx * sin + lz * cos))
  const spread = Math.max(...ter) - Math.min(...ter)
  if (spread > 2) steep++
  maxSpread = Math.max(maxSpread, spread)
}
console.log('')
console.log(`  占地内高差 > 2 m 的建筑  ${steep} 栋（${((steep / layout.length) * 100).toFixed(1)}%）`)
console.log(`  占地内最大高差          ${maxSpread.toFixed(2)} m`)

// OSM 真实轮廓的贴地情况
let osm = null
try {
  osm = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-osm-buildings.json'), 'utf8'))
} catch {
  osm = null
}
if (osm) {
  let osmFloat = 0
  let osmSink = 0
  let osmMaxSpread = 0
  for (const b of osm.buildings) {
    const ter = b.ring.map((p) => hAt(p.x, p.z))
    const minT = Math.min(...ter)
    const maxT = Math.max(...ter)
    // b.relief 与 b.y 同为世界坐标尺度，直接用
  const baseY = minT - (b.relief ?? 0) - 0.5
    osmFloat = Math.max(osmFloat, minT - baseY)
    osmSink = Math.max(osmSink, maxT - baseY)
    osmMaxSpread = Math.max(osmMaxSpread, maxT - minT)
  }
  console.log('')
  console.log(`OSM 真实轮廓 ${osm.buildings.length} 栋`)
  console.log(`  最大悬空 ${osmFloat.toFixed(2)} m   最大陷入 ${osmSink.toFixed(2)} m   占地内最大高差 ${osmMaxSpread.toFixed(2)} m`)
}

console.log('')
console.log('判读：')
console.log('  - 悬空是硬缺陷（房子浮在空中），必须为 0 或极小')
console.log('  - 适度"陷入"对山地建筑是正常的（墙脚埋进坡里比悬空好看得多）')
console.log('  - 占地内高差大说明建筑横跨了陡坡，应该避免而不是靠贴地掩盖')
