/**
 * DEM 数据装载：把 scripts/dem/build-dem.mjs 产出的二进制高度场读进来，
 * 转成 createHeightFieldFromData 能直接吃的形态。
 *
 * 与程序化路径的分工
 * ------------------
 *   程序化：createHeightField(options)        —— 噪声算出来，可无限 reroll
 *   DEM   ：loadDemField() → createHeightFieldFromData(data, options)
 *
 * 两条路的产物品接口完全一致，所以 terrainMesh / scenery / route / picking
 * 以及 cartoonTerrain 的其余逻辑都不需要知道高度是哪来的。
 *
 * 关键参数换算
 * ------------
 * DEM 文件存的是**归一化高度**（0..1），元数据里带真实海拔区间。要让世界坐标里有
 * 真实米制高度，heightScale 必须设成真实高差（span）。否则：
 *   - heightScale 偏小 → 地形被压平，看不出峡谷
 *   - heightScale 偏大 → 山峰拉成尖刺，坡度判据（plantable / 色带）全部失准
 */

const DEM_BASE = '/terrain'

/**
 * 只取 DEM 元数据（约 1.6 KB，很快）。
 *
 * 存在的意义：DEM 二进制有 1 MB，若首屏就等它，页面会白屏一段时间。
 * 拆成两步之后可以先拿元数据把场景尺寸、高差、坐标中心定下来，
 * 让程序化占位地形立刻可见，再从后台把真实高度场灌进去。
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 自定义 fetch（自检脚本里可注入）
 */
export async function loadDemMeta(options = {}) {
  const { fetchImpl = globalThis.fetch } = options
  if (typeof fetchImpl !== 'function') {
    throw new Error('loadDemMeta: 当前环境没有 fetch，无法加载 DEM 元数据')
  }
  const res = await fetchImpl(`${DEM_BASE}/shuimo-dem.json`)
  if (!res.ok) {
    throw new Error(`DEM 元数据加载失败 HTTP ${res.status}（是否已运行 npm run dem:build？）`)
  }
  const meta = await res.json()
  const resolution = meta.grid?.cols ?? 0
  if (resolution < 2) throw new Error(`DEM 元数据的网格尺寸不合法：${resolution}`)
  return meta
}

/**
 * 只取 DEM 高度场与可选的 OSM 建筑轮廓。
 *
 * @param {object} meta loadDemMeta 的返回值（用于校验数据长度）
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 */
export async function loadDemData(meta, options = {}) {
  const { fetchImpl = globalThis.fetch } = options
  if (typeof fetchImpl !== 'function') {
    throw new Error('loadDemData: 当前环境没有 fetch，无法加载 DEM 数据')
  }

  const binRes = await fetchImpl(`${DEM_BASE}/shuimo-dem.bin`)
  if (!binRes.ok) throw new Error(`DEM 高度场加载失败 HTTP ${binRes.status}`)
  const buf = await binRes.arrayBuffer()
  const data = new Float32Array(buf)

  const resolution = meta.grid?.cols ?? 0
  if (data.length !== resolution * resolution) {
    throw new Error(
      `DEM 数据长度与元数据不符：期望 ${resolution * resolution}，实际 ${data.length}`,
    )
  }

  /**
   * 顺带取真实建筑轮廓（OSM）。取不到不算失败——它只是锦上添花，
   * 而且 OSM 在水磨古镇主街区几乎没有数据，缺失是常态。
   */
  let osmBuildings = null
  try {
    const bRes = await fetchImpl(`${DEM_BASE}/shuimo-osm-buildings.json`)
    if (bRes.ok) osmBuildings = await bRes.json()
  } catch {
    osmBuildings = null
  }

  return { data, meta, osmBuildings, resolution, sizeMeters: meta.sizeMeters ?? 1600 }
}

/**
 * 一步到位：元数据 + 高度场 + 可选的 OSM 建筑轮廓。
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 自定义 fetch（自检脚本里可注入）
 * @returns {Promise<{ data: Float32Array, meta: object, osmBuildings: object|null, resolution: number, sizeMeters: number }>}
 */
export async function loadDemField(options = {}) {
  const { fetchImpl = globalThis.fetch } = options

  if (typeof fetchImpl !== 'function') {
    throw new Error('loadDemField: 当前环境没有 fetch，无法加载 DEM 数据')
  }

  const meta = await loadDemMeta({ fetchImpl })
  return loadDemData(meta, { fetchImpl })
}

