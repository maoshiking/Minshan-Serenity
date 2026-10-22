import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createHeightFieldFromData, DEFAULT_TERRAIN_OPTIONS } from './heightField.js'
import { buildTerrainGeometry, createToonGradientMap } from './terrainMesh.js'
import { raycastField } from './picking.js'
import { buildRoutePoints, buildRouteRibbon, createDashTexture } from './route.js'
import { createForest, createRocks, createSkyDome } from './scenery.js'
import { createRiverbedWater } from './demWater.js'
import { createLandmarkMarkers, resolveLandmarks } from './landmarks.js'
import { createSettlement } from './settlement.js'
import { createOsmBuildings } from './osmBuildings.js'

/**
 * 卡通地形地图的编排层：把高度场、几何、装饰、交互、标记和路线拧成一个可直接驱动的东西。
 *
 * 设计取舍：
 * - 拾取不走 Raycaster 打网格，而是 raycastField 在高度场上解析求解（见 picking.js）
 * - 标记编号用 HTML 浮层而非 3D 文字：文字始终清晰、还能直接用 CSS 做交互态
 * - 共享资源（卡通渐变、虚线贴图、标记几何）在实例内创建一次，随实例统一销毁
 */

const UP = new THREE.Vector3(0, 1, 0)
const ACCENT = '#c2703d'

/**
 * 画面观感参数集中在这里。
 *
 * 抽出来的实际原因：离线预览渲染器（scripts/preview/soft-render.mjs）要用同一份数值，
 * 否则"预览图"与"真实场景"会变成两份各自漂移的抄本，预览就失去意义了。
 */
/**
 * 场景外观常量。
 *
 * 早先这里还有一套"程序化海岛沙盘"的取值（size 120、heightScale 24、俯角 25°…），
 * 以及一堆 `demField ? A : B` 的分支。海岛原型已经移除，现在只有真实 DEM 一条路，
 * 所以分支全部收敛成单一取值——**同一个参数只留一个出处**。
 */
export const SCENE_LOOK = {
  /** 主光：方向 = keyDirection 归一化。仰角压在约 38°：太阳更高时阴影长度超不过地形高差，
   *  画面上几乎看不到投影，地形会显得很平。压低之后山脊的投影才拉得出来。 */
  keyColor: '#fff3e0',
  keyIntensity: 2.1,
  keyDirection: [0.58, 0.62, 0.53],
  hemisphereSky: '#cfe6f2',
  hemisphereGround: '#8a9a72',
  hemisphereIntensity: 1.35,
  fogColor: '#e8eff3',
  /** 雾按真实米数给：2500 m 起、9000 m 最浓 */
  fogNear: 2500,
  fogFar: 9000,
  fov: 46,
  /** 默认相机方向（会被归一化）。俯角约 26° */
  cameraOffset: [0.62, 0.48, 0.86],
  /** 包围盒占画面的目标比例 */
  frameFill: 0.93,
  /** 取景目标的高度系数：抬高让地形居中，否则画面下缘被底座吃满 */
  targetHeightFactor: 0.46,
  accent: ACCENT,
}

/**
 * 底座厚度比例。
 *
 * 底座是"托盘的厚度"，以**真实高差**为基数，不随纵向放大走。
 * 0.1 × 355 ≈ 36 m：足够像一块可以拿在手里的地形，又不会与地形争视觉重量。
 */
export const SKIRT_FACTOR = 0.1

/** 底座厚度（世界单位）。几何与取景共用同一个值，否则近角会被裁掉 */
export function skirtDepthOf(options) {
  return (options?.elevationSpan ?? options?.heightScale ?? 1) * SKIRT_FACTOR
}


/**
 * DEM 模式的默认相机方向。
 *
 * 沙盘的 cameraOffset 是 [0.62, 0.47, 0.86]，俯角约 25°。这对 120 单位见方、
 * 高度 24 的沙盘合适（纵向 1:5，够看不夸张）。
 * 但真实场景是 1600 m 见方、高差 355 m，同样的俯角会让地形在画面里摊成薄饼。
 * 压到约 20° 后，河谷的切割与山脊的层次才出得来。
 * 注意不能压得太低：俯角太低时视线接近地平线，画面下缘会露出大片底座，
 * 反而把地形压没了。
 */
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v
}

