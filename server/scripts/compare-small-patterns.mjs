import { createCanvas, loadImage } from '@napi-rs/canvas'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { generatePattern } from '../src/pattern-core.js'

const require = createRequire(import.meta.url)
const palette = require('../../pages/index/palette.js')
const colorMap = new Map(palette.map(c => [c.code, c.hex]))
const [baselineRoot, sourcePath, outputRoot = '/private/tmp/pinbead-small-preview', mode] = process.argv.slice(2)
if (!baselineRoot || !sourcePath) throw new Error('Usage: node compare-small-patterns.mjs BASELINE_ROOT SOURCE_IMAGE OUTPUT_DIR')
const { generatePattern: oldGenerate } = await import(pathToFileURL(path.join(baselineRoot, 'server/src/pattern-core.js')))
await mkdir(outputRoot, { recursive: true })
const input = await readFile(sourcePath)
const sizes = [[29,29],[38,38],[48,48],[52,52],[53,53],[64,64],[80,80],[38,52],[38,53],[53,38]]
const stats = result => {
  const counts = {}
  result.gridCodes.flat().forEach(code => { if (code) counts[code] = (counts[code] || 0) + 1 })
  return { columns: result.columns, rows: result.rows, mask: result.gridCodes.map(row => row.map(Boolean)), counts, totalBeads: result.totalBeads }
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function render(result, name) {
  const step = 16
  const canvas = createCanvas(result.columns * step, result.rows * step)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ededed'; ctx.fillRect(0,0,canvas.width,canvas.height)
  result.gridCodes.forEach((row,y) => row.forEach((code,x) => {
    if (!code) return
    ctx.fillStyle = colorMap.get(code); ctx.fillRect(x*step,y*step,step,step)
  }))
  await writeFile(path.join(outputRoot, name), canvas.toBuffer('image/png'))
}
const results = []
for (const [width,height] of sizes) {
  const settings = { sizeMode:'board', gridWidth:width, gridHeight:height, paletteSpec:'221', threshold:'none' }
  const oldResult = await oldGenerate(input, settings)
  const newResult = await generatePattern(input, settings)
  const label = `${width}x${height}`
  await render(oldResult, `${label}-old.png`)
  await render(newResult, `${label}-new.png`)
  await writeFile(path.join(outputRoot, `${label}-old.json`), JSON.stringify(oldResult))
  await writeFile(path.join(outputRoot, `${label}-new.json`), JSON.stringify(newResult))
  const row = { label, settings, equal: hash(oldResult.gridCodes)===hash(newResult.gridCodes) && hash(stats(oldResult))===hash(stats(newResult)), oldHash:hash(oldResult.gridCodes), newHash:hash(newResult.gridCodes), oldStats:stats(oldResult), newStats:stats(newResult) }
  results.push(row)
  console.log(JSON.stringify({ label, equal:row.equal, oldCounts:row.oldStats.counts, newCounts:row.newStats.counts }))
}
await writeFile(path.join(outputRoot,'report.json'),JSON.stringify(results,null,2))
const decoded = await loadImage(input)
const original = createCanvas(decoded.width,decoded.height)
original.getContext('2d').drawImage(decoded,0,0)
await writeFile(path.join(outputRoot,'original.png'),original.toBuffer('image/png'))
const heading=mode==='layout'?'紧凑排版：所有尺寸同图对照':'粉色角色：同图、同格数、MARD 221、不合并'
const suffix=r=>mode==='layout'?' · 主体完整适配，尺寸不变':Math.max(r.settings.gridWidth,r.settings.gridHeight)>52?' · 大尺寸一致性 '+(r.equal?'通过':'失败'):''
await writeFile(path.join(outputRoot,'index.html'), `<!doctype html><meta charset="utf-8"><title>${heading}</title><style>body{font:16px system-ui;background:#f5f5f5;color:#222;margin:24px}section{margin:30px 0;padding:20px;background:white;border-radius:12px}.pair{display:flex;gap:24px;flex-wrap:wrap}figure{margin:0}img{image-rendering:pixelated;max-width:100%;width:420px}figcaption{margin:10px 0}header img{width:274px}p{max-width:900px}</style><header><h1>${heading}</h1><p>左为修改前，右为当前算法。图片直接从最终色号矩阵绘制，无网格线；灰色表示空格，白色表示白色拼豆。${mode==='layout'?'本次已授权改变大尺寸排版，放大后色号矩阵会变化，不再要求新旧逐格一致。':''}</p><img src="original.png"></header>${results.map(r=>`<section><h2>${r.label}${suffix(r)}</h2><div class="pair"><figure><figcaption>修改前 · ${r.oldStats.totalBeads} 豆</figcaption><img src="${r.label}-old.png"></figure><figure><figcaption>修改后 · ${r.newStats.totalBeads} 豆</figcaption><img src="${r.label}-new.png"></figure></div></section>`).join('')}`)
