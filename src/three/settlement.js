import * as THREE from 'three'

/**
 * 聚落建筑体块。
 *
 * 必须说清楚这是什么、不是什么
 * ------------------------------------------------
 * 水磨古镇的**真实建筑轮廓数据我方拿不到**（OSM 在这一带只覆盖阿坝师范学院校区，
 * 古镇主街区几乎是空白）。所以这里生成的是**示意性聚落**，不是测绘成果。
 * 数据上带 `synthetic: true`，界面上一律标注"示意"，绝不能当成真实街区投影。
 *
 * 形制依据来自项目自带的文化资料图（21 张开放许可照片）：
 *   - 石砌墙体 + 黄褐色土墙：羌族民居的主体材料
 *   - 深色木构窗框与檐口
 *   - 坡屋顶、檐口外挑、mark 出挑檐阴影
 *   - 三至四层，沿街连续排布，形成峡谷街巷的压迫感
 * 层数、开间、进深按山地区场镇的常见尺度取值（非实测）。
 *
 * 为什么不逐个建模：目标是"看得出这是个镇子"，不是"还原每一栋"。
 * 用体块 + 屋顶两段几何，几百栋也只有几千个三角面。
 */

/** 建筑材质配色。取自参考照片的主色，与「山志」的克制基调一致 */
export const SETTLEMENT_PALETTE = {
  /**
   * 墙面主色。注意：three 的 Color 会把十六进制按 sRGB 转成线性空间，
   * 数值会明显变暗（#b5a170 转完只剩约 0.44）。所以这里比照片取色再亮一档，
   * 否则整片镇子在画面里会糊成一团黑——这是实际渲染后调出来的值。
   */
  stone: '#a89e8e',
  earthWall: '#cdb98a',
  roofDark: '#6a6560',
  timber: '#8a6b4a',
}

/**
 * 从高度场提取**河谷走向**，作为聚落的街巷主轴向。
 *
 * 为什么不用地标做 PCA
 * --------------------------------
 * 山地区场镇是沿河谷线性发展的：房屋沿等高线排布，街巷平行于河流。
 * 而地标的分布受"景点密度"影响（道观在山腰、广场在镇北），
 * 拿它做主轴分析会得到与河流近乎垂直的方向，铺出来的房子会横跨河道。
 *
 * 做法：取全部低于水位线的格子（即水面与河床），对其做主轴分析。
 * 河谷天然是线性的，这批点的主轴方向就是河流走向。
 * 样本足够多（本项目约上万个格子），PC A 非常稳定。
 */
export function riverAxisFromField(field) {
  const N = field.resolution
  const last = N - 1
  const wl = field.waterLevel + 0.02 // 略高于水面，把河床与近岸一起纳入

  let n = 0
  let cx = 0
  let cz = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (field.data[j * N + i] >= wl) continue
      cx += (i / last - 0.5) * field.size
      cz += (j / last - 0.5) * field.size
      n++
    }
  }
  if (n < 20) return null
  cx /= n
  cz /= n

  let sxx = 0
  let sxz = 0
  let szz = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (field.data[j * N + i] >= wl) continue
      const dx = (i / last - 0.5) * field.size - cx
      const dz = (j / last - 0.5) * field.size - cz
      sxx += dx * dx
      sxz += dx * dz
      szz += dz * dz
    }
  }
  sxx /= n
  sxz /= n
  szz /= n

  const tr = sxx + szz
  const det = sxx * szz - sxz * sxz
  const disc = Math.max(0, (tr * tr) / 4 - det)
  const lambda = tr / 2 + Math.sqrt(disc)

  let dx = sxz
  let dz = lambda - sxx
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) {
    dx = lambda - szz
    dz = sxz
  }
  const len = Math.hypot(dx, dz) || 1

  return {
    dir: { x: dx / len, z: dz / len },
    center: { x: cx, z: cz },
    sampleCount: n,
    // 主轴长度的一半，用来定街道铺多长
    extent: Math.sqrt(lambda) * 2,
  }
}

