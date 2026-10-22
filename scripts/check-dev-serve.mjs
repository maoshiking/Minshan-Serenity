/**
 * dev server 冒烟自检：确认用 npm run dev 打开时，页面与真实 DEM 资源都能正常加载。
 *
 * 为什么要单独做：生产构建通过 **不代表** 页面能跑起来。
 * 本项目就出过这类问题——cartoonTerrain 里的 DEM 分支早就接好了，
 * 但页面没把 demField 传进去，于是 `npm run dev` 打开的一直是海岛沙盘。
 * 构建是绿的，功能是死的。只有真起一个 server 去取那些资源才能发现。
 *
 * 用法：node scripts/check-dev-serve.mjs
 */

import { createServer } from 'vite'

const PORT = 5211

const server = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { port: PORT, strictPort: true },
})

let fail = 0
const ok = (label, cond, detail = '') => {
  if (cond) {
    console.log('  OK   ' + label + (detail ? '  ' + detail : ''))
  } else {
    fail++
    console.log('  FAIL ' + label + (detail ? '  ' + detail : ''))
  }
}

try {
  await server.listen()
  const base = server.resolvedUrls.local[0]
  console.log('dev server: ' + base)
  console.log('')

  console.log('【入口】')
  const html = await (await fetch(base)).text()
  ok('index.html 有挂载点', html.includes('id="app"'))
  ok('index.html 引入入口脚本', html.includes('/src/main.js'))

  console.log('')
  console.log('【模块转换】语法与导入错误会在这里暴露')
  const targets = [
    '/src/main.js',
    '/src/App.vue',
    '/src/router/index.js',
    '/src/views/TerrainMapView.vue',
    '/src/composables/useThreeStage.js',
    '/src/three/demField.js',
    '/src/three/cartoonTerrain.js',
    '/src/three/settlement.js',
    '/src/three/demWater.js',
    '/src/three/landmarks.js',
    '/src/three/osmBuildings.js',
    '/src/three/terrainMesh.js',
    '/src/three/heightField.js',
  ]
  for (const t of targets) {
    try {
      const r = await server.transformRequest(t, { ssr: false })
      if (!r) throw new Error('transform 返回空（模块未找到？）')
      ok(t, true, r.code.length + ' 字节')
    } catch (e) {
      ok(t, false, '-> ' + e.message)
    }
  }

  console.log('')
  console.log('【DEM 静态资源】页面靠这三个文件才能出真实地形')
  const assets = [
    ['/terrain/shuimo-dem.json', '高程元数据'],
    ['/terrain/shuimo-dem.bin', '高程高度场'],
    ['/terrain/shuimo-osm-buildings.json', 'OSM 真实建筑轮廓'],
  ]
  for (const [path, label] of assets) {
    try {
      const res = await fetch(new URL(path, base))
      const len = res.headers.get('content-length')
      ok(path + '（' + label + '）', res.ok, 'HTTP ' + res.status + (len ? '  ' + len + ' 字节' : ''))
    } catch (e) {
      ok(path, false, '-> ' + e.message)
    }
  }

  console.log('')
  console.log('【地形视图的关键接线】')
  // 这一条直指本项目踩过的坑：视图必须真的把 DEM 传给 terrain 世界
  const viewSrc = await (await fetch(new URL('/src/views/TerrainMapView.vue', base))).text()
  ok('视图导入了 DEM 装载器', viewSrc.includes('loadDemData') || viewSrc.includes('demField'))
  ok('视图调用了 setDemField', viewSrc.includes('setDemField'))
  /**
   * 反向断言：视图的**界面文案**里不该再有"程序化沙盘"这个选项。
   *
   * 判据要盯 UI 元素而不是裸字符串——源码里保留一句"这里曾经有个程序化开关、
   * 已移除"的说明性注释是有价值的，不该被这条断言误伤。
   * 所以查的是 el-radio-button 的 label，不是任意出现。
   */
  ok('界面不再提供程序化地形选项', !/el-radio-button[^>]*程序化/.test(viewSrc))
  ok('顶部说明不再标注程序化', !viewSrc.includes('程序化沙盘（非真实地形）'))

  console.log('')
  console.log(fail === 0 ? 'RESULT: 全部通过 ✓' : 'RESULT: ' + fail + ' 项失败 ✗')
} finally {
  await server.close()
}

if (fail > 0) process.exitCode = 1
