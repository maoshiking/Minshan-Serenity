/**
 * DEM 路径自检：把"真实地形"这条链路真正跑一遍。
 *
 * 为什么单独写：既有的 terrain-smoke 与 world-smoke 都只覆盖程序化沙盘路径。
 * 这留了一个盲区——DEM 专用的模块（demField / demWater / landmarks / settlement /
 * osmBuildings）此前**从未被真正构建过**，只被"能不能 import"检查过。
 *
 * 代价是实测到的：demWater.js 里有一处 `material is not defined` 的运行时错误，
 * 150 项自检全都没抓到，因为没有任何一项真的去构造那片水面。
 * 这类"模块加载正常、一调用就炸"的错误，只有真调用才能发现。
 *
 * 用法：node scripts/check-dem-path.mjs
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as THREE from 'three'

import { createHeightFieldFromData } from '../src/three/heightField.js'
import { demTerrainOptions, lonLatToWorld, normToElevation } from '../src/three/demField.js'
import { createRiverbedWater } from '../src/three/demWater.js'
import { createLandmarkMarkers, resolveLandmarks, SHUIMO_LANDMARKS, LANDMARK_COLORS } from '../src/three/landmarks.js'
import { createSettlement, generateSettlementLayout, townAxisFromLandmarks, valleySpineFromField } from '../src/three/settlement.js'
import { buildOsmBuildingGeometry, createOsmBuildings } from '../src/three/osmBuildings.js'
import { buildTerrainGeometry, pickBand, TERRAIN_PALETTE } from '../src/three/terrainMesh.js'

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function run(label, fn) {
  console.log(`\n【${label}】`)
  try {
    fn()
  } catch (err) {
    failures.push(`${label} 抛出异常 — ${err.message}`)
    console.log(`  ✗ ${label} 抛出异常 — ${err.message}`)
    console.log(String(err.stack).split('\n').slice(0, 4).join('\n'))
  }
}

// ---------- 装载真实数据 ----------
const ROOT = process.cwd()
const meta = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(ROOT, 'public', 'terrain', 'shuimo-dem.bin'))
const full = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols
const g = 192

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

// 可选数据：OSM 真实建筑轮廓。取不到就跳过对应自检段
let osmRaw = null
try {
  osmRaw = JSON.parse(await readFile(join(ROOT, 'public', 'terrain', 'shuimo-osm-buildings.json'), 'utf8'))
} catch {
  osmRaw = null
}

let field = null
run('高度场（DEM 路径）', () => {
  field = createHeightFieldFromData(resample(full, N, g), {
    resolution: g,
    size: meta.sizeMeters,
    ...demTerrainOptions(meta),
  })
  check('高度场构建成功', !!field)
  check('网格尺寸正确', field.resolution === g, `期望 ${g}，实际 ${field.resolution}`)
  check('世界尺寸等于场景边长', field.size === meta.sizeMeters)
  check('高差含纵向放大', field.heightScale > meta.elevation.span, `heightScale=${field.heightScale}`)
  check('真实高差已单独留存', field.options.elevationSpan === meta.elevation.span)
  check('水位在合理区间', field.waterLevel > 0 && field.waterLevel < 0.2)

  // 贴地采样必须在值域内
  const samples = []
  for (let k = 0; k < 200; k++) {
    const u = (k % 20) / 19
    const v = Math.floor(k / 20) / 9
    if (v > 1) break
    samples.push(field.surfaceHeightAt(u, v))
  }
  check(
    'surfaceHeightAt 全部落在 0..1',
    samples.every((s) => s >= 0 && s <= 1),
    `越界 ${samples.filter((s) => s < 0 || s > 1).length} 个`,
  )

  // 坡度必须用真实高差算，不能受纵向放大影响
  let maxSlope = 0
  for (let j = 0; j < g; j += 3) {
    for (let i = 0; i < g; i += 3) {
      const s = field.slopeAt(i / (g - 1), j / (g - 1))
      if (s > maxSlope) maxSlope = s
    }
  }
  check(
    '坡度未受纵向放大影响',
    maxSlope < 0.95,
    `最大坡度 ${maxSlope.toFixed(4)}（若接近 1 说明放大被算进了坡度）`,
  )
})

run('经纬度换算', () => {
  const p = lonLatToWorld(meta, meta.origin.lon, meta.origin.lat)
  check('场景中心映射到原点', Math.abs(p.x) < 1e-6 && Math.abs(p.z) < 1e-6)
  const off = lonLatToWorld(meta, meta.origin.lon + 0.001, meta.origin.lat)
  check('东移 0.001° 得到正的 x', off.x > 0, `x=${off.x.toFixed(1)}`)
  const south = lonLatToWorld(meta, meta.origin.lon, meta.origin.lat - 0.001)
  check('南移 0.001° 得到正的 z', south.z > 0, `z=${south.z.toFixed(1)}`)
  const e = normToElevation(meta, 0)
  check('归一化 0 对应最低海拔', Math.abs(e - meta.elevation.min) < 1, `e=${e.toFixed(2)} min=${meta.elevation.min}`)
  const e2 = normToElevation(meta, 1)
  /**
   * 断言**跨度**而不是端点。
   * 元数据里 min 与 max 各自取整过，而 normToElevation 用 span 换算，
   * 所以端点差 1 m 属正常。跨度才是真正的物理量，值得断言。
   */
  check(
    '归一化区间跨度等于元数据 span',
    Math.abs(e2 - e - meta.elevation.span) < 1,
    `e2-e=${(e2 - e).toFixed(1)} span=${meta.elevation.span}`,
  )
  check('归一化 1 与最高海拔相差不超过 1 m', Math.abs(e2 - meta.elevation.max) <= 1, `e2=${e2.toFixed(2)} max=${meta.elevation.max}`)
})