export function frameTerrainCamera(
  camera,
  {
    size,
    heightScale,
    aspect = 1,
    fill = SCENE_LOOK.frameFill,
    offset = SCENE_LOOK.cameraOffset,
    /** 取景目标的高度系数。抬高让地形在画面里居中，否则下缘会被底座吃满 */
    targetHeightFactor = SCENE_LOOK.targetHeightFactor,
    /** 底座厚度（世界单位）。必须与 buildTerrainGeometry 用的一致 */
    skirtDepth = heightScale * SKIRT_FACTOR,
  },
) {
  const target = new THREE.Vector3(0, heightScale * targetHeightFactor, 0)
  const direction = new THREE.Vector3(...offset).normalize()
  const probe = new THREE.Vector3()

  // 沙盘包围盒的八个角。必须把底座那一截算进去，否则近角会被裁掉
  const half = size / 2
  const corners = []
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      for (const y of [-skirtDepth, heightScale]) corners.push(new THREE.Vector3(x, y, z))
    }
  }

  camera.fov = SCENE_LOOK.fov
  camera.aspect = aspect
  camera.updateProjectionMatrix()

  /*
   * 按宽高比反求相机距离，使包围盒刚好落在 fill 比例内。
   *
   * 必须跟宽高比走：固定距离在窄窗口会把地图切掉，在宽窗口又把地图缩成一小块。
   * 用迭代而非解析式，是因为透视下"最大 NDC"与距离并非严格成反比——近处的角会被放大，
   * 简单按 1/距离 缩放会系统性偏小。
   */
  let distance = size * 1.5
  for (let iteration = 0; iteration < 6; iteration++) {
    camera.position.copy(target).addScaledVector(direction, distance)
    camera.lookAt(target)
    camera.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()

    let maxAbs = 0
    for (const corner of corners) {
      probe.copy(corner).project(camera)
      maxAbs = Math.max(maxAbs, Math.abs(probe.x), Math.abs(probe.y))
    }
    if (maxAbs < 1e-6) break
    distance *= maxAbs / fill
  }

  camera.position.copy(target).addScaledVector(direction, distance)
  camera.lookAt(target)
  camera.updateMatrixWorld(true)
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
  return distance
}

