/**
 * DEM 构建脚本：把公开高程瓦片（AWS Terrain Tiles / Terrarium 编码）转成本项目的
 * 高度场数据文件，供 src/three/heightField.js 的 createHeightFieldFromData 直接消费。
 *
 * 设计要点
 * --------
 * 1. **输出的是归一化高度**（0..1），与程序化高度场同一语义。这样 heightScale、
 *    waterLevel 这些既有旋钮的含义不变，下游 terrainMesh / scenery / picking
 *    一行都不用改。真实海拔另外存进 meta，用于水位判定与文案。
 * 2. **坐标约定与项目一致**：field 的 u 轴 → 世界 x → 经度（东正），
 *    v 轴 → 世界 z → 纬度（南正）。世界坐标单位是米，1 单位 = 1 米。
 * 3. 网格是规则格，直接写 Float32 的二进制，512×512 只有 1 MB，加载比 PNG 快且无解码依赖。
 *
 * 用法
 * ----
 *   node scripts/dem/build-dem.mjs                # 用默认参数构建
 *   node scripts/dem/build-dem.mjs --half 0.8     # 改范围（半边长，公里）
 *   node scripts/dem/build-dem.mjs --grid 512     # 改网格
 *
 * 输出
 * ----
 *   public/terrain/shuimo-dem.bin    归一化高度 Float32 小端
 *   public/terrain/shuimo-dem.json   元数据（含真实海拔、经纬度范围、水位建议）
 */

import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT_DIR = join(ROOT, 'public', 'terrain')
const CACHE_DIR = join(process.env.TEMP || '/tmp', 'minshan-dem-cache')

// ---------------------------------------------------------------- 参数

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback
}

/** 场景半边长（米）。1.6 km 见方 = 半边长 800 m */
const HALF_M = argOf('half', 0.8) * 1000
/** 网格每边顶点数 */
const GRID = argOf('grid', 512)
/** 采样用的瓦片层级。z=15 约 4.1 m/像素，比 512 格（约 3.1 m/格）略粗，够用 */
const TILE_Z = argOf('zoom', 15)

/**
 * 场景中心。取"古镇群"的几何中心，而不是九地标或四角坐标的简单平均。
 *
 * 推导：九个地标里有八个聚在古镇一带（约 530 × 400 m），
 * 仁吉喜目谷独自在东北 1.6 km 外。若把它算进去，中心会被拽向东北，
 * 古镇与河谷就偏离画面中心，宝贵的分辨率浪费在古镇外面的荒坡上。
 *
 *   八点均值  103.420265 E, 30.930068 N
 *
 * 用这个点做中心，1600 m 见方的窗口正好把河谷、古镇、寿溪湖与两侧谷壁都框进来。
 * 仁吉喜目谷仍在范围外——它本来就属于另一个片区，P3 扩域时再纳入。
 */
const CENTER = { lat: 30.930068, lon: 103.420265 }

const TERRARIUM_URL = (z, x, y) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const M_PER_DEG_LAT = 111132.0

const deg2tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z
const deg2tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}
const tileX2lon = (x, z) => (x / 2 ** z) * 360 - 180
const tileY2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI
}

const lonToX = (lon) => (lon - CENTER.lon) * 111320 * Math.cos((CENTER.lat * Math.PI) / 180)
const latToZ = (lat) => -(lat - CENTER.lat) * M_PER_DEG_LAT

// ---------------------------------------------------------------- PNG 解码

/**
 * 极简 PNG 解码：只支持 8 位 RGB/RGBA 非隔行，正是 Terrarium 瓦片的格式。
 * 不引第三方库——这个项目至今零运行时依赖，构建脚本也不该破例。
 */