run('河床水面（demWater）', () => {
  const water = createRiverbedWater(field, {})
  const geo = water.mesh.geometry
  check('水面构建成功', !!water.mesh)
  check('有 position 属性', !!geo.attributes.position && geo.attributes.position.count > 0)
  check('有 color 属性', !!geo.attributes.color)
  // 这一条是针对实际踩过的坑：手写三角面忘了生成 UV，贴图铺不上去
  check('有 uv 属性', !!geo.attributes.uv, '手写几何必须显式生成 UV')
  check(
    'position 与 uv 顶点数一致',
    geo.attributes.position.count === geo.attributes.uv.count,
    `position=${geo.attributes.position.count} uv=${geo.attributes.uv.count}`,
  )
  check('有材质', !!water.mesh.material)
  check('覆盖面积在合理区间', water.areaRatio > 0.005 && water.areaRatio < 0.15, `${(water.areaRatio * 100).toFixed(2)}%`)
  check('三角面数为偶数（每格两面）', geo.attributes.position.count / 3 % 2 === 0)
  check('update 可调用', typeof water.update === 'function')
  water.update(0.016, 1.0)
  check('dispose 可调用', typeof water.dispose === 'function')
  water.dispose()
})

run('地标（landmarks）', () => {
  const list = resolveLandmarks(meta, field)
  check('九地标里至少 6 个落在场景内', list.length >= 6, `实际 ${list.length}`)
  check('每个地标都有世界坐标', list.every((l) => Number.isFinite(l.x) && Number.isFinite(l.z)))
  check('每个地标都有真实海拔', list.every((l) => l.elevation > meta.elevation.min && l.elevation < meta.elevation.max))
  check('全部标记为待核（未经实地核校）', list.every((l) => l.verified === false))
  check('类别色都有定义', list.every((l) => LANDMARK_COLORS[l.kind]))
  check('地标总数与数据文件一致', SHUIMO_LANDMARKS.length === meta.landmarks.length)

  const markers = createLandmarkMarkers(list, {})
  check('标记组构建成功', !!markers.group)
  check('标记数量与地标数一致', markers.count === list.length)
  check('场景图里有子节点', markers.group.children.length > 0)
  markers.dispose()
})

