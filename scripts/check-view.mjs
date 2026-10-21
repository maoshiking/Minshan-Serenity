/**
 * 视图与模块自检（不需要打包器、不需要浏览器）。
 *
 *   cd "Minshan Serenity" && node scripts/check-view.mjs
 *
 * 做两件事：
 *   1) 用 @vue/compiler-sfc 编译 src 下每个 .vue 的 script 与 template
 *   2) 让 Node 真实解析 src/three 下每个模块的导入图（语法 + 路径 + 依赖可解析）
 *
 * 存在的理由：三维画面是否正确只能靠眼睛，但"代码是不是合法的"不该靠眼睛。
 * 打包器在部分受限环境下会因 spawn EPERM 跑不起来，这个脚本不依赖它。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let ok = 0

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// ---------- 1. 编译所有单文件组件 ----------
const vueFiles = walk(path.join(root, 'src')).filter((f) => f.endsWith('.vue'))
for (const filename of vueFiles) {
  const relative = path.relative(root, filename)
  const source = fs.readFileSync(filename, 'utf8')
  const { descriptor, errors } = parse(source, { filename })

  if (errors.length) {
    failures.push(`${relative} 解析失败：${errors[0].message}`)
    continue
  }

  try {
    if (descriptor.script || descriptor.scriptSetup) {
      compileScript(descriptor, { id: relative })
    }
    if (descriptor.template) {
      const result = compileTemplate({
        source: descriptor.template.content,
        filename,
        id: relative,
      })
      if (result.errors.length) {
        const first = result.errors[0]
        throw new Error(typeof first === 'string' ? first : first.message)
      }
    }
    ok++
  } catch (err) {
    failures.push(`${relative} 编译失败：${err.message}`)
  }
}

// ---------- 2. 解析三维模块导入图 ----------
const threeDir = path.join(root, 'src', 'three')
const moduleFiles = fs.readdirSync(threeDir).filter((f) => f.endsWith('.js'))
for (const name of moduleFiles) {
  try {
    await import(pathToFileURL(path.join(threeDir, name)).href)
    ok++
  } catch (err) {
    failures.push(`three/${name} 导入失败：${err.message}`)
  }
}

// ---------- 汇总 ----------
const total = ok + failures.length
console.log(`\n视图与模块自检：${ok}/${total} 通过（.vue ${vueFiles.length} 个，三维模块 ${moduleFiles.length} 个）`)
if (failures.length) {
  console.log('\n未通过：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓\n')