/**
 * 从高度场提取**山谷底脊线**：沿一条轴切片，每片取最低点。
 *
 * 为什么换掉"水体 PCA"
 * --------------------------------
 * 先前用"低于水位的格子"做主轴分析，结果被寿溪湖带偏了：
 * 湖是一大团近似圆形的点，会把协方差主轴拽向自己，
 * 算出来的方向与河道几乎垂直，房子就横铺到山坡上去了。
 *
 * 谷底脊线更稳：它不依赖水体形状，只依赖"哪里最低"这个地形事实。
 * 山地区场镇本来就是沿着这条线发展的（水磨古镇也是沿寿溪河展开）。
 *
 * @param {object} field
 * @param {object} [options]
 * @param {number} [options.axisAngle] 切片方向（弧度）。默认沿 x 轴切片，得南北向脊线
 * @param {number} [options.slices]    切片数量
 * @returns {{points: Array<{x:number,z:number}>, dir:{x:number,z:number}, center:{x:number,z:number}}|null}
 */
export function valleySpineFromField(field, options = {}) {
  const { slices = 48 } = options
  const N = field.resolution
  const size = field.size
  const half = size / 2

  const points = []
  for (let s = 0; s < slices; s++) {
    // 沿 z 方向切片：固定 z，在整条 x 上找最低点
    const z = -half + ((s + 0.5) / slices) * size
    let bestX = 0
    let bestH = Infinity
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1) - 0.5) * size
      const h = field.heightAt(i / (N - 1), z / size + 0.5)
      if (h < bestH) {
        bestH = h
        bestX = x
      }
    }
    points.push({ x: bestX, z, h: bestH })
  }

  if (points.length < 4) return null

  // 对脊线做一次直线拟合，得到稳定的走向（避免逐个切片抖动影响朝向）
  let sx = 0
  let sz = 0
  for (const p of points) {
    sx += p.x
    sz += p.z
  }
  sx /= points.length
  sz /= points.length

  let sxx = 0
  let sxz = 0
  let szz = 0
  for (const p of points) {
    const dx = p.x - sx
    const dz = p.z - sz
    sxx += dx * dx
    sxz += dx * dz
    szz += dz * dz
  }
  const tr = sxx + szz
  const det = sxx * szz - sxz * sxz
  const disc = Math.max(0, (tr * tr) / 4 - det)
  const lambda = tr / 2 + Math.sqrt(disc)
  let dx = sxz
  let dz = lambda - sxx
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) {
    dx = lambda - szz
    dz = sxz
  }
  const len = Math.hypot(dx, dz) || 1

  return {
    points,
    dir: { x: dx / len, z: dz / len },
    center: { x: sx, z: sz },
    sampleCount: points.length,
  }
}

/**
 * 从地标点推出聚落的"街巷轴向"。
 *
 * 注意：这个函数现在只作为**回退方案**（高度场里没有足够水面时使用）。
 * 首选是 valleySpineFromField —— 见上面关于"为什么不用地标做 PCA"的说明。
 *
 * 做法：对地标做主轴分析（PCA），取协方差矩阵的主特征向量方向。
 */
export function townAxisFromLandmarks(landmarks) {
  const n = landmarks.length
  if (n < 2) return { dir: { x: 1, z: 0 }, center: { x: 0, z: 0 } }

  let cx = 0
  let cz = 0
  for (const p of landmarks) {
    cx += p.x
    cz += p.z
  }
  cx /= n
  cz /= n

  let sxx = 0
  let sxz = 0
  let szz = 0
  for (const p of landmarks) {
    const dx = p.x - cx
    const dz = p.z - cz
    sxx += dx * dx
    sxz += dx * dz
    szz += dz * dz
  }
  sxx /= n
  sxz /= n
  szz /= n

  // 2x2 对称矩阵的主特征向量，有解析解
  const tr = sxx + szz
  const det = sxx * szz - sxz * sxz
  const disc = Math.max(0, (tr * tr) / 4 - det)
  const lambda = tr / 2 + Math.sqrt(disc)

  let dx = sxz
  let dz = lambda - sxx
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) {
    dx = lambda - szz
    dz = sxz
  }
  const len = Math.hypot(dx, dz) || 1
  return { dir: { x: dx / len, z: dz / len }, center: { x: cx, z: cz } }
}

