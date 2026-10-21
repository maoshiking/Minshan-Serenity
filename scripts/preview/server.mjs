/**
 * 预览用静态文件服务（零依赖，只用 node:http）。
 *
 * 用途：给无头浏览器一个真实的 http:// 源。
 * 为什么不能用 file:// —— 浏览器的 ES module 加载受 CORS 约束，file:// 属于不透明源，
 * import map + 模块脚本会被直接拒绝；走 HTTP 就一切正常。
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export function startPreviewServer(port = 0) {
  const server = http.createServer((req, res) => {
    let urlPath
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      res.writeHead(400).end('bad request')
      return
    }

    const resolved = path.resolve(path.join(root, urlPath))
    // 目录穿越防护：只允许读项目根之内的文件
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden')
      return
    }

    let filePath = resolved
    try {
      if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html')
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not found: ${urlPath}`)
      return
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`not found: ${urlPath}`)
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(data)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}
