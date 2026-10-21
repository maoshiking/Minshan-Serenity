/**
 * 无头截图：把三维地形真正渲染成 PNG，供人（或模型）用眼睛检查。
 *
 *   cd "Minshan Serenity" && node scripts/preview/shoot.mjs
 *
 * 为什么不需要 puppeteer / playwright：
 *   Node 22+ 自带全局 WebSocket 与 fetch，而 Chrome DevTools Protocol 就是「HTTP 发现端点
 *   + 一条 WebSocket」。所以只要能拿到浏览器可执行文件，用内置能力就能完成
 *   导航 / 求值 / 截图 / 收控制台报错这一整套。
 *
 * 为什么启动浏览器用 stdio: 'ignore'：
 *   受限沙箱下，带管道 stdio 的子进程会 EPERM；'ignore' 不建立管道，可以正常拉起。
 *
 * 产物：scripts/preview/shots/*.png，以及控制台报错（WebGL 着色器编译失败只会出现在那里）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startPreviewServer } from './server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const shotsDir = path.join(here, 'shots')
const profileDir = path.join(here, '.edge-profile')

const VIEWPORT = { width: 1200, height: 800 }
const DEBUG_PORT = 9333

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
].filter(Boolean)

const browserPath = EDGE_CANDIDATES.find((p) => fs.existsSync(p))
if (!browserPath) {
  console.error('找不到 Edge / Chrome 可执行文件，无法截图')
  process.exit(1)
}

// ---------- 极简 CDP 客户端 ----------
class CdpSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.consoleLines = []
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id != null) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
        else entry.resolve(message.result)
        return
      }
      this.handleEvent(message)
    })
  }

  handleEvent({ method, params }) {
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
      this.consoleLines.push(`[${params.type}] ${text}`)
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails
      this.consoleLines.push(`[exception] ${d.exception?.description ?? d.text}`)
    } else if (method === 'Log.entryAdded') {
      const e = params.entry
      if (e.level === 'error' || e.level === 'warning') this.consoleLines.push(`[log:${e.level}] ${e.text}`)
    }
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 求值并取回可序列化结果 */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }
}

function connect(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败'))
    })
  })
}

async function waitForPageTarget(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`等待浏览器调试目标超时${lastError ? `：${lastError.message}` : ''}`)
}

// ---------- 主流程 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let browser = null
let serverHandle = null
let session = null
let exitCode = 0

try {
  fs.mkdirSync(shotsDir, { recursive: true })

  const { server, port } = await startPreviewServer(0)
  serverHandle = server
  const pageUrl = `http://127.0.0.1:${port}/scripts/preview/page.html`
  console.log(`静态服务已就绪：${pageUrl}`)

  browser = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      // 无头环境没有 GPU，必须显式允许 SwiftShader 软件光栅化，否则 WebGL 直接不可用
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ],
    // 关键：不用管道 stdio，受限沙箱下才能拉起子进程
    { stdio: 'ignore' },
  )
  browser.on('error', (err) => console.error('浏览器进程错误：', err.message))
  console.log(`浏览器已启动（pid ${browser.pid}）：${path.basename(browserPath)}`)

  const target = await waitForPageTarget(DEBUG_PORT)
  session = new CdpSession(await connect(target.webSocketDebuggerUrl))

  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Log.enable')
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  })

  await session.send('Page.navigate', { url: pageUrl })

  // 等页面把世界构建完
  const deadline = Date.now() + 60000
  let ready = false
  while (Date.now() < deadline) {
    ready = await session.eval('!!(window.__preview && window.__preview.ready)').catch(() => false)
    if (ready) break
    await sleep(400)
  }
  if (!ready) throw new Error('页面未在 60 秒内完成初始化（可能是模块加载或 WebGL 失败）')

  const stats = await session.eval('window.__preview.stats')
  console.log('\n场景统计：', JSON.stringify(stats))

  const views = await session.eval('window.__preview.views')
  for (const view of views) {
    await session.eval(`window.__preview.setView(${JSON.stringify(view)})`)
    // 顺便取回渲染器统计：draw call 数能直接反映实例化有没有生效
    const info = await session.eval(`(() => {
      const r = window.__preview.renderer
      return {
        viewport: [window.innerWidth, window.innerHeight],
        calls: r.info.render.calls,
        triangles: r.info.render.triangles,
        programs: r.info.programs.length,
        geometries: r.info.memory.geometries,
        textures: r.info.memory.textures,
      }
    })()`)

    const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = path.join(shotsDir, `${view}.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(`  ✓ ${view}.png  draw calls=${info.calls}  triangles=${info.triangles}  程序=${info.programs}  视口=${info.viewport.join('×')}`)
  }

  const errors = session.consoleLines.filter((line) => /error|exception|warn/i.test(line))
  if (errors.length) {
    console.log('\n页面控制台报错/警告：')
    for (const line of errors) console.log('  ' + line)
  } else {
    console.log('\n页面控制台无报错、无警告')
  }
  console.log(`\n截图目录：${shotsDir}`)
} catch (err) {
  console.error('\n截图失败：', err.message)
  if (session?.consoleLines?.length) {
    console.error('页面控制台输出：')
    for (const line of session.consoleLines.slice(-25)) console.error('  ' + line)
  }
  exitCode = 1
} finally {
  try {
    await session?.send('Browser.close')
  } catch {
    /* 关不掉就走下面的强杀 */
  }
  browser?.kill()
  serverHandle?.close()
  await sleep(300)
}

process.exit(exitCode)
