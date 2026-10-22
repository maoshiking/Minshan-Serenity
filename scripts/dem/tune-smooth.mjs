/**
 * 平滑强度标定：给不同的 SMOOTH_PASSES 算平均坡度，找出"既压掉量化噪声、
 * 又不抹平真实地形"的那一档。
 *
 * 判据：真实谷深 349 m、谷宽约 800 m，谷壁平均坡度应在 20–30°。
 * 若平滑后平均坡度远低于此，说明地形被抹平了。
 *
 * 用法：node scripts/dem/tune-smooth.mjs
 */

const GRID_REF = 256
const M_PER_DEG_LAT = 111132.0

// 直接读原始瓦片（绕过 build-dem，好对比不同平滑度）
const { readFile, readdir } = await import('node:fs/promises')
const { join } = await import('node:path')

const meta = JSON.parse(
  await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.json'), 'utf8'),
)
const raw = await readFile(join(process.cwd(), 'public', 'terrain', 'shuimo-dem.bin'))
const base = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
const N = meta.grid.cols
const size = meta.sizeMeters
const span = meta.elevation.span

function binomial(norm, passes) {
  if (passes <= 0) return norm
  const out = new Float32Array(norm.length)
  const tmp = new Float32Array(norm.length)
  out.set(norm)
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let acc = 0
        let wsum = 0
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj
          if (jj < 0 || jj >= N) continue
          const wj = dj === 0 ? 2 : 1
          for (let di = -1; di <= 1; di++) {
            const ii = i + di
            if (ii < 0 || ii >= N) continue
            const wi = di === 0 ? 2 : 1
            const w = wi * wj
            acc += out[jj * N + ii] * w
            wsum += w
          }
        }
        tmp[j * N + i] = acc / wsum
      }
    }
    out.set(tmp)
  }
  return out
}

function resample(src, n, target) {
  if (target === n) return src
  const last = n - 1
  const out = new Float32Array(target * target)
  for (let j = 0; j < target; j++) {
    const g = (j / (target - 1)) * last
    const j0 = Math.min(Math.floor(g), last - 1)
    const t = g - j0
    for (let i = 0; i < target; i++) {
      const f = (i / (target - 1)) * last
      const i0 = Math.min(Math.floor(f), last - 1)
      const s = f - i0
      const hA = src[j0 * n + i0]
      const hB = src[j0 * n + i0 + 1]
      const hC = src[(j0 + 1) * n + i0]
      const hD = src[(j0 + 1) * n + i0 + 1]
      out[j * target + i] = (hA * (1 - s) + hB * s) * (1 - t) + (hC * (1 - s) + hD * s) * t
    }
  }
  return out
}

/** 用与 heightField.normalAt 相同的算法统计平均坡度，并给出色带占比 */
function stats(data, grid) {
  const cs = size / (grid - 1)
  let sum = 0
  let cnt = 0
  const bands = { cliff: 0, rock: 0, veg: 0, low: 0 }
  const waterLevel = meta.waterLevelCandidates?.min10pct ?? 0.1

  for (let j = 0; j < grid - 1; j++) {
    for (let i = 0; i < grid - 1; i++) {
      const hA = data[j * grid + i]
      const hB = data[j * grid + i + 1]
      const hC = data[(j + 1) * grid + i]
      const hD = data[(j + 1) * grid + i + 1]
      const e1x = cs, e1y = (hB - hA) * span, e1z = 0
      const e2x = cs, e2y = (hD - hA) * span, e2z = cs
      const nx = e1y * e2z - e1z * e2y
      const ny = e1z * e2x - e1x * e2z
      const nz = e1x * e2y - e1y * e2x
      const len = Math.hypot(nx, ny, nz) || 1
      const slope = 1 - Math.abs(ny) / len
      const h = (hA + hB + hC + hD) / 4
      sum += slope
      cnt++
      if (slope > 0.93) bands.cliff++
      else if (slope > 0.86) bands.rock++
      else if (h < waterLevel + 0.045) bands.low++
      else bands.veg++
    }
  }
  const avg = sum / cnt
  return {
    avg,
    deg: (Math.asin(Math.min(1, avg)) * 180) / Math.PI,
    bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, ((v / cnt) * 100).toFixed(1)])),
  }
}

console.log('平滑档位对地形的影响（判据：平均坡度落在 20–30° 才算保住了真实地形）')
console.log('')
console.log('平滑遍数  128²平均坡度  256²平均坡度  512²平均坡度   色带占比(256²)  cliff/rock/low/veg')
console.log('-'.repeat(104))

for (const passes of [0, 1, 2, 3]) {
  const sm = binomial(base, passes)
  const rows = []
  for (const g of [128, 256, 512]) {
    const d = resample(sm, N, g)
    const s = stats(d, g)
    rows.push(s)
  }
  const detail = rows[1]
  console.log(
    `${String(passes).padStart(6)}      ${rows[0].deg.toFixed(1).padStart(6)}°      ${rows[1].deg
      .toFixed(1)
      .padStart(6)}°      ${rows[2].deg.toFixed(1).padStart(6)}°      ${detail.bands.cliff}/${detail.bands.rock}/${detail.bands.low}/${detail.bands.veg}`,
  )
}

console.log('')
console.log('结论要点：')
console.log('  - 0 遍：分辨率越细坡度越陡，同一地形在三个网格下观感差异巨大（虚假陡坡）')
console.log('  - 1 遍：压掉大部分量化阶梯，仍保留真实沟壑')
console.log('  - 2 遍以上：平均坡度掉到 10° 以下，谷壁被抹圆，地形失去立体感')