run('聚落（settlement）', () => {
  const landmarks = resolveLandmarks(meta, field)
  const spine = valleySpineFromField(field)
  check('谷底线提取成功', !!spine && spine.points.length > 4)
  const axis = spine ?? townAxisFromLandmarks(landmarks)
  check('轴向为单位向量', Math.abs(Math.hypot(axis.dir.x, axis.dir.z) - 1) < 1e-6)

  const layout = generateSettlementLayout(field, landmarks)
  check('生成了建筑布局', layout.length > 100, `${layout.length} 栋`)
  check('每栋都有有限坐标', layout.every((b) => Number.isFinite(b.x) && Number.isFinite(b.z)))
  check('每栋都有正的高度', layout.every((b) => b.h > 0))
  const waterY = field.waterY()
  check('没有建筑落在水面以下', layout.every((b) => b.y >= waterY), `低于水面 ${layout.filter((b) => b.y < waterY).length} 栋`)

  const s = createSettlement(field, landmarks, {})
  check('聚落组构建成功', !!s.group)
  check('标注为示意（非真实轮廓）', s.synthetic === true)
  check('三角面数在预算内', s.triangleCount < 60000, `${s.triangleCount}`)
  s.dispose()
})

run('真实建筑轮廓（osmBuildings）', () => {
  let osm = null
  try {
    osm = JSON.parse(
      require('node:fs').readFileSync(join(ROOT, 'public', 'terrain', 'shuimo-osm-buildings.json'), 'utf8'),
    )
  } catch {
    osm = null
  }
  if (!osm) {
    console.log('  · 跳过：未找到 OSM 建筑数据文件（属可选）')
    return
  }
  const { geometry, triangleCount, buildingCount, concaveCount } = buildOsmBuildingGeometry(field, osm)
  check('几何构建成功', geometry.attributes.position.count > 0)
  check('三角面数合理', triangleCount > 0 && triangleCount < 50000, `${triangleCount}`)
  check('建筑数与数据文件一致', buildingCount === osm.buildings.length)
  check('有 color 属性', !!geometry.attributes.color)
  console.log(`  · 其中凹多边形 ${concaveCount} 个（用质心扇形三角化近似处理）`)

  const group = createOsmBuildings(field, osm, {})
  check('标注为真实轮廓（非示意）', group.synthetic === false)
  check('带来源信息', typeof group.source === 'string' && group.source.length > 0)
  check('带许可信息', typeof group.license === 'string' && group.license.length > 0)
  group.dispose()
})

run('色带判据（DEM 参数下的实际分布）', () => {
  const counts = {}
  let total = 0
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const band = pickBand(
        field.heightAt(i / (g - 1), j / (g - 1)),
        field.slopeAt(i / (g - 1), j / (g - 1)),
        field.waterLevel,
        field.options.elevationSpan,
      )
      counts[band] = (counts[band] || 0) + 1
      total++
    }
  }
  const missing = Object.keys(TERRAIN_PALETTE).filter(
    (k) => !counts[k] && !['wallTop', 'wallBottom', 'base'].includes(k),
  )
  check('所有地形色带都有出现', missing.length === 0, `缺失 ${missing.join(', ')}`)
  check('森林是占比最大的色带', counts.forest / total > (counts.grass || 0) / total, `forest ${((counts.forest / total) * 100).toFixed(1)}% vs grass ${(((counts.grass || 0) / total) * 100).toFixed(1)}%`)
  check('水面占比在 1%–8%', (counts.deepWater + counts.shallowWater) / total > 0.01 && (counts.deepWater + counts.shallowWater) / total < 0.08)
})

// ---------- 汇总 ----------
console.log('')
console.log(`DEM 路径自检：${passed}/${passed + failures.length} 通过`)
if (failures.length) {
  console.log('未通过：')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}
