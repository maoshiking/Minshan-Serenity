/**
 * 直接测 heightField.slopeAt 的分位数，确认色带阈值该落在哪。
 * 与 tune-smooth.mjs 的区别：这里走的是下游真正使用的那个函数，
 * 避免"我自己算的坡度"和"terrainMesh 用的坡度"不是同一个东西。
 *
 * 用法：node scripts/dem/check-band-thresholds.mjs [grid]
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHeightFieldFromData } from '../../src/three/heightField.js'
import { pickBand, TERRAIN_PALETTE } from '../../src/three/terrainMesh.js'
import { demTerrainOptions } from '../../src/three/demField.js'

const g = Number(process.argv[2] || 256)

const meta = JSON.parse(await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.json'), 'utf8'))
const raw = await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.bin'))
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

/**
 * 地形参数一律从 demTerrainOptions 取，不在这里另写一套。
 *
 * 教训：这里原本硬编码 slopeRadius=4、waterLevel=0.1，
 * 而实现后来已改成 slopeRadius=2、waterLevel=0.07。
 * 于是脚本用**过时参数**给结论——报出的最大坡度是 0.5684，实际是 0.7778，
 * 直接导致"cliff 色带永不出现"这个错误判断，还让我去改了一个本来正确的阈值。
 *
 * 凡是能从单一出处推导的参数，就不该在工具里抄第二遍。
 */
const data = resample(full, N, g)
const field = createHeightFieldFromData(data, {
  resolution: g,
  size: meta.sizeMeters,
  ...demTerrainOptions(meta),
  ...(process.env.SLOPE_RADIUS ? { slopeRadius: Number(process.env.SLOPE_RADIUS) } : {}),
})

const slopes = []
const bandCount = {}
for (let j = 0; j < g; j++) {
  for (let i = 0; i < g; i++) {
    const u = i / (g - 1)
    const v = j / (g - 1)
    const s = field.slopeAt(u, v)
    slopes.push(s)
    const band = pickBand(field.heightAt(u, v), s, field.waterLevel, field.heightScale)
    bandCount[band] = (bandCount[band] || 0) + 1
  }
}

slopes.sort((a, b) => a - b)
const q = (p) => slopes[Math.min(slopes.length - 1, Math.floor(p * slopes.length))]
const deg = (v) => ((Math.asin(Math.min(1, v)) * 180) / Math.PI).toFixed(1)

console.log(`网格 ${g}²   样本 ${slopes.length}`)
console.log('field.slopeAt 分位数：')
for (const p of [0.5, 0.75, 0.9, 0.95, 0.98, 0.99, 0.995, 1.0]) {
  const v = q(p)
  console.log(`  P${(p * 100).toFixed(1).padStart(5)}  ${v.toFixed(4)}   约 ${deg(v).padStart(4)}°`)
}

console.log('\n色带占比：')
const total = slopes.length
/**
 * 色带名单从色板动态取，不硬编码。
 *
 * 教训：这里原本写死了一份名单，色板新增 alpineMeadow 之后就漏统计了它，
 * 报告里显示"meadow 0%"，而实际是那个新高海拔色带没被算进来——
 * 工具与代码脱节会给出看似正常的错误结论。凡是可以从单一出处推导的，就不要抄一遍。
 */
const order = Object.keys(TERRAIN_PALETTE)
for (const k of order) {
  const n = bandCount[k] || 0
  const pct = (n / total) * 100
  console.log(`  ${k.padEnd(13)} ${pct.toFixed(2).padStart(6)}%  ${'#'.repeat(Math.round(pct / 2))}`)
}

/**
 * 只报告**真正的死色带**，且按缺失原因分类。
 *
 * 原来的提示是硬编码的一句："未出现的色带：X（rock/cliff 完全不出现说明阈值高于
 * 地形实际坡度上限）"。只要有任何色带缺失就无脑打印那半句，于是 rock 占 7%、
 * cliff 占 0.59% 时也会被说成"完全不出现"——**报告自己给出了与数据矛盾的结论**。
 */
const missing = order.filter((k) => !bandCount[k])
/** 这三个只画在地形边缘的立面上，俯视统计里本就不该出现，不算缺失 */
const baseOnly = new Set(['wallTop', 'wallBottom', 'base'])
const trulyMissing = missing.filter((k) => !baseOnly.has(k))

if (trulyMissing.length) {
  console.log(`\n未出现的色带：${trulyMissing.join(', ')}`)
  for (const k of trulyMissing) {
    if (k === 'rock' || k === 'cliff') {
      console.log(`  ${k}：坡度阈值高于地形实际最大坡度（P100 = ${q(1).toFixed(4)}），该分支不会被触发`)
    } else if (k === 'deepWater' || k === 'shallowWater') {
      console.log(`  ${k}：水位分界比河谷最低点还低，水面判不出来`)
    } else if (k === 'snow') {
      console.log(`  ${k}：高度阈值高于地形实际最高点`)
    } else {
      console.log(`  ${k}：未被 pickBand 返回，检查判据分支`)
    }
  }
} else {
  console.log('\n所有地形色带均有出现 ✓')
}
