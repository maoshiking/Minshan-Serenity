/**
 * 自检脚本共用的 DEM 夹具：把 public/terrain 下的真实高程数据读进内存。
 *
 * 为什么单独抽出来：自检脚本从程序化地形改到 DEM 之后，
 * terrain-smoke / world-smoke / check-dem-path 三处都要读同一批文件。
 * 各写一份的话，哪天数据换了路径或改了长度校验，就会有几份彼此不一致的读法
 * ——本项目已经在"同一个值抄两遍"上栽过好几次。
 *
 * 这些脚本都是纯 ESM（package.json 里 "type": "module"），
 * 所以用 node:fs 的同步接口，不用 require。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：本文件在 scripts/lib/ 下，所以往上两级 */
export const ROOT = join(HERE, '..', '..')
export const TERRAIN_DIR = join(ROOT, 'public', 'terrain')

/**
 * 同步读取 DEM 元数据 + 高度场 + 可选的 OSM 建筑轮廓。
 *
 * @param {object} [options]
 * @param {number} [options.resolution] 需要降采样到的格数；不传则用原始 512²
 * @returns {{ data: Float32Array, meta: object, osmBuildings: object|null,
 *             resolution: number, sizeMeters: number, metaPath: string }}
 */
export function loadDemFixtureSync(options = {}) {
  const metaPath = join(TERRAIN_DIR, 'shuimo-dem.json')
  const binPath = join(TERRAIN_DIR, 'shuimo-dem.bin')

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const buf = readFileSync(binPath)
  const full = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

  const native = meta.grid?.cols ?? 0
  if (native < 2) throw new Error(`DEM 元数据网格尺寸不合法：${native}`)
  if (full.length !== native * native) {
    throw new Error(`DEM 数据长度与元数据不符：期望 ${native * native}，实际 ${full.length}`)
  }

  const target = options.resolution ?? native
  const data = target === native ? full : resample(full, native, target)

  let osmBuildings = null
  try {
    osmBuildings = JSON.parse(readFileSync(join(TERRAIN_DIR, 'shuimo-osm-buildings.json'), 'utf8'))
  } catch {
    osmBuildings = null
  }

  return {
    data,
    meta,
    osmBuildings,
    resolution: target,
    sizeMeters: meta.sizeMeters ?? 1600,
    metaPath,
  }
}

/** 双线性降采样（与 src/three/demField.js 的 resampleDem 同一算法） */
function resample(src, n, target) {
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
      const A = src[j0 * n + i0]
      const B = src[j0 * n + i0 + 1]
      const C = src[(j0 + 1) * n + i0]
      const D = src[(j0 + 1) * n + i0 + 1]
      out[j * target + i] = (A * (1 - s) + B * s) * (1 - t) + (C * (1 - s) + D * s) * t
    }
  }
  return out
}
