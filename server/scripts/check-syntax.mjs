import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(serverRoot, '..')
const serverFiles = [
  'src/server.js', 'src/config.js', 'src/store.js', 'src/wechat-pay.js',
  'src/admin.js', 'src/admin-store.js', 'src/multipart-image.js', 'public/admin/admin.js',
  'src/pattern-core.js', 'src/pattern-runner.js', 'src/pattern-worker.js',
  'src/custom-rules.js', 'src/custom-files.js', 'src/custom-store.js', 'src/custom-router.js',
  'scripts/cleanup-custom-files.mjs', 'scripts/compare-small-patterns.mjs', 'scripts/compare-facial-details.mjs', 'scripts/compare-compact-layout.mjs'
]
const projectFiles = [
  'pages/index/index.js', 'pages/index/membership-config.js',
  'pages/index/local-generation-policy.js', 'pages/index/local-pattern-core.js', 'pages/index/pattern-editor.js',
  'pages/index/palette.js', 'subpackages/gallery/pages/index/index.js', 'shared/product-catalog.js',
  'subpackages/custom/api.js', 'subpackages/custom/pages/submit/index.js',
  'subpackages/custom/pages/list/index.js', 'subpackages/custom/pages/detail/index.js',
  'subpackages/custom/pages/merchant/index.js', 'shared/small-pattern-engine.js', 'shared/low-resolution-engine.js'
]
const pageBindings = [
  ['pages/index/index.wxml', 'pages/index/index.js'],
  ['subpackages/gallery/pages/index/index.wxml', 'subpackages/gallery/pages/index/index.js'],
  ['subpackages/custom/pages/submit/index.wxml', 'subpackages/custom/pages/submit/index.js'],
  ['subpackages/custom/pages/list/index.wxml', 'subpackages/custom/pages/list/index.js'],
  ['subpackages/custom/pages/detail/index.wxml', 'subpackages/custom/pages/detail/index.js'],
  ['subpackages/custom/pages/merchant/index.wxml', 'subpackages/custom/pages/merchant/index.js']
]

for (const file of serverFiles) execFileSync(process.execPath, ['--check', path.join(serverRoot, file)], { stdio: 'inherit' })
for (const file of projectFiles) execFileSync(process.execPath, ['--check', path.join(projectRoot, file)], { stdio: 'inherit' })
for (const file of ['app.json', 'project.config.json', 'subpackages/gallery/pages/index/index.json',
  ...['submit', 'list', 'detail', 'merchant'].map((name) => `subpackages/custom/pages/${name}/index.json`)]) {
  JSON.parse(readFileSync(path.join(projectRoot, file), 'utf8'))
}
for (const [wxmlPath, scriptPath] of pageBindings) {
  const wxml = readFileSync(path.join(projectRoot, wxmlPath), 'utf8')
  const script = readFileSync(path.join(projectRoot, scriptPath), 'utf8')
  const methods = new Set([...script.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((match) => match[1]))
  const handlers = new Set([...wxml.matchAll(/\b(?:bind|catch)(?:tap|input|change|load|error|touchstart|touchmove|touchend|touchcancel|longpress)="([A-Za-z_$][\w$]*)"/g)].map((match) => match[1]))
  const missing = [...handlers].filter((handler) => !methods.has(handler))
  if (missing.length) throw new Error(`${wxmlPath} 缺少事件方法: ${missing.join(', ')}`)
}

console.log(`Syntax, JSON, and WXML event checks passed (${serverFiles.length + projectFiles.length} JavaScript files; ${pageBindings.length} pages)`)
