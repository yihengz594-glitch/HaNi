import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createCanvas } from '@napi-rs/canvas'
import { generatePattern } from '../src/pattern-core.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const engine = require('../../shared/bead-reconstruction.js')
const [input, output, sizeArg = '52'] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: inspect-target-stages INPUT OUTPUT [SIZE]')
const size = Number(sizeArg)
await mkdir(output, { recursive: true })
const result = await generatePattern(await readFile(input), {
  generationMode: 'target', gridWidth: size, gridHeight: size,
  sizeMode: 'board', paletteSpec: '221', threshold: 'none', debug: true
})
const { stages, ...diagnostics } = result.diagnostics
const regions = engine.regionalClusters(stages.cells, diagnostics.parameters)
const simplified = engine.simplifyRegionalColors(regions, stages.cells, diagnostics.parameters, diagnostics.analysis)
const targetColors = new Array(size * size).fill(null)
for (const region of simplified) for (const i of region.members) targetColors[i] = region.rgb
for (const name of ['sampled', 'quantized', 'mapped', 'cleaned']) {
  const canvas = createCanvas(size * 12, size * 12), ctx = canvas.getContext('2d')
  ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < size * size; i++) {
    const rgb = name === 'sampled' ? stages.cells[i]?.rgb : name === 'quantized' ? targetColors[i] : stages[name][i]?.rgb
    if (!rgb) continue
    ctx.fillStyle = `rgb(${rgb.map(Math.round).join(',')})`
    ctx.fillRect(i % size * 12, Math.floor(i / size) * 12, 12, 12)
  }
  await writeFile(`${output}/${name}.png`, canvas.toBuffer('image/png'))
}
await writeFile(`${output}/diagnostics.json`, JSON.stringify(diagnostics, null, 2))
await writeFile(`${output}/cells.json`, JSON.stringify(stages.cells))
await writeFile(`${output}/color-mapping.json`, JSON.stringify(simplified.map(region => ({
  sourceRgb: region.originalRgb || region.rgb,
  targetRgb: region.rgb,
  count: region.members.length,
  beadCode: stages.mapped[region.members[0]]?.code,
  beadRgb: stages.mapped[region.members[0]]?.rgb,
  protected: region.protected
})), null, 2))
console.log(JSON.stringify(diagnostics))