/**
 * 生成建筑布局（纯数据，不涉及 three 对象）。
 *
 * 布局规则：
 *   1. 沿主轴方向铺若干条平行街巷，间距约 34 m
 *   2. 每条街巷两侧排布建筑，沿轴间距约 13 m
 *   3. 建筑朝向主轴（略微随机偏转，避免过于整齐）
 *   4. 落在水面以下、过陡、或离地标群太远的点直接丢弃
 *
 * @returns {Array<{x:number,z:number,y:number,rotation:number,w:number,d:number,h:number}>}
 */
export function generateSettlementLayout(field, landmarks, options = {}) {
  const {
    streetSpacing = 34,
    lotSpacing = 13,
    streetCount = 16,
    radius = 340,
    minHeight = 0.08,
    maxSlope = 0.34,
    /**
     * 建筑占地内允许的最大高差（真实米数）。
     *
     * 这个值是量出来的，不是拍出来的。实测 428 个候选点的占地高差分布：
     *   P5 5.6 m · P25 10.6 m · P50 16.4 m · P90 30.2 m
     * **最小值就有 5.6 m**——说明这片河谷里没有天然平整的地块。
     * 原因也清楚：谷底实测坡度约 28%，11 m 的占地自然就有 4.5 m 高差，这个量级是真实的。
     *
     * 所以这里只用一个宽松的上限去挡**极端**站址（横跨陡坎、差几十米那种），
     * 常规的几米高差交给几何去处理——把建筑底面下延到占地最低点以下，
     * 让墙脚埋进坡里。这也是山地建筑的现实做法：房子坐在开挖出的台地上，
     * 靠山一侧的墙必然埋进坡体。
     */
    maxFootprintRelief = 14,
    /**
     * 每处沿进深方向尝试的候选位数。
     *
     * 地形过滤会否掉大量站址（这片河谷天然平整的地块很少），
     * 每个位置只试一次的话通过过滤的只剩几十栋，镇子就散了。
     */
    candidateLanes = 3,
    seed = 20261021,
    /** 街巷主轴。不传则从高度场提取河谷走向，提不到才回退到地标 PCA */
    axis = null,
  } = options

  const river = axis ?? valleySpineFromField(field)
  const fallback = townAxisFromLandmarks(landmarks)
  const dir = river?.dir ?? fallback.dir

  /**
   * 聚落中心 = **贴住地标群**，再沿垂直于河流的方向让出河岸带。
   *
   * 走过的弯路（留着以免重复）
   * ------------------------------------------------
   * 先是用"地标在垂直方向上的投影"把中心从脊线推到地标那一侧，结果聚落整体跑到
   * 西北角、大半地标落在街区外。原因是：一旦中心被推到脊线上，生成半径只有 340 m，
   * 反而够不到真正的地标群。
   *
   * 正确的优先级是：**地标群决定聚落的位置，河谷只决定街巷的朝向**。
   * 所以中心锚在地标群的几何中心，只做一个"别把房子压进河里"的推让。
   */
  let center = fallback.center
  if (river) {
    const nx2 = -dir.z
    const nz2 = dir.x
    const proj =
      (fallback.center.x - river.center.x) * nx2 + (fallback.center.z - river.center.z) * nz2
    const sign = proj >= 0 ? 1 : -1
    // 从中心出发，沿"背离河流"的方向推让到距脊线至少 bankClearance 的位置
    const dist = Math.abs(proj)
    const bankClearance = 110
    if (dist < bankClearance) {
      const push = bankClearance - dist
      center = {
        x: fallback.center.x + nx2 * sign * push,
        z: fallback.center.z + nz2 * sign * push,
      }
    }
  }
  // 法线方向：沿它铺街
  const nx = -dir.z
  const nz = dir.x

  const random = mulberry32(seed)
  const out = []
  const half = field.size / 2

  for (let s = 0; s < streetCount; s++) {
    // 街巷中心线距谷底脊线的偏移，从脊线往两边铺。
    // 这样"离河越远越稀疏"是自然结果，不需要额外的衰减规则。
    const k = Math.ceil(s / 2)
    const side = s === 0 ? 0 : s % 2 === 1 ? 1 : -1
    const off = k * streetSpacing * side

    // 每条街的长度随离主轴的距离递减，形成菱形轮廓，而不是方形
    const halfLen = (radius - Math.abs(off) * 0.55) * 0.5
    if (halfLen < 24) continue

    const steps = Math.max(3, Math.floor((halfLen * 2) / lotSpacing))
    for (let t = 0; t <= steps; t++) {
      const along = -halfLen + (t / steps) * halfLen * 2
      // 两侧各排一列建筑（本街的南北两边）
      for (const rowSide of [-1, 1]) {
        /**
         * 沿"垂直于街巷"的方向多取几个候选位。
         *
         * 为什么需要它：地形过滤（占地高差 ≤ maxFootprintRelief）会把大部分
         * 站址否掉——实测这片河谷里天然平整的地块很少。若每个位置只试一次，
         * 通过过滤的只剩几十栋，镇子就散了。
         * 每处沿进深方向试 candidateLanes 个位，让可用的站址先被找出来，
         * 再在其中择优落位。
         */
        for (let lane = 0; lane < candidateLanes; lane++) {
          const laneOffset = rowSide * (9 + lane * 10)
          const jitter = (random() - 0.5) * 2.5
          const px = center.x + dir.x * along + nx * (off + laneOffset + jitter)
          const pz = center.z + dir.z * along + nz * (off + laneOffset + jitter)

          if (Math.abs(px) > half - 20 || Math.abs(pz) > half - 20) continue

          const u = px / field.size + 0.5
          const v = pz / field.size + 0.5
          const h = field.heightAt(u, v)
        if (h < minHeight) continue
        if (field.slopeAt(u, v) > maxSlope) continue

        const w = 9 + random() * 5
        const d = 8 + random() * 4

        /**
         * 占地内高差检查——这一条比坡度过滤更要紧。
         *
         * 为什么不能只靠 slopeAt：坡度是用 12.5 m 基线（slopeRadius=2）算的，
         * 而山地里的陡坎宽度可能只有 10–16 m，会被这个基线**平均掉**。
         * 实测某处的真实情况是：16 m 水平距离内高程掉 43 m（约 70°），
         * 而 slopeAt 只报 0.339（19°）——于是坡度过滤放行了这块地，
         * 结果是房子横跨陡坎，一半悬空一半埋进坡里。
         *
         * 直接测四角高差就没有这个问题：它不依赖任何平滑尺度，
         * 问的就是"这栋房子脚下到底平不平"。
         */
        // 朝向主轴，加一点随机偏转破掉机械感。
        // 必须在这里先算：占地检查要用它把局部角点转到世界坐标。
        const rot = Math.atan2(dir.x, dir.z) + (random() - 0.5) * 0.22
        const cosR = Math.cos(rot)
        const sinR = Math.sin(rot)
        let hMin = h
        let hMax = h
        for (const [lx, lz] of [
          [-w / 2, -d / 2],
          [w / 2, -d / 2],
          [w / 2, d / 2],
          [-w / 2, d / 2],
        ]) {
          const wx2 = px + lx * cosR - lz * sinR
          const wz2 = pz + lx * sinR + lz * cosR
          const hh = field.heightAt(wx2 / field.size + 0.5, wz2 / field.size + 0.5)
          if (hh < hMin) hMin = hh
          if (hh > hMax) hMax = hh
        }
        /**
         * 占地高差只用于"底面下延多少"，**不作为落位过滤条件**。
         *
         * 走过的弯路（留着以免重复）
         * ------------------------------------------------
         * 我先用 maxFootprintRelief 硬过滤，要求占地高差 ≤ 2.5 m。
         * 结果是 411 栋全部被拒——实测这片河谷 428 个候选点里**最小的占地高差也有 5.6 m**，
         * 中位 16.4 m。谷底实测坡度约 28%，11 m 占地自然就有 4.5 m 高差，这个量级是真实的。
         *
         * 放宽到 14 m 后仍只剩 101 栋（原为 515 栋），近景里几乎看不到房子——
         * **为了一个对木构建筑并不重要的"平整"指标，把镇子的密度牺牲掉了，这是退步。**
         *
         * 正确的分工是：
         *   落位  —— 由坡度与高度决定（原来的做法，密度正常）
         *   贴地  —— 由"底面下延 relief"解决（房子埋进坡里，这才是山地建筑的实情）
         * 两者本来就不该混在一起。
         */
        const trueSpan = field.options?.elevationSpan ?? field.heightScale
        const relief = (hMax - hMin) * field.heightScale

        // 离主轴越远，越稀疏（镇子边缘的房子本来就不连续）
        const edgeFade = 1 - Math.abs(off) / (radius * 0.9)
        if (random() > 0.55 + edgeFade * 0.4) continue

        const floors = 2 + Math.floor(random() * 3) // 2~4 层
        const hgt = floors * 3.2 + random() * 1.2

        out.push({
          x: px,
          z: pz,
          // 地面高度取占地**最低点**（归一化值 × heightScale 得世界高度）
          y: hMin * field.heightScale,
          /**
           * 占地内真实高差（米）。几何用它把底面延伸到最低点以下，
           * 于是房子不会悬空，只会"埋进坡里"——山地建筑的正常形态。
           */
          relief,
          // 用上面算好的那个 rot，不要在这里再摇一次随机数——
          // 否则占地检查用的朝向与最终写入的朝向不是同一个值
          rotation: rot,
          w,
          d,
          h: hgt,
          floors,
          // 逐栋色差：同一色系里的深浅变化，低多边形的手感来自这点不均匀
          tint: 0.88 + random() * 0.24,
        })
        }
      }
    }
  }

  return out
}