/**
 * 把 DEM 网格降采样到目标分辨率。
 *
 * 为什么必须做：DEM 原始网格是 512×512（约 52 万个三角面），而画面精度是可调的。
 * createHeightFieldFromData 要求数据长度等于 resolution²，所以选 128 格时必须先重采样，
 * 否则直接抛错。
 *
 * 用双线性而不是抽点采样：抽点会让山脊出现锯齿状断裂，而双线性至少保持形态连续。
 *
 * @param {{data: Float32Array, resolution: number}} dem
 * @param {number} target 目标每边顶点数
 * @returns {Float32Array} 行优先，长度 target*target
 */
export function resampleDem(dem, target) {
  const src = dem.data
  const n = dem.resolution
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

/**
 * 依据 DEM 元数据推导 terrain 参数。
 * 把这些推导集中在这里，而不是散在视图里，是为了让"真实米制高度"这件事只有一个出处。
 */
export function demTerrainOptions(meta, overrides = {}) {
  const span = meta?.elevation?.span ?? 300

  /**
   * 纵向放大系数。
   *
   * 为什么需要它：30 m 分辨率的公开 DEM 会把陡崖抹平。本场景实测平均坡度约 12°、
   * 最大 51°，而实拍照片里的谷壁明显更陡（约 18–25°）。这不是数据错，
   * 是分辨率的固有代价——地形可视化里对这种情况的标准做法就是纵向适度放大，
   * 把"感知陡度"补回来。
   *
   * 关键：**数据里存的仍是真实米值**（元数据 elevation 不受影响），
   * 放大只发生在这个渲染参数上。取高程读数、算真实距离都不受影响，
   * 受影响的只是"看起来多陡"。这是一个明确的视觉取舍，不是把数据改掉。
   */
  const verticalExaggeration = overrides.verticalExaggeration ?? 1.5

  return {
    // 真实高差 × 放大系数。归一化 1.0 对应"看起来 span × 1.5 米"
    heightScale: span * verticalExaggeration,
    /**
     * 水位（归一化值，与放大系数无关，所以两种情形下淹到的地形一致）。
     *
     * 不能用元数据里的 min10pct（0.1）：那是给程序化地形用的分位值，
     * 0.1 × 355 m ≈ 35.5 m，水面会高到淹没古镇（实测古镇地面只高出河谷约 25–40 m）。
     *
     * 按实测校准：河谷最低点 893 m，最低地标（羌碉、西羌汇）在 941 m。
     * 水位 0.07 → 893 + 0.07 × 355 ≈ 918 m，覆盖约 3% 面积，
     * 既不淹到古镇，又能把河床与砾石滩留出来。
     */
    waterLevel: 0.07,
    /**
     * 坡度采样半径。
     *
     * 半径 1（相邻格点）会被 DEM 的量化噪声主导——实测把 56% 的面积误判成裸岩陡崖。
     * 半径 4（25 m 基线）又把谷壁平均掉，P99 只剩 20.7°，崖再也出不来。
     * 实测半径 2（12.5 m）的分布最合理：P50 4.2°、P99 28.4°、最大 51.1°。
     */
    slopeRadius: 2,
    verticalExaggeration,
    /**
     * 真实高差（不含放大）。
     * 供下游把"几米水深"这类物理量换算成归一化偏移——heightScale 带放大系数，不能用它。
     */
    elevationSpan: span,
    ...overrides,
  }
}

/**
 * 经纬度 → 世界坐标（米）。与 build-dem.mjs 用同一套投影，必须保持一致，
 * 否则地标会整体偏移——这类错误肉眼很难发现，所以只允许有一个实现。
 */
export function lonLatToWorld(meta, lon, lat) {
  const M_PER_DEG_LAT = 111132.0
  const cLat = meta.origin.lat
  const cLon = meta.origin.lon
  const mPerDegLon = 111320.0 * Math.cos((cLat * Math.PI) / 180)

  return {
    x: (lon - cLon) * mPerDegLon,
    z: -(lat - cLat) * M_PER_DEG_LAT,
  }
}

/**
 * 归一化高度 → 真实海拔（米）
 */
export function normToElevation(meta, norm) {
  const { min, span } = meta.elevation
  return min + norm * span
}
