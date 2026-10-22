/**
 * 性能护栏：实测地形几何的构建规模与内存占用，把"会不会崩"变成可核对的数字。
 *
 * 为什么需要它：几何量随网格分辨率平方增长，而画面精度是用户可调的。
 * 512×512 时地形就有 52 万个三角面，加上聚落、树林、水系，
 * 很容易在低端设备上直接卡死。这个脚本不测帧率（那需要真机），
 * 只测"构建出来的面数与内存"——这两项是帧率的上游指标。
 *
 * 用法：node scripts/dem/check-performance.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { demTerrainOptions } from '../../src/three/demField.js'
import { resolveLandmarks } from '../../src/three/landmarks.js'
import { buildTerrainGeometry } from '../../src/three/terrainMesh.js'
import { generateSettlementLayout, buildSettlementGeometry } from '../../src/three/settlement.js'
import { buildOsmBuildingGeometry } from '../../src/three/osmBuildings.js'

const ROOT = process.cwd()
const meta = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols
const osm = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-osm-buildings.json'), 'utf8'))

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

/**
 * 各档位的预算。这几条是"能不能交付"的判据，不是参考值。
 * 参考：中端手机 GPU 在 60 fps 下大约能稳在 20 万三角面以内（不叠加后处理）。
 */
const BUDGET = {
  /** 单帧三角面总量上限 */
  triangles: 400000,
  /** 几何构建耗时上限（毫秒）。超过说明用户切精度时会明显卡顿 */
  buildMs: 3000,
}

console.log(`DEM 源网格 ${N}×${N}   场景 ${meta.sizeMeters} m   高差 ${meta.elevation.span} m`)
console.log('')
console.log('网格      地形面数     聚落面数   真实轮廓   合计面数    构建耗时     内存估算    判定')
console.log('-'.repeat(96))

let allPass = true

for (const g of [128, 192, 256, 384, 512]) {
  const t0 = performance.now()
  const data = resample(full, N, g)
  const field = createHeightFieldFromData(data, {
    resolution: g,
    size: meta.sizeMeters,
    ...demTerrainOptions(meta),
  })

  const terrain = buildTerrainGeometry(field, { skirtDepth: field.heightScale * 0.16 })
  const terrainTris = terrain.attributes.position.count / 3

  const landmarks = resolveLandmarks(meta, field)
  const settlement = buildSettlementGeometryFor(field, landmarks)
  const osmGeom = buildOsmBuildingGeometry(field, osm)

  const buildMs = performance.now() - t0
  const totalTris = terrainTris + settlement.triangleCount + osmGeom.triangleCount

  // 内存估算：position + color + normal 三组 float32，顶点数 = 面数 × 3
  const vertices = totalTris * 3
  const bytes = vertices * (3 + 3 + 3) * 4
  const mb = bytes / 1024 / 1024

  const okTris = totalTris <= BUDGET.triangles
  const okTime = buildMs <= BUDGET.buildMs
  const pass = okTris && okTime
  if (!pass) allPass = false

  console.log(
    `${String(g).padStart(4)}²   ${String(terrainTris).padStart(9)}   ${String(settlement.triangleCount).padStart(9)}   ` +
      `${String(osmGeom.triangleCount).padStart(8)}   ${String(totalTris).padStart(9)}   ` +
      `${buildMs.toFixed(0).padStart(7)} ms   ${mb.toFixed(1).padStart(7)} MB   ` +
      `${pass ? '通过' : '超预算'}${okTris ? '' : '（面数）'}${okTime ? '' : '（耗时）'}`,
  )

  terrain.dispose?.()
}

function buildSettlementGeometryFor(field, landmarks) {
  // 先出布局，再建几何——buildSettlementGeometry 吃的是布局数组，不是 field
  const layout = generateSettlementLayout(field, landmarks)
  return buildSettlementGeometry(layout)
}


console.log('')
console.log(`预算：合计面数 ≤ ${BUDGET.triangles.toLocaleString('zh-CN')}，构建耗时 ≤ ${BUDGET.buildMs} ms`)
console.log(allPass ? '全部档位在预算内 ✓' : '有档位超出预算 ✗')
console.log('')
console.log('说明：本脚本测的是几何构建规模与耗时，不是帧率。')
console.log('      帧率必须在真机上测——软件光栅器与真实 GPU 的差异太大。')