export function createTerrainWorld({
  scene,
  camera,
  renderer,
  labelLayer,
  /**
   * terrain 参数。可选带 demField（真实 DEM 高度场 { data, meta, resolution, sizeMeters }）：
   * 传了就走真实地形，不传就走程序化噪声。两条路的 field 产物接口完全一致，
   * 所以下面所有逻辑（网格、装饰、路线、拾取）都不需要分支。
   */
  options = {},
  onMarkersChange,
  onStats,
}) {
  // ---------- 共享资源 ----------
  const toonGradient = createToonGradientMap()
  const dashTexture = createDashTexture()

  const root = new THREE.Group()
  scene.add(root)

  let currentOptions = { ...DEFAULT_TERRAIN_OPTIONS, ...options }

  /**
   * DEM 的尺度参数必须**在这里**就合并进来。
   *
   * 踩过的坑：`size` 早先读的是 `DEFAULT_TERRAIN_OPTIONS.size`（120，海岛沙盘的边长），
   * 而 DEM 的 `sizeMeters`（1600）只在后面建高度场时才合并进 options——**太晚了**。
   * 后果是相机远平面按 120 算出 960 m，而地形有 1600 m 宽，
   * 于是地形被远裁剪面切掉：画面里只剩一片天空。
   *
   * 天空穹顶半径、雾、相机近远平面、取景包围盒全都依赖 size，
   * 所以它必须是最先确定的那一个值。
   */
  if (options.demField?.sizeMeters) {
    currentOptions.size = options.demField.sizeMeters
  }
  if (options.demField?.resolution) {
    currentOptions.resolution = options.demField.resolution
  }
  /**
   * 场景尺寸与高差。
   *
   * 用 `let` 而不是 `const`：DEM 是异步装载的，到达时尺寸会从默认的 120
   * 变成真实米制（1600）。**闭包捕获的是变量本身，所以更新这两个值之后，
   * 天空半径、光照位置、阴影相机、拾取距离、默认取景会一起跟上。**
   *
   * 早先写成 const，于是 applySceneScale 里只改了 currentOptions，
   * 闭包里的 size 仍是 120 —— "重置视角"按 120 取景，而地形是 1600 宽，
   * 角点 NDC 直接跑到 15.6。
   */
  let size = currentOptions.size
  let heightScale = currentOptions.heightScale

  // ---------- 天空 / 雾 / 光照 ----------
  const sky = createSkyDome({ radius: Math.max(size * 5, 400) })
  root.add(sky)

  const fogColor = new THREE.Color(SCENE_LOOK.fogColor)
  /**
   * 雾。
   *
   * 旧公式 `size × 1.5 / 4.2` 是给 120 单位沙盘调的——那边相机默认距离约 1.75×size，
   * 近角无雾、远角只压两成，观感刚好。
   *
   * 但 DEM 场景是 1600 单位，同一公式算出 2400 / 6720：
   * 相机稍微退远一点就被雾整片洗白，实测截图里那一片白就是这么来的。
   *
   * DEM 模式改用**真实米数**：2500 m 起雾、9000 m 最浓。
   * 主场景（最近 120 m、常用 600–1500 m）完全不受影响，远景仍有空气感。
   */
  scene.fog = new THREE.Fog(fogColor, SCENE_LOOK.fogNear, SCENE_LOOK.fogFar)

  const hemisphere = new THREE.HemisphereLight(
    SCENE_LOOK.hemisphereSky,
    SCENE_LOOK.hemisphereGround,
    SCENE_LOOK.hemisphereIntensity,
  )
  root.add(hemisphere)

  const key = new THREE.DirectionalLight(SCENE_LOOK.keyColor, SCENE_LOOK.keyIntensity)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0005
  key.shadow.normalBias = 0.1
  key.position.set(
    size * SCENE_LOOK.keyDirection[0],
    size * SCENE_LOOK.keyDirection[1],
    size * SCENE_LOOK.keyDirection[2],
  )
  root.add(key)
  root.add(key.target)

  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  function updateShadowCamera() {
    const extent = size * 0.8
    const cam = key.shadow.camera
    cam.left = -extent
    cam.right = extent
    cam.top = extent
    cam.bottom = -extent
    cam.near = 1
    cam.far = size * 3
    cam.updateProjectionMatrix()
  }
  updateShadowCamera()

  // ---------- 相机 / 控制器 ----------
  /**
   * 默认注视点。高度系数必须与 frameTerrainCamera 用的那个一致，
   * 否则"重置视角"会把镜头拉到一个与初始取景不同的高度上——画面会跳。
   */
  const defaultTarget = () =>
    new THREE.Vector3(0, currentOptions.heightScale * SCENE_LOOK.targetHeightFactor, 0)

  /**
   * 相机的近远平面由**世界自己**按场景尺度设定，不依赖调用方传对。
   *
   * 这不是防御性冗余：调用方通常在建世界之前先建一个默认 camera，
   * 而 three 的 PerspectiveCamera 默认 far 是 2000，其它模块给的可能是更小的值。
   * 一旦 far 小于场景对角尺寸，地形会被远裁剪面切掉，表现为"地形不见或只剩一角"。
   * 实测自检脚本里的 camera far=200 而场景 1600 m，投影出的角点 NDC 直接到 15.6。
   */
  camera.fov = SCENE_LOOK.fov
  camera.near = Math.max(0.5, size / 2000)
  camera.far = size * 8
  camera.updateProjectionMatrix()

  /**
   * 相机距离约束。
   *
   * 旧值是给 120 单位沙盘调的（min 0.35×size、max 4×size）。
   * DEM 场景是 1600 单位，换成同样的比例就是 560–6400：
   *   - 560 的下限意味着相机能贴到离注视点 560 m —— 而一棵树只有 15 m 高，
   *     于是镜头直接怼进树冠里，看到的全是放大的树（实测截图就是这个现象）。
   *   - 6400 的上限又太远，配上下面的雾会整片洗白。
   *
   * 约束该按**真实米数**给，而不是按 size 的比例：
   * 近到能看清街巷（约 120 m），远到能俯瞰整个 1600 m 场景（约 3000 m）。
   */
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  /**
   * 相机距离约束按**真实米数**给。
   *
   * 曾经按 size 的比例给（min 0.35×size = 560 m），那是海岛沙盘的尺度。
   * 在 1600 m 的场景里，560 m 的下限意味着镜头能贴到离注视点 560 m ——
   * 而一棵树只有 15 m 高，于是相机直接怼进树冠，看到的全是放大的树。
   * 现在：近到能看清街巷（120 m），远到能俯瞰整个场景（3000 m）。
   */
  controls.minDistance = 120
  controls.maxDistance = 3000
  controls.minPolarAngle = 0.08
  // 卡住俯仰下限：钻到地形底下看穿帮对谁都没好处
  controls.maxPolarAngle = 1.5
  // 平移与旋转速度按大尺度调慢，否则一次拖拽就飞出场景
  controls.panSpeed = 0.6
  controls.rotateSpeed = 0.7
  controls.zoomSpeed = 0.9

  /**
   * 应用默认取景。用当前宽高比现算，所以"重置视角"在任何窗口尺寸下都好看。
   */
  function applyDefaultView() {
    frameTerrainCamera(camera, {
      size,
      heightScale: currentOptions.heightScale,
      aspect: camera.aspect || 1,
      offset: SCENE_LOOK.cameraOffset,
      skirtDepth: skirtDepthOf(currentOptions),
      fill: SCENE_LOOK.frameFill,
      targetHeightFactor: SCENE_LOOK.targetHeightFactor,
    })
    controls.target.copy(defaultTarget())
    controls.update()
  }

  applyDefaultView()

  // ---------- 地形与装饰 ----------
  let field = null
  let terrainGroup = null
  let terrainMesh = null
  let water = null
  let forest = null
  let rocks = null
  /** 地标标记（DEM 模式专用）。landmarkList 是对外暴露的落位结果 */
  let landmarkMarkers = null
  let landmarkList = []
  /** 示意性聚落建筑体块（DEM 模式专用）。真实建筑轮廓数据不可得，故为示意 */
  let settlement = null
  /** 真实建筑轮廓（OSM）。与示意性聚落严格区分：批次可追溯到具体建筑名 */
  let osmBuildings = null

  function buildTerrain() {
    // 有 DEM 就用真实地形。注意 DEM 的归一化语义与程序化一致（都是 0..1），
    // 因此 heightScale / waterLevel 的既有含义不变，只是在 DEM 模式下
    // heightScale 被设成真实高差，于是世界单位直接等价于米。
    // demField 走 currentOptions 传递，这样 setDemField() 复用现成的 rebuild 通道，
    // 不需要额外的状态变量。
    /**
     * 高度场只来自 DEM 数据。
     *
     * 早先这里是 `demField ? createHeightFieldFromData(...) : createHeightField(...)`，
     * 后者是程序化噪声生成的海岛沙盘——原型遗留，已移除。
     *
     * **但"没有数据"时不能抛错。**
     * 世界是在 DOM 就绪时同步创建的，而 DEM 是异步取的（高度场有 1 MB，
     * 首屏不该等它）。曾经在这里直接 throw，结果页面在数据到达前就被打死了，
     * 报出来的还是一句让人以为是环境问题的错误。
     *
     * 正确做法：允许建一个**空的**世界（只有天空与光照，没有地形），
     * 数据到了再由 setDemField() 填进来。这不是"静默降级"——
     * 场景里根本没有假地形，用户看到的是明确的"正在加载"。
     * 真正要防的"静默降级"是"退回一张程序化地形还当成真的"，那是另一回事。
     */
    if (!currentOptions.demField?.data) {
      field = null
      return
    }
    field = createHeightFieldFromData(currentOptions.demField.data, {
      ...currentOptions,
      resolution: currentOptions.demField.resolution,
      size: currentOptions.demField.sizeMeters,
    })

    terrainGroup = new THREE.Group()
    root.add(terrainGroup)

    const skirtDepth = skirtDepthOf(currentOptions)
    /**
     * 逐面明暗抖动。
     *
     * 0.075 是给程序化低多边形沙盘调的手绘感来源，真实 DEM 不需要它：
     * 地形本身已有真实起伏，再叠一层逐面随机亮度只会变成噪声。
     * 实测在 256² 下，抖动让俯视图出现规则的鱼鳞纹，
     * 同一张图的 PNG 体积从 29 KB 涨到 116 KB——胀出来的全是伪信息。
     */
    const geometry = buildTerrainGeometry(field, { skirtDepth, jitter: 0.015 })
    const material = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: toonGradient,
      // 侧壁与底面的缠绕顺序不必逐一验算，双面渲染直接免疫这个问题
      side: THREE.DoubleSide,
      // 但阴影必须只从朝上的正面生成，否则双面会自遮挡出满屏条纹
      shadowSide: THREE.FrontSide,
    })
    terrainMesh = new THREE.Mesh(geometry, material)
    /**
     * 给地形网格起名字，供自检精确定位。
     *
     * 别用"顶点最多的带色非索引网格"这种启发式去找它：示意性聚落现在有近 1500 栋，
     * 顶点数已经超过地形本身，一挑就挑错对象。名字是唯一稳定的标识。
     */
    terrainMesh.name = 'terrain-surface'
    terrainMesh.castShadow = true
    terrainMesh.receiveShadow = true
    terrainGroup.add(terrainMesh)

    // 水系：只覆盖河床的水面，不是一整张平面。
    // 原因见 demWater.js 顶部注释——真实地形的陆地远高于水面，
    // 整张平面要么被地形盖住看不见，要么一抬高就淹掉古镇。
    water = createRiverbedWater(field, { gradientMap: toonGradient })
    terrainGroup.add(water.mesh)

    // 地标标记。地理位置来自 DEM 元数据里登记的点位。
    {
      landmarkList = resolveLandmarks(currentOptions.demField.meta, field)
      landmarkMarkers = createLandmarkMarkers(landmarkList, { gradientMap: toonGradient })
      terrainGroup.add(landmarkMarkers.group)

      // 聚落建筑体块。数据标注 synthetic——真实建筑轮廓数据不可得，界面上须提示"示意"
      settlement = createSettlement(field, landmarkList, { gradientMap: toonGradient })
      terrainGroup.add(settlement.group)

      /**
       * 真实建筑轮廓（OSM）。与上面那批示意性聚落严格区分：
       * 这一批逐栋可追溯到具体建筑名（商业街、体育馆、梅朵天堂大酒店…），
       * 但覆盖面很窄——OSM 在水磨古镇主街区基本为空，这里几乎全是
       * 阿坝师范学院校区。界面上不能把它当成"古镇测绘成果"。
       */
      const osmData = currentOptions.demField.osmBuildings
      if (osmData?.buildings?.length) {
        osmBuildings = createOsmBuildings(field, osmData, { gradientMap: toonGradient })
        terrainGroup.add(osmBuildings.group)
      }
    }

    /**
     * 树林。
     *
     * 默认参数（slots 64 / maxCount 900 / sizeScale = size/120）是给 120 单位沙盘调的。
     * 套到真实米制会两头失准：
     *   - sizeScale = 1600/120 ≈ 13.3，一棵基准高 2.5 单位的树变成约 33 m 高（真实应为 8–15 m）
     *   - 64 格意味着点位间距 25 m，上限 900 棵，对 1.6 km 的山地太稀
     * 所以 DEM 模式把尺寸系数压到 size/260（整棵约 15 m），点位加密到 160 格、
     * 上限提到 5200 棵——按 1.6 km 计约 10 m 间距，接近真实林地的观感。
     *
     * `exclusions` 是关键：聚落与树林各自独立生成，谁也不知道对方在哪，
     * 结果是树长在屋顶上、房子被树埋住，近景一看就露馅。把建筑位置作为禁区传进来。
     */
    const treeExclusions = []
    if (settlement?.layout) {
      for (const b of settlement.layout) {
        // 半径取建筑半宽再放宽一点，避免树紧贴墙面
        treeExclusions.push({ x: b.x, z: b.z, radius: Math.max(b.w, b.d) * 0.5 + 2.5 })
      }
    }
    forest = createForest(field, {
      gradientMap: toonGradient,
      exclusions: treeExclusions,
      /** 尺寸系数：基准树高 2.5 世界单位 × 1600/260 ≈ 15 m，与真实山地乔木相符 */
      sizeScale: field.size / 260,
      slots: 160,
      maxCount: 5200,
      /**
       * 密度刻意压低，**必须让名额用不完**。
       *
       * 若把 density 提到 0.62，名额会在扫描途中就用满 maxCount，
       * 于是被禁区排除掉的坑位**不会被别处的树补上**——禁区等于失效。
       * 实测：density 0.62 时加不加禁区都是 5200 棵，一棵都没少。
       */
      density: 0.34,
    })
    terrainGroup.add(forest.group)

    rocks = createRocks(field, { gradientMap: toonGradient })
    terrainGroup.add(rocks.group)
  }

  /** 只销毁几何与材质；贴图是共享的，由实例统一销毁，避免重复释放 */
  function disposeSubtree(object) {
    const geometries = new Set()
    const materials = new Set()
    object.traverse((node) => {
      if (node.geometry) geometries.add(node.geometry)
      if (node.material) {
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) materials.add(m)
      }
    })
    for (const g of geometries) g.dispose()
    for (const m of materials) m.dispose()
  }

  function disposeTerrain() {
    if (!terrainGroup) return
    water?.dispose()
    landmarkMarkers?.dispose()
    landmarkMarkers = null
    landmarkList = []
    settlement?.dispose()
    settlement = null
    forest?.dispose()
    rocks?.dispose()
    disposeSubtree(terrainGroup)
    root.remove(terrainGroup)
    terrainGroup = null
    terrainMesh = null
    water = null
    forest = null
    rocks = null
  }

  // ---------- 标记点资源 ----------
  const markerGeometry = {
    ring: new THREE.RingGeometry(1.15, 1.52, 28).rotateX(-Math.PI / 2),
    tip: new THREE.ConeGeometry(0.52, 1.3, 12).rotateX(Math.PI).translate(0, 0.8, 0),
    head: new THREE.SphereGeometry(0.6, 14, 10).translate(0, 1.7, 0),
  }
  const markerMaterial = {
    ring: new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    body: new THREE.MeshToonMaterial({ color: ACCENT, gradientMap: toonGradient }),
  }

  const markers = []
  let markerIdSeq = 0
  const MAX_MARKERS = 16

  // ---------- 悬停指示器 ----------
  const hoverGroup = new THREE.Group()
  const hoverDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1.6, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  const hoverRing = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1.2, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  hoverGroup.add(hoverDisc, hoverRing)
  hoverGroup.visible = false
  root.add(hoverGroup)

  // ---------- 路线 ----------
  let routeMesh = null
  let routeLength = 0
  let routeEnabled = true

  function disposeRoute() {
    if (!routeMesh) return
    root.remove(routeMesh)
    routeMesh.geometry.dispose()
    routeMesh.material.dispose()
    routeMesh = null
    routeLength = 0
  }

  function rebuildRoute() {
    disposeRoute()
    // field 为 null 表示 DEM 还没到（世界已建但只有天空），此时无地表可贴
    if (!routeEnabled || !field || markers.length < 2) {
      emit()
      return
    }

    const points = buildRoutePoints(markers.map((m) => ({ x: m.x, z: m.z })))
    const built = buildRouteRibbon(field, points, { width: 1.9, lift: 0.5 })
    if (!built) {
      emit()
      return
    }

    routeLength = built.length
    // 虚线按弧长铺：不管路线多长，箭头在世界空间里都是同样间距
    dashTexture.repeat.set(Math.max(1, Math.round(built.length / 5)), 1)

    const material = new THREE.MeshBasicMaterial({
      map: dashTexture,
      color: ACCENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    })

    routeMesh = new THREE.Mesh(built.geometry, material)
    routeMesh.renderOrder = 5
    root.add(routeMesh)
    emit()
  }

  // ---------- 标记点 ----------
  function createLabelElement(marker) {
    const el = document.createElement('div')
    el.className = 'terrain-marker'
    const badge = document.createElement('span')
    badge.className = 'terrain-marker__badge'
    el.appendChild(badge)

    const tip = document.createElement('span')
    tip.className = 'terrain-marker__tip'
    el.appendChild(tip)

    el.addEventListener('pointerenter', () => el.classList.add('is-hover'))
    el.addEventListener('pointerleave', () => el.classList.remove('is-hover'))
    // 点标签 = 飞过去看。标签自己有 pointer-events，所以不会顺手在地图上多打一个标记
    el.addEventListener('click', () => flyTo(marker))
    labelLayer?.appendChild(el)
    marker.el = el
    marker.badge = badge
    marker.tip = tip
  }

  function refreshLabels() {
    markers.forEach((marker, index) => {
      if (marker.badge) marker.badge.textContent = String(index + 1)
      if (marker.tip) {
        marker.tip.textContent = `X ${marker.x.toFixed(1)} · Z ${marker.z.toFixed(1)} · 点击定位`
      }
    })
  }

  function snapshot() {
    return markers.map((m, index) => ({
      id: m.id,
      index: index + 1,
      x: m.x,
      z: m.z,
      y: m.y,
    }))
  }

  function emit() {
    onMarkersChange?.(snapshot())
    onStats?.(getStats())
  }

  function addMarker(x, z) {
    if (markers.length >= MAX_MARKERS) return null
    // 没有地表就没法贴地，直接拒绝落点（调用方会看到返回 null）
    if (!field) return null

    const y = field.worldHeight(x, z)
    const group = new THREE.Group()
    group.position.set(x, y, z)

    const ring = new THREE.Mesh(markerGeometry.ring, markerMaterial.ring)
    const pin = new THREE.Group()
    pin.add(new THREE.Mesh(markerGeometry.tip, markerMaterial.body))
    pin.add(new THREE.Mesh(markerGeometry.head, markerMaterial.body))
    group.add(ring, pin)
    root.add(group)

    const marker = {
      id: ++markerIdSeq,
      x,
      z,
      y,
      group,
      ring,
      pin,
      // 落点动画从这个时刻开始计时
      createdAt: elapsedTime,
    }
    createLabelElement(marker)
    markers.push(marker)
    refreshLabels()
    rebuildRoute()
    return marker
  }

  function removeMarker(id) {
    const index = markers.findIndex((m) => m.id === id)
    if (index === -1) return false
    const [marker] = markers.splice(index, 1)
    root.remove(marker.group)
    marker.el?.remove()
    refreshLabels()
    rebuildRoute()
    return true
  }

  function clearMarkers() {
    for (const marker of markers) {
      root.remove(marker.group)
      marker.el?.remove()
    }
    markers.length = 0
    refreshLabels()
    rebuildRoute()
  }

  /** 换地形后把已有标记重新贴回地面，而不是粗暴清空 */
  function resnapMarkers() {
    if (!field) return
    for (const marker of markers) {
      marker.y = field.worldHeight(marker.x, marker.z)
      marker.group.position.y = marker.y
    }
    rebuildRoute()
  }

  // ---------- 交互 ----------
  const dom = renderer.domElement
  const raycaster = new THREE.Raycaster()
  let pointerNdc = null
  let pointerInside = false
  let pointerDownAt = null
  let placeEnabled = true
  let cursor = ''

  function toNdc(event) {
    const rect = dom.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    }
  }

  function pick(ndc) {
    // 没有地表就拾取不到任何东西（DEM 未到时不会有悬停指示或落点）
    if (!field) return null
    raycaster.setFromCamera(ndc, camera)
    return raycastField(field, raycaster.ray, { maxDistance: size * 4 })
  }

  function onPointerMove(event) {
    pointerInside = true
    pointerNdc = toNdc(event)
  }

  function onPointerLeave() {
    pointerInside = false
    pointerNdc = null
    hoverGroup.visible = false
  }

  function onPointerDown(event) {
    if (event.button !== 0) return
    pointerDownAt = { x: event.clientX, y: event.clientY }
  }

  function onPointerUp(event) {
    if (event.button !== 0 || !pointerDownAt) return
    const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y)
    pointerDownAt = null
    // 拖动是在转视角，不是点击落点
    if (moved > 5 || !placeEnabled) return
    const hit = pick(toNdc(event))
    if (!hit) return
    addMarker(hit.point.x, hit.point.z)
  }

  dom.addEventListener('pointermove', onPointerMove)
  dom.addEventListener('pointerleave', onPointerLeave)
  dom.addEventListener('pointerdown', onPointerDown)
  dom.addEventListener('pointerup', onPointerUp)

  // ---------- 相机飞行 ----------
  let fly = null

  function flyTo(point) {
    const toTarget = new THREE.Vector3(point.x, point.y, point.z)
    const offset = new THREE.Vector3(0.5, 0.72, 0.85).normalize().multiplyScalar(size * 0.5)
    fly = {
      t: 0,
      fromTarget: controls.target.clone(),
      toTarget,
      fromCam: camera.position.clone(),
      toCam: toTarget.clone().add(offset),
    }
  }

  function resetView() {
    fly = null
    applyDefaultView()
  }

  function updateFly(delta) {
    if (!fly) return
    fly.t = Math.min(1, fly.t + delta / 0.7)
    const e = 1 - Math.pow(1 - fly.t, 3)
    controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e)
    camera.position.lerpVectors(fly.fromCam, fly.toCam, e)
    if (fly.t >= 1) fly = null
  }

  // ---------- HTML 标签跟随 ----------
  const projected = new THREE.Vector3()

  function updateLabels() {
    if (!labelLayer) return
    const width = dom.clientWidth || 1
    const height = dom.clientHeight || 1

    // 投影用的是上一帧的矩阵，这里先手动补齐，否则标签会滞后一帧地"飘"
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()

    for (const marker of markers) {
      if (!marker.el) continue
      projected.set(marker.x, marker.y + 2.9, marker.z).project(camera)
      const visible = projected.z < 1
      if (!visible) {
        if (marker.el.style.display !== 'none') marker.el.style.display = 'none'
        continue
      }
      if (marker.el.style.display === 'none') marker.el.style.display = ''
      const px = (projected.x * 0.5 + 0.5) * width
      const py = (-projected.y * 0.5 + 0.5) * height
      marker.el.style.transform = `translate(-50%, -100%) translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`
    }
  }

  // ---------- 主循环 ----------
  let elapsedTime = 0

  function update(delta, elapsed) {
    elapsedTime = elapsed

    updateFly(delta)

    // 平移范围收在地图附近，别把地形推出画面找不回来。
    // 必须在 controls.update() 之前钳制：update() 会用 target 反算相机位置，
    // 放在后面会让相机比 target 慢一帧，快速平移时看得出抖。
    const limit = size * 0.45
    controls.target.x = clamp(controls.target.x, -limit, limit)
    controls.target.z = clamp(controls.target.z, -limit, limit)
    controls.target.y = clamp(controls.target.y, -currentOptions.heightScale * 0.5, currentOptions.heightScale * 1.5)
    controls.update()

    water?.update(delta, elapsed)

    // 虚线流动：offset.x 递减 → 图案朝 +u 方向走，也就是从起点流向终点
    if (routeMesh) dashTexture.offset.x -= delta * 0.35

    for (const marker of markers) {
      const t = Math.min(1, (elapsed - marker.createdAt) / 0.55)
      // easeOutBack：落地时轻微过冲，砸下去的那一下才有分量
      const c1 = 1.70158
      const c3 = c1 + 1
      const eased = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
      marker.pin.position.y = (1 - clamp(eased, 0, 1.08)) * 7
      marker.pin.scale.setScalar(0.45 + 0.55 * clamp(eased, 0, 1))
      marker.ring.scale.setScalar(1 + Math.sin(elapsed * 2.2 + marker.id) * 0.07)
    }

    updateHover(delta)
    updateLabels()
  }

  let hoverPhase = 0
  function updateHover(delta) {
    if (!pointerInside || !pointerNdc) {
      hoverGroup.visible = false
      if (cursor !== 'default') {
        dom.style.cursor = 'default'
        cursor = 'default'
      }
      return
    }

    const hit = pick(pointerNdc)
    if (!hit) {
      hoverGroup.visible = false
      if (cursor !== 'default') {
        dom.style.cursor = 'default'
        cursor = 'default'
      }
      return
    }

    hoverPhase += delta
    hoverGroup.visible = true
    hoverGroup.position.copy(hit.point).addScaledVector(hit.normal, 0.12)
    // 让指示器贴着坡面躺下，而不是水平插进山里
    hoverGroup.quaternion.setFromUnitVectors(UP, hit.normal)
    const pulse = 1 + Math.sin(hoverPhase * 3) * 0.06
    hoverDisc.scale.setScalar(pulse)
    hoverRing.scale.setScalar(pulse)

    const next = placeEnabled ? 'crosshair' : 'default'
    if (cursor !== next) {
      dom.style.cursor = next
      cursor = next
    }
  }

  // ---------- 对外 API ----------
  function getStats() {
    return {
      seed: currentOptions.seed,
      resolution: currentOptions.resolution,
      markerCount: markers.length,
      routeLength,
      trees: forest?.count ?? 0,
      rocks: rocks?.count ?? 0,
      triangles: terrainMesh ? terrainMesh.geometry.attributes.position.count / 3 : 0,
    }
  }

  /**
   * 只重建地形本身，不动相机。
   * 调精度走这条路——否则用户每换一次精度，视角就被重置一次。
   */
  function rebuildTerrain(next = {}) {
    currentOptions = { ...currentOptions, ...next }
    disposeTerrain()
    buildTerrain()
    resnapMarkers()
    emit()
  }

  /**
   * 场景尺度变了：相机近远平面、天空穹顶、雾、控制器约束全部按新尺寸重算。
   *
   * DEM 是异步装载的，到达时尺寸会从默认 120 变成 1600（真实米制），
   * 这是**正常流程的一部分**，不是异常。不重算的话地形会被远裁剪面切掉
   * （相机 far 停留在按 120 算出的 960 m，而地形有 1600 m 宽）。
   */
  function applySceneScale() {
    // 先把闭包里的尺度同步过来，下面所有依赖 size / heightScale 的计算才正确
    size = currentOptions.size
    heightScale = currentOptions.heightScale

    camera.near = Math.max(0.5, size / 2000)
    camera.far = size * 8
    camera.updateProjectionMatrix()

    // 天空穹顶半径按新尺寸重建
    const oldSkyGeometry = sky.geometry
    sky.geometry = createSkyDome({ radius: Math.max(size * 5, 400) }).geometry
    oldSkyGeometry.dispose()

    // 主光位置按尺寸摆放；阴影相机范围也要跟着放大，否则阴影只覆盖场景一角
    key.position.set(
      size * SCENE_LOOK.keyDirection[0],
      size * SCENE_LOOK.keyDirection[1],
      size * SCENE_LOOK.keyDirection[2],
    )
    if (key.shadow) {
      const cam = key.shadow.camera
      const extent = size * 0.8
      cam.left = -extent
      cam.right = extent
      cam.top = extent
      cam.bottom = -extent
      cam.far = Math.max(cam.far, size * 3)
      cam.updateProjectionMatrix()
    }

    scene.fog.near = SCENE_LOOK.fogNear
    scene.fog.far = SCENE_LOOK.fogFar

    controls.minDistance = 120
    controls.maxDistance = 3000

    frameTerrainCamera(camera, {
      size,
      heightScale,
      aspect: camera.aspect || 1,
      offset: SCENE_LOOK.cameraOffset,
      skirtDepth: skirtDepthOf(currentOptions),
      fill: SCENE_LOOK.frameFill,
      targetHeightFactor: SCENE_LOOK.targetHeightFactor,
    })
    controls.target.copy(defaultTarget())
    controls.update()
  }

  /**
   * 换地形（整块换掉，含尺度）。
   *
   * 尺寸从哪来：**优先取 demField.sizeMeters**。
   * 不能指望调用方把 size 一起传进来——`setDemField(dem)` 是最自然的调用方式，
   * 而尺寸本来就写在 DEM 元数据里。早先这里只看 `currentOptions.size`，
   * 于是 setDemField 之后尺寸还是默认的 120，相机远平面停在 960 m，
   * 1600 m 宽的地形被整片裁掉（回归自检里角点 NDC 直接到 40.7）。
   */
  function rebuild(next = {}) {
    const prevSize = currentOptions.size
    const nextOptions = { ...currentOptions, ...next }
    // 尺寸的唯一权威是 DEM 元数据；显式传入的 size 也能覆盖
    if (nextOptions.demField?.sizeMeters) nextOptions.size = nextOptions.demField.sizeMeters
    if (nextOptions.demField?.resolution) nextOptions.resolution = nextOptions.demField.resolution
    currentOptions = nextOptions

    disposeTerrain()
    buildTerrain()
    resnapMarkers()
    if (currentOptions.size !== prevSize) applySceneScale()
    emit()
  }

  function setPlaceEnabled(value) {
    placeEnabled = Boolean(value)
  }

  function setRouteEnabled(value) {
    routeEnabled = Boolean(value)
    rebuildRoute()
  }

  function setLightIntensity(value) {
    key.intensity = value
  }

  function setShadowEnabled(value) {
    renderer.shadowMap.enabled = Boolean(value)
    // 开关阴影会改变着色器分支，必须让所有材质重编译，否则画面不会变
    root.traverse((node) => {
      if (node.material) {
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) m.needsUpdate = true
      }
    })
  }

  function dispose() {
    dom.removeEventListener('pointermove', onPointerMove)
    dom.removeEventListener('pointerleave', onPointerLeave)
    dom.removeEventListener('pointerdown', onPointerDown)
    dom.removeEventListener('pointerup', onPointerUp)

    for (const marker of markers) marker.el?.remove()
    markers.length = 0

    disposeRoute()
    disposeTerrain()
    controls.dispose()

    disposeSubtree(root)
    scene.remove(root)
    scene.fog = null

    // 共享贴图最后统一释放
    toonGradient.dispose()
    dashTexture.dispose()
  }

  buildTerrain()
  // 构造完先广播一次初始状态：否则面板要等到用户落第一个点才有数据，
  // 一打开页面会看到"种子 0 / 三角面 0 / 树木 0"
  emit()

  return {
    field: () => field,
    update,
    dispose,
    rebuild,
    addMarker,
    removeMarker,
    clearMarkers,
    focusMarker(id) {
      const marker = markers.find((m) => m.id === id)
      if (marker) flyTo({ x: marker.x, y: marker.y, z: marker.z })
    },
    resetView,
    /**
     * 注入 / 替换真实 DEM 高度场。
     *
     * 首屏不该等 1 MB 的高度场，而世界又必须在 DOM 就绪时同步创建，
     * 所以 DEM 是"后灌"的：世界先建空的（只有天空与光照），数据到了走这里。
     * 尺寸从 120 变成 1600 属于正常流程，rebuild 会顺带重算相机与雾。
     */
    setDemField(demField, next = {}) {
      rebuild({ demField, ...next })
    },
    /**
     * 只换精度、不动相机。
     *
     * 用户调精度时视角不该被重置；场景尺度没变，相机参数也就不必重算。
     * 早先调精度走 rebuild，等于每换一档就把镜头拉回默认——那是退步。
     */
    setResolution(resolution, next = {}) {
      rebuildTerrain({ resolution, ...next })
    },
    setPlaceEnabled,
    setRouteEnabled,
    setLightIntensity,
    setShadowEnabled,
    getStats,
    getMarkers: snapshot,
    /** 已落位的地标（含世界坐标与真实海拔）。DEM 模式下才非空 */
    getLandmarks: () => landmarkList,
    /** 聚落统计（栋数、三角面、是否示意） */
    getSettlement: () =>
      settlement
        ? { count: settlement.count, triangleCount: settlement.triangleCount, synthetic: settlement.synthetic }
        : null,
    get controls() {
      return controls
    },
    get maxMarkers() {
      return MAX_MARKERS
    },
  }
}
