import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverCorePath = path.join(projectRoot, 'server/src/pattern-core.js')
const localCorePath = path.join(projectRoot, 'pages/index/local-pattern-core.js')
const source = fs.readFileSync(serverCorePath, 'utf8')
const start = source.indexOf('const CANVAS_SIZE =')
const end = source.indexOf('\nexport async function generatePattern(')
if (start < 0 || end <= start || !source.slice(start, end).includes('const coreMethods = {')) {
  throw new Error('服务端算法结构已变化，不能安全同步开发版本地算法')
}

// 像素算法方法体原样复制；只替换 Node 的图片解码/Canvas 适配层。
const sharedCore = source.slice(start, end).trimEnd()
const localSource = `// Generated from server/src/pattern-core.js by scripts/sync-local-pattern-core.mjs.
// Do not edit pixel algorithms here; run the sync script after changing the server core.
const PALETTE = require('./palette')
const lowResolutionEngine = require('../../shared/small-pattern-engine.js')
const reconstructionEngine = require('../../shared/bead-reconstruction.js')
const { TARGET_VERSION } = require('../../shared/generation-settings.js')

${sharedCore}

function generateLocalPattern(image, settings, fallbackCanvas) {
  const runtime = Object.assign(Object.create(coreMethods), {
    data: {
      paletteSpec: String(settings.paletteSpec || '221'),
      threshold: String(settings.threshold || 'none'),
      sizeMode: settings.sizeMode === 'image' ? 'image' : 'board',
      gridWidth: Number(settings.gridWidth) || 64,
      gridHeight: Number(settings.gridHeight) || 64,
      layoutMode: settings.layoutMode === 'legacy' ? 'legacy' : 'compact'
    },
    canvas: fallbackCanvas,
    activePaletteCacheKey: null,
    activePaletteCache: null
  })
  let size
  let grid
  let diagnostics
  const isFixedBoard = settings.sizeMode !== 'image'
  const requestedBoardSize = isFixedBoard
    ? {
      columns: Math.max(8, Math.min(160, Number(settings.gridWidth) || 64)),
      rows: Math.max(8, Math.min(160, Number(settings.gridHeight) || 64))
    }
    : null
  const boardUsesLowMode = requestedBoardSize
    && Math.max(requestedBoardSize.columns, requestedBoardSize.rows) <= 52
  const createCanvas = (options) => wx.createOffscreenCanvas
    ? wx.createOffscreenCanvas(options)
    : fallbackCanvas
  if (settings.generationMode === 'target' || settings.algorithm === 'reconstruction') {
    size = requestedBoardSize || (() => {
      const normalized = runtime.createNormalizedPixels(image)
      return runtime.resolveGridSize(normalized.pixels, normalized.bounds)
    })()
    const result = reconstructionEngine.generate(runtime, image, size, createCanvas,
      { debug: settings.debug === true, sampling: settings.sampling })
    grid = result.grid
    diagnostics = result.diagnostics
  } else if (boardUsesLowMode) {
    size = requestedBoardSize
    grid = lowResolutionEngine.generate(runtime, image, size, createCanvas, 1200)
  } else {
    const normalized = runtime.createNormalizedPixels(image)
    size = isFixedBoard ? requestedBoardSize : runtime.resolveGridSize(normalized.pixels, normalized.bounds)
    if (Math.max(size.columns, size.rows) <= 52) {
      grid = lowResolutionEngine.generate(runtime, image, size, createCanvas, 1200)
    } else {
      const fitted = !isFixedBoard && runtime.data.layoutMode !== 'legacy' ? runtime.createNormalizedPixels(image, size) : normalized
      const rawGrid = runtime.convertToGrid(fitted.pixels, size.columns, size.rows)
      grid = runtime.applyCartoonOutline(rawGrid, fitted)
    }
  }
  const sourceRgbByCode = {}
  let totalBeads = 0
  const gridCodes = grid.map((row) => row.map((color) => {
    if (!color || color.empty) return ''
    totalBeads += 1
    if (!sourceRgbByCode[color.code] && color.sourceRgb) sourceRgbByCode[color.code] = color.sourceRgb
    return color.code
  }))
  const result = { gridCodes, sourceRgbByCode, columns: size.columns, rows: size.rows, totalBeads }
  if (settings.generationMode === 'target') Object.assign(result, { generationMode: 'target', targetVersion: TARGET_VERSION })
  if (settings.debug === true && diagnostics) result.diagnostics = diagnostics
  return result
}

module.exports = { generateLocalPattern }
`

fs.writeFileSync(localCorePath, localSource)
console.log(`Synced local development pattern core: ${path.relative(projectRoot, localCorePath)}`)
