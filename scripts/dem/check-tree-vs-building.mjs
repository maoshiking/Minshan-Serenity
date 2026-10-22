/**
 * 林建冲突自证：检查是否有树落在建筑占地内。
 *
 * 为什么必须用数字而不是看图：近景里"树在房子后面"和"树长在屋顶上"在
 * 静态图上几乎分不出来。我一度以为禁区没生效，其实只是透视上重叠。
 * 这种判断只能量。
 *
 * 用法：node scripts/dem/check-tree-vs-building.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { resolveLandmarks } from '../../src/three/landmarks.js'
import { generateSettlementLayout } from '../../src/three/settlement.js'
import { createForest } from '../../src/three/scenery.js'

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

const g = 384
const field = createHeightFieldFromData(resample(full, N, g), {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
})

const landmarks = resolveLandmarks(meta, field)
const layout = generateSettlementLayout(field, landmarks)
console.log(`聚落 ${layout.length} 栋`)

/** 建筑的占地半径（近似为圆，取长宽的一半再放宽一点） */
const exclusionRadius = (b) => Math.max(b.w, b.d) * 0.5 + 2.5

const exclusions = layout.map((b) => ({ x: b.x, z: b.z, radius: exclusionRadius(b) }))

const forestOpts = {
  sizeScale: field.size / 260,
  slots: 160,
  maxCount: 5200,
  density: 0.34,
}
const withEx = createForest(field, { ...forestOpts, exclusions })
const withoutEx = createForest(field, forestOpts)

console.log(`树（无禁区）${withoutEx.count} 棵   树（有禁区）${withEx.count} 棵   排除掉 ${withoutEx.count - withEx.count} 棵`)
console.log('')

// 量化：每棵树到最近建筑中心的距离，与"建筑半径 + 树半径"比
function analyse(forest, label) {
  const placements = forest.layout ?? []
  if (!placements.length) {
    console.log(`${label}：拿不到 placements（createForest 未导出布局），跳过定量分析`)
    return null
  }
  let inside = 0
  let touching = 0
  let minGap = Infinity
  for (const t of placements) {
    for (const b of layout) {
      const d = Math.hypot(t.x - b.x, t.z - b.z)
      const r = Math.max(b.w, b.d) * 0.5
      // 树按 sizeScale 后的实际半径估算：基准锥半径 0.66 单位 × scale × sizeScale
      const treeR = 0.66 * (t.scale ?? 1) * (forestOpts.sizeScale ?? 1)
      if (d < r) inside++
      else if (d < r + treeR) touching++
      const gap = d - r - treeR
      if (gap < minGap) minGap = gap
      break
    }
  }
  console.log(`${label}：落在建筑占地内 ${inside} 棵，紧贴边缘 ${touching} 棵，最小间隙 ${minGap.toFixed(1)} m`)
  return { inside, touching, minGap }
}

const a = analyse(withEx, '有禁区')
console.log('')
if (a) {
  console.log(a.inside === 0 ? '✓ 没有树落在建筑占地内' : `✗ 仍有 ${a.inside} 棵树长在建筑里`)
} else {
  console.log('提示：createForest 目前没有把 placements 暴露出来，无法做定量分析。')
  console.log('      这是工具能力缺口——看图分不清"树在房后"和"树在屋顶上"。')
}
