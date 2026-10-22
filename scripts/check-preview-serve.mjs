/**
 * 生产构建冒烟：起一次 vite preview，确认构建产物能真正被服务出来。
 *
 * 与 check-dev-serve.mjs 的分工：
 *   · check-dev-serve  —— 开发服务器 + 模块转换（抓语法/导入错误）
 *   · 本脚本         —— 生产产物（抓"构建能过但页面跑不起来"这一类）
 *
 * 用法：node scripts/check-preview-serve.mjs
 */

import { preview } from 'vite'

const PORT = 5215
const server = await preview({ preview: { port: PORT, strictPort: true } })
const base = server.resolvedUrls.local[0]

let fail = 0
const ok = (label, cond, detail = '') => {
  if (cond) console.log('  OK   ' + label + (detail ? '  ' + detail : ''))
  else {
    fail++
    console.log('  FAIL ' + label + (detail ? '  ' + detail : ''))
  }
}

try {
  console.log('生产预览: ' + base)
  console.log('')

  const res = await fetch(base)
  const html = await res.text()
  ok('首页可访问', res.ok, 'HTTP ' + res.status)
  ok('含挂载点', html.includes('id="app"'))
  ok('含入口脚本', /src="[^"]+\.js"/.test(html))

  const entry = html.match(/src="([^"]+\.js)"/)
  if (entry) {
    const r = await fetch(new URL(entry[1], base))
    const len = r.headers.get('content-length')
    ok('入口 JS 可取到', r.ok, 'HTTP ' + r.status + (len ? '  ' + len + ' 字节' : ''))
  }

  // 地形数据是运行时 fetch 的，生产环境必须也能取到
  for (const path of ['/terrain/shuimo-dem.json', '/terrain/shuimo-dem.bin', '/terrain/shuimo-osm-buildings.json']) {
    const r = await fetch(new URL(path, base))
    const len = r.headers.get('content-length')
    ok(path, r.ok, 'HTTP ' + r.status + (len ? '  ' + len + ' 字节' : ''))
  }

  console.log('')
  console.log(fail === 0 ? 'RESULT: 全部通过 ✓' : 'RESULT: ' + fail + ' 项失败 ✗')
} finally {
  await server.close()
}

if (fail > 0) process.exitCode = 1