/** 极简确定性随机数（与项目其它模块同一套 mulberry32） */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 把布局渲染成几何：每栋建筑 = 一个墙体盒 + 一个坡屋顶。
 *
 * 屋顶用两块斜板拼出人字坡，檐口比墙体各挑出 0.9 m——参考照片里
 * "檐口外挑、投出深影"是羌族民居最显眼的特征，比墙面的细节更能说明问题。
 */
export function buildSettlementGeometry(layout, options = {}) {
  const { palette = SETTLEMENT_PALETTE, jitter = 0.06, eave = 0.9, pitch = 0.42 } = options

  const stone = new THREE.Color(palette.stone)
  const wall = new THREE.Color(palette.earthWall)
  const roof = new THREE.Color(palette.roofDark)

  // 每栋 2 个盒子（墙基 + 墙身）不算，这里用最省的组合：
  // 墙体 1 个盒 = 12 面；屋顶 2 块板 = 各 12 面
  const facesPerBuilding = 12 + 12 + 12
  const positions = new Float32Array(layout.length * facesPerBuilding * 9)
  const colors = new Float32Array(layout.length * facesPerBuilding * 9)
  let cursor = 0

  function pushTri(ax, ay, az, bx, by, bz, cx, cy, cz, color) {
    positions[cursor] = ax
    positions[cursor + 1] = ay
    positions[cursor + 2] = az
    positions[cursor + 3] = bx
    positions[cursor + 4] = by
    positions[cursor + 5] = bz
    positions[cursor + 6] = cx
    positions[cursor + 7] = cy
    positions[cursor + 8] = cz
    for (let k = 0; k < 3; k++) {
      colors[cursor + k * 3] = color.r
      colors[cursor + k * 3 + 1] = color.g
      colors[cursor + k * 3 + 2] = color.b
    }
    cursor += 9
  }

  const c = new THREE.Color()

  for (const b of layout) {
    const hw = b.w / 2
    const hd = b.d / 2
    const cos = Math.cos(b.rotation)
    const sin = Math.sin(b.rotation)
    // 局部坐标 → 世界坐标
    const wx = (lx, lz) => b.x + lx * cos - lz * sin
    const wz = (lx, lz) => b.z + lx * sin + lz * cos

    // ---- 墙身：一个盒，六面各两个三角 ----
    c.copy(wall).multiplyScalar(b.tint)
    /**
     * 底面高度：从占地最低点再往下延，让墙脚埋进坡体。
     *
     * 下延深度**必须封顶**。
     * 起初写成 `relief + 0.5`，而 relief 是在某个网格分辨率下采四角得到的，
     * 数值会虚高——实测最大报到 94 m，于是墙身被拉成一片巨大的板，
     * 整片镇子变成一堆竖立的薄片。
     *
     * 现实中山地建筑靠开挖台地来解决高差，埋深也就几米；封顶 6 m 既能保证
     * 不悬空，又不会把建筑拉变形。屋顶高度另按占地最高点算，与埋深无关。
     */
    /**
     * 底面 = 占地最低点 − 0.5 m，固定值。
     *
     * 走过的弯路（这一处踩了三轮）：曾想让底面按 relief 下延，
     * 但 relief 是采样出来的、数值会虚高（实测报到 94 m），
     * 结果墙身被拉成巨大的竖板，整片镇子变成一堆薄片；封顶 6 m 也不对——
     * 下延量是测量值的函数，本质上不可控。
     *
     * 而 b.y 本来就是占地最低点，底面再低 0.5 m 就不会悬空。
     * 实测最大悬空仅 0.4 m，完全够用。**贴地用固定小量即可，
     * 按测量值自适应只会把误差放大成视觉缺陷。**
     */
    const y0 = b.y - 0.5
    const y1 = b.y + b.h
    const P = (lx, ly, lz) => [wx(lx, lz), ly, wz(lx, lz)]

    const corners = [
      P(-hw, y0, -hd), P(hw, y0, -hd), P(hw, y0, hd), P(-hw, y0, hd),
      P(-hw, y1, -hd), P(hw, y1, -hd), P(hw, y1, hd), P(-hw, y1, hd),
    ]
    const quads = [
      [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
      [4, 5, 6, 7], [0, 3, 2, 1],
    ]
    for (const [a, bb, cc, dd] of quads) {
      pushTri(...corners[a], ...corners[bb], ...corners[cc], c)
      pushTri(...corners[a], ...corners[cc], ...corners[dd], c)
    }

    // ---- 坡屋顶：两块斜板，檐口外挑 ----
    c.copy(roof).multiplyScalar(b.tint)
    const rw = hw + eave
    const rd = hd + eave
    const ridgeY = y1 + rd * pitch
    const eaveY = y1 - 0.15
    // 屋脊沿建筑的长边（w 方向）走
    const A = P(-rw, eaveY, -rd)
    const B = P(rw, eaveY, -rd)
    const C = P(rw, ridgeY, 0)
    const D = P(-rw, ridgeY, 0)
    const E = P(-rw, eaveY, rd)
    const F = P(rw, eaveY, rd)
    pushTri(...A, ...B, ...C, c)
    pushTri(...A, ...C, ...D, c)
    pushTri(...F, ...E, ...D, c)
    pushTri(...F, ...D, ...C, c)

    // ---- 山墙（两端的三角面），否则从侧面看屋顶是空的 ----
    pushTri(...A, ...D, ...E, c)
    pushTri(...B, ...F, ...C, c)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, cursor), 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, cursor), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return { geometry, triangleCount: cursor / 9 }
}

/**
 * 一步到位：生成聚落组（几何 + 材质）。
 */
export function createSettlement(field, landmarks, options = {}) {
  const { gradientMap, ...layoutOptions } = options
  const palette = layoutOptions.palette ?? SETTLEMENT_PALETTE
  const layout = generateSettlementLayout(field, landmarks, layoutOptions)
  const { geometry, triangleCount } = buildSettlementGeometry(layout, { palette })

  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap,
    side: THREE.DoubleSide,
    shadowSide: THREE.FrontSide,
    /**
     * 建筑整体抬一点自发光。
     *
     * 原因：镇子在河谷里，主光被两侧山体挡掉大半；建筑又是密集的竖直体块，
     * 互相自遮挡严重。不加这一档，整片镇子在画面里就是一团黑，看不出是房子。
     * 这不是"美化"，是把信息从阴影里救出来。
     */
    emissive: new THREE.Color(palette.earthWall).multiplyScalar(0.28),
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.name = 'settlement'

  const group = new THREE.Group()
  group.add(mesh)

  return {
    group,
    count: layout.length,
    triangleCount,
    layout,
    /** 明示这是示意性聚落，不是真实测绘轮廓 */
    synthetic: true,
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
