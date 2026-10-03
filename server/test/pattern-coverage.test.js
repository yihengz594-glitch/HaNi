import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { createCanvas } from '@napi-rs/canvas'
import { generatePattern } from '../src/pattern-core.js'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/pattern-core.js', import.meta.url), 'utf8')
const methods = vm.runInNewContext(`${source.slice(source.indexOf('const CANVAS_SIZE ='), source.indexOf('\nexport async function generatePattern('))}; coreMethods`, {
  PALETTE: require('../../pages/index/palette.js'),
  wx: { createOffscreenCanvas: ({ width, height }) => createCanvas(width, height) }
})
const runtime = () => Object.assign(Object.create(methods), {
  data: { paletteSpec: '221', threshold: 'none', sizeMode: 'board', gridWidth: 104, gridHeight: 104 }
})

test('thin opaque hair between sparse sample positions is not turned into an empty column', () => {
  const canvas = createCanvas(1200, 1200)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#29282c'
  // 104 格时每格仅取 3×3 点，x=696 正好落在该列的取样点之间。
  ctx.fillRect(696, 230, 1, 695)
  const grid = runtime().convertToGrid(ctx.getImageData(0, 0, 1200, 1200).data, 104, 104)
  for (let row = 20; row < 80; row += 1) {
    assert.equal(Boolean(grid[row][60].empty), false, `hair missing at row ${row}`)
  }
  assert.equal(grid[45][59].empty, true, 'actual transparent space must remain empty')
  assert.equal(grid[45][61].empty, true, 'do not dilate the hair into adjacent cells')
})

test('grid background cleanup preserves a cell containing a thin dark contour', () => {
  const canvas = createCanvas(1200, 1200)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1200, 1200)
  ctx.fillStyle = '#29282c'
  ctx.fillRect(400, 300, 200, 600)
  ctx.fillRect(696, 230, 1, 695)
  const grid = runtime().convertToGrid(ctx.getImageData(0, 0, 1200, 1200).data, 104, 104)
  assert.equal(Boolean(grid[45][60].empty), false, 'mixed white/hair cell is foreground')
  assert.equal(grid[45][59].empty, true, 'open white background must still be removed')
  assert.equal(grid[45][61].empty, true)
})

test('coarse background sampling cannot leak through a thin closed contour', () => {
  const canvas = createCanvas(1200, 1200)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1200, 1200)
  ctx.fillStyle = '#29282c'
  ctx.fillRect(350, 200, 300, 800)
  // 1px 连续轮廓落在 5px 分析网格取样点之间；内部白色仍属于主体。
  ctx.fillRect(300, 400, 51, 1)
  ctx.fillRect(300, 400, 1, 101)
  ctx.fillRect(300, 500, 51, 1)
  const pixels = ctx.getImageData(0, 0, 1200, 1200).data
  const info = runtime().removeEdgeBackground(pixels)
  assert.equal(info.didRemoveBackground, true)
  assert.equal(pixels[(450 * 1200 + 325) * 4 + 3], 255, 'enclosed white highlight was erased')
  assert.equal(pixels[(450 * 1200 + 250) * 4 + 3], 0, 'external white background should be removed')
  assert.equal(pixels[(450 * 1200 + 300) * 4 + 3], 255, 'dark contour should stay opaque')
})

test('grid background cannot cross a diagonal-only gap into white foreground', () => {
  const white = () => ({ samples: [{ rgb: [255, 255, 255], weight: 1 }], average: [255, 255, 255], backgroundCandidate: false })
  const black = () => ({ samples: [{ rgb: [30, 30, 30], weight: 1 }], average: [30, 30, 30], backgroundCandidate: false })
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 7 }, white))
  for (const [row, col] of [[2, 3], [3, 2], [3, 4], [4, 3]]) cells[row][col] = black()
  runtime().maskExternalWhiteBackground(cells)
  assert.equal(cells[3][3].backgroundCandidate, false)
  assert.equal(cells[0][0].backgroundCandidate, true)
})

test('real transparent holes and open notches remain empty at 64, 104 and 160 grids', async () => {
  const canvas = createCanvas(1200, 1200)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#29282c'
  ctx.fillRect(100, 100, 1000, 1000)
  ctx.clearRect(500, 500, 200, 200)
  ctx.clearRect(850, 270, 250, 160)
  ctx.fillStyle = '#fffdf7'
  ctx.fillRect(350, 700, 300, 200)
  const buffer = canvas.toBuffer('image/png')
  for (const size of [64, 104, 160]) {
    const result = await generatePattern(buffer, { gridWidth: size, gridHeight: size })
    assert.equal(result.gridCodes[size / 2][size / 2], '', 'real interior transparency must stay empty')
    assert.equal(result.gridCodes[Math.floor(size * 0.28)][Math.floor(size * 0.84)], '', 'open notch must stay empty')
    assert.ok(result.gridCodes[Math.floor(size * 0.66)][Math.floor(size * 0.42)], 'light clothing must not be erased')
    assert.ok(result.gridCodes[0][0], 'the square subject now reaches the board corner instead of retaining the old artificial margin')
    assert.equal(result.totalBeads, result.gridCodes.flat().filter(Boolean).length)
    if (size === 104) {
      assert.deepEqual(await generatePattern(buffer, { gridWidth: size, gridHeight: size }), result,
        'repeated generation must not create intermittent holes')
    }
  }
})