async function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (bitDepth !== 8) throw new Error(`只支持 8 位，收到 ${bitDepth}`)
      if (colorType !== 2 && colorType !== 6) throw new Error(`只支持 RGB/RGBA，收到 ${colorType}`)
      if (data[12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }

  const channels = colorType === 6 ? 4 : 3
  const raw = Buffer.concat(idat)

  // zlib 解压：Node 内置
  const { inflateSync } = await import('node:zlib')
  const inflated = inflateSync(raw)

  const stride = width * channels
  const out = Buffer.alloc(width * height * channels)

  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = inflated[rp++]
    const line = inflated.subarray(rp, rp + stride)
    rp += stride

    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null

    for (let i = 0; i < stride; i++) {
      const rawByte = line[i]
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let val
      switch (filter) {
        case 0:
          val = rawByte
          break
        case 1:
          val = rawByte + a
          break
        case 2:
          val = rawByte + b
          break
        case 3:
          val = rawByte + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          val = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`未知 PNG 过滤器 ${filter}`)
      }
      cur[i] = val & 0xff
    }
  }

  return { width, height, channels, data: out }
}

/** Terrarium 解码：h = R*256 + G + B/256 - 32768 */
function terrariumAt(img, px, py) {
  const i = (py * img.width + px) * img.channels
  return img.data[i] * 256 + img.data[i + 1] + img.data[i + 2] / 256 - 32768
}

// ---------------------------------------------------------------- 主流程

async function fetchTile(z, x, y) {
  await mkdir(CACHE_DIR, { recursive: true })
  const file = join(CACHE_DIR, `${z}-${x}-${y}.png`)
  try {
    await access(file)
  } catch {
    const res = await fetch(TERRARIUM_URL(z, x, y))
    if (!res.ok) throw new Error(`瓦片 ${z}/${x}/${y} 下载失败 HTTP ${res.status}`)
    await writeFile(file, Buffer.from(await res.arrayBuffer()))
    await sleep(250) // 对公共瓦片服务客气一点
  }
  return decodePng(await readFile(file))
}

async function main() {
  console.log(`场景范围  ${(HALF_M * 2) / 1000} km 见方`)
  console.log(`网格      ${GRID} x ${GRID}`)
  console.log(`中心      ${CENTER.lat} N, ${CENTER.lon} E`)
  console.log(`瓦片层级  z=${TILE_Z}`)

  // 范围（米 → 经纬度）
  const west = CENTER.lon + -HALF_M / (111320 * Math.cos((CENTER.lat * Math.PI) / 180))
  const east = CENTER.lon + HALF_M / (111320 * Math.cos((CENTER.lat * Math.PI) / 180))
  const north = CENTER.lat + HALF_M / M_PER_DEG_LAT
  const south = CENTER.lat - HALF_M / M_PER_DEG_LAT

  const x0 = Math.floor(deg2tileX(west, TILE_Z))
  const x1 = Math.floor(deg2tileX(east, TILE_Z))
  const y0 = Math.floor(deg2tileY(north, TILE_Z))
  const y1 = Math.floor(deg2tileY(south, TILE_Z))
  console.log(`瓦片范围  x ${x0}..${x1}  y ${y0}..${y1}  共 ${(x1 - x0 + 1) * (y1 - y0 + 1)} 张`)

  // 取瓦片
  const tiles = new Map()
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      tiles.set(`${tx},${ty}`, await fetchTile(TILE_Z, tx, ty))
    }
  }
  console.log(`瓦片已就绪  ${tiles.size} 张`)

  /** 经纬度 → 真实海拔（双线性）。越界返回 null */
  function elevationAt(lat, lon) {
    const fx = deg2tileX(lon, TILE_Z)
    const fy = deg2tileY(lat, TILE_Z)
    const tx = Math.floor(fx)
    const ty = Math.floor(fy)
    const px = (fx - tx) * 256
    const py = (fy - ty) * 256

    const ix = Math.floor(px)
    const iy = Math.floor(py)
    const dx = px - ix
    const dy = py - iy

    const sample = (ax, ay) => {
      const img = tiles.get(`${ax},${ay}`)
      if (!img) return null
      const lx = Math.min(255, Math.max(0, ax === tx ? ix : 0))
      const ly = Math.min(255, Math.max(0, ay === ty ? iy : 0))
      return terrariumAt(img, lx, ly)
    }

    const h00 = sample(tx, ty)
    if (h00 === null) return null
    const h10 = sample(tx + 1, ty) ?? h00
    const h01 = sample(tx, ty + 1) ?? h00
    const h11 = sample(tx + 1, ty + 1) ?? h00

    return (h00 * (1 - dx) + h10 * dx) * (1 - dy) + (h01 * (1 - dx) + h11 * dx) * dy
  }

  // 采样成网格。v 向南为正，行号 j 增大即向南
  const count = GRID * GRID
  const elev = new Float64Array(count)
  let min = Infinity
  let max = -Infinity
  let missing = 0

  for (let j = 0; j < GRID; j++) {
    const v = GRID === 1 ? 0.5 : j / (GRID - 1)
    const z = (v - 0.5) * (HALF_M * 2)
    const lat = CENTER.lat - z / M_PER_DEG_LAT
    for (let i = 0; i < GRID; i++) {
      const u = GRID === 1 ? 0.5 : i / (GRID - 1)
      const x = (u - 0.5) * (HALF_M * 2)
      const lon = CENTER.lon + x / (111320 * Math.cos((CENTER.lat * Math.PI) / 180))
      const h = elevationAt(lat, lon)
      if (h === null) {
        missing++
        elev[j * GRID + i] = 0
      } else {
        elev[j * GRID + i] = h
        if (h < min) min = h
        if (h > max) max = h
      }
    }
  }

  if (missing > 0) console.warn(`警告：${missing} 个格子缺数据，已填 0`)
  console.log(`海拔范围  ${min.toFixed(0)} m .. ${max.toFixed(0)} m   高差 ${(max - min).toFixed(0)} m`)

  // 直方图：用来看水位该定在哪
  const BINS = 40
  const hist = new Array(BINS).fill(0)
  for (let k = 0; k < count; k++) {
    const b = Math.min(BINS - 1, Math.floor(((elev[k] - min) / (max - min || 1)) * BINS))
    hist[b]++
  }
  console.log('\n海拔直方图（每行一个分箱，用于定水位）')
  const binH = (max - min) / BINS
  let cum = 0
  for (let b = 0; b < BINS; b++) {
    const lo = min + b * binH
    const pct = (hist[b] / count) * 100
    cum += pct
    if (hist[b] > 0) {
      const bar = '#'.repeat(Math.max(1, Math.round(pct * 1.6)))
      console.log(
        `  ${lo.toFixed(0).padStart(4)} m  ${pct.toFixed(2).padStart(5)}%  累计 ${cum
          .toFixed(1)
          .padStart(5)}%  ${bar}`,
      )
    }
  }

  // 归一化
  const span = max - min || 1
  let norm = new Float32Array(count)
  for (let k = 0; k < count; k++) norm[k] = (elev[k] - min) / span

  /**
   * 轻度平滑：压掉 DEM 的量化阶梯造成的虚假陡坡。
   *
   * 为什么必须做：高程是 1/256 米量化的，双线性插值后相邻格点会出现微小的高频波纹。
   * 格距越小，这个波纹被当成坡度的比例越大——实测同一地形在 128² 网格上平均坡度
   * 只有 8.6°，到 512² 却涨到 44.7°，涨的全是噪声，不是真实地形。
   * 不处理的话，画面会随"地形精度"下拉框剧烈变化，用户会以为地形坏了。
   *
   * 用 3x3 二项核迭代 SMOOTH_PASSES 次（近似高斯）。2 次足以压掉 1 像素级噪声，
   * 又不会吃掉真实的山脊与冲沟（那些是 5 像素以上的特征）。
   */
  const SMOOTH_PASSES = argOf('smooth', 2)
  if (SMOOTH_PASSES > 0) {
    const tmp = new Float32Array(count)
    for (let p = 0; p < SMOOTH_PASSES; p++) {
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          let acc = 0
          let wsum = 0
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj
            if (jj < 0 || jj >= GRID) continue
            const wj = dj === 0 ? 2 : 1
            for (let di = -1; di <= 1; di++) {
              const ii = i + di
              if (ii < 0 || ii >= GRID) continue
              const wi = di === 0 ? 2 : 1
              const w = wi * wj
              acc += norm[jj * GRID + ii] * w
              wsum += w
            }
          }
          tmp[j * GRID + i] = acc / wsum
        }
      }
      norm.set(tmp)
    }
    console.log(`平滑      ${SMOOTH_PASSES} 遍 3x3 二项核（压掉量化阶梯造成的虚假陡坡）`)
  }

  // 水位候选：低海拔处占比判断
  const bottom10 = min + span * 0.1
  let lowCount = 0
  for (let k = 0; k < count; k++) if (elev[k] <= bottom10) lowCount++
  console.log(`\n最低 10% 海拔带（≤ ${bottom10.toFixed(0)} m）占 ${((lowCount / count) * 100).toFixed(1)}% 的格子`)

  await mkdir(OUT_DIR, { recursive: true })
  const binPath = join(OUT_DIR, 'shuimo-dem.bin')
  const jsonPath = join(OUT_DIR, 'shuimo-dem.json')
  await writeFile(binPath, Buffer.from(norm.buffer))

  const meta = {
    id: 'shuimo-core',
    generatedAt: new Date().toISOString(),
    source: 'AWS Terrain Tiles (Terrarium), 公开数据集',
    licenseNote: '使用前请自行核对数据集的再分发条款',
    tileZoom: TILE_Z,
    grid: { cols: GRID, rows: GRID, layout: 'row-major' },
    /** 世界尺寸（米）。1 世界单位 = 1 米 */
    sizeMeters: HALF_M * 2,
    /** 中心点经纬度 */
    origin: { lat: CENTER.lat, lon: CENTER.lon },
    /** 场景四至 */
    bounds: { north, south, west, east },
    /** 真实海拔。前端 heightScale 应设成 (max-min)，归一化值乘它即得真实米数 */
    elevation: { min: Math.round(min), max: Math.round(max), span: Math.round(max - min), unit: 'm' },
    /** 归一化水位候选（后续按实测水系再校准） */
    waterLevelCandidates: {
      min10pct: Number(((bottom10 - min) / span).toFixed(4)),
      min5pct: Number(((min + span * 0.05 - min) / span).toFixed(4)),
    },
    files: { height: '/terrain/shuimo-dem.bin' },
    /** 九地标经度按真实 WGS84，由需求方提供；此处仅登记以便校验落点 */
    landmarks: [
      { name: '黄龙道观', lon: 103.41721, lat: 30.92835 },
      { name: '春风阁', lon: 103.420068, lat: 30.929212 },
      { name: '禅寿老街·万年台', lon: 103.420881, lat: 30.930634 },
      { name: '字库塔', lon: 103.420613, lat: 30.93074 },
      { name: '羌碉、西羌汇', lon: 103.419371, lat: 30.929548 },
      { name: '致远廊桥', lon: 103.42143, lat: 30.93016 },
      { name: '寿溪湖环湖步道', lon: 103.420251, lat: 30.928652 },
      { name: '仁吉喜目谷', lon: 103.436958, lat: 30.942703 },
      { name: '和谐广场', lon: 103.422298, lat: 30.933248 },
    ],
  }
  await writeFile(jsonPath, `${JSON.stringify(meta, null, 2)}\n`)

  console.log(`\n已写出`)
  console.log(`  ${binPath}  (${(norm.byteLength / 1024 / 1024).toFixed(2)} MB)`)
  console.log(`  ${jsonPath}`)
}

main().catch((err) => {
  console.error('构建失败:', err)
  process.exitCode = 1
})
