import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pagePath = path.join(projectRoot, 'pages/index/index.js')
const corePath = path.join(projectRoot, 'server/src/pattern-core.js')
const source = fs.readFileSync(pagePath, 'utf8')

// Copy the existing pixel-processing methods verbatim into the trusted server
// runtime; only these methods are removed from the mini-program bundle.
const movedMethods = [
  'convertToGrid', 'maskExternalWhiteBackground', 'createNormalizedPixels',
  'getFullCanvasBounds', 'removeEdgeBackground', 'getVisiblePixelBounds',
  'addBoundsPadding', 'resolveGridSize', 'buildDitherPalette',
  'getControlledQuantizationPalette', 'applyFloydSteinbergDither',
  'stabilizeSkinColors', 'findConnectedBackgroundCells',
  'keepInteriorWhiteCells', 'applyCartoonOutline', 'getOutlineColor',
  'isDarkOutlineColor', 'toneMapRgb', 'getRepresentativeRgb',
  'chooseCellColor', 'detectWhiteBackground', 'isNearWhite'
]
const copiedHelpers = [
  'findNearestRgb', 'getSkinPaletteCandidates', 'isStrongYellowRgb',
  'rgbToOklab', 'oklabDistance', 'isSkinToneRgb', 'isSkinToneColor',
  'rgbDistance', 'mardColorDistance', 'findNeutralDarkAnchor',
  'makeMardColor', 'makeOriginalRgbColor', 'rgbToHex', 'findNearestColor',
  'getActivePalette'
]
const allMethods = [...movedMethods, ...copiedHelpers]

function findMethod(name) {
  const match = new RegExp(`^  ${name}\\(`, 'm').exec(source)
  if (!match) throw new Error(`Could not find Page method: ${name}`)
  const start = match.index + (source[match.index] === '\n' ? 1 : 0)
  const signatureEnd = source.indexOf(')', match.index)
  const bodyStart = source.indexOf('{', signatureEnd)
  if (signatureEnd < 0 || bodyStart < 0) throw new Error(`Malformed Page method: ${name}`)

  let depth = 0
  let state = 'code'
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (char === '\n') state = 'code'
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { state = 'code'; index += 1 }
      continue
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      const delimiter = state === 'single' ? "'" : state === 'double' ? '"' : '`'
      if (char === '\\') { index += 1; continue }
      if (char === delimiter) state = 'code'
      continue
    }
    if (char === '/' && next === '/') { state = 'line-comment'; index += 1; continue }
    if (char === '/' && next === '*') { state = 'block-comment'; index += 1; continue }
    if (char === "'") { state = 'single'; continue }
    if (char === '"') { state = 'double'; continue }
    if (char === '`') { state = 'template'; continue }
    if (char === '{') depth += 1
    if (char === '}' && --depth === 0) {
      const bodyEnd = index + 1
      let removeEnd = bodyEnd
      if (source[removeEnd] === ',') removeEnd += 1
      if (source[removeEnd] === '\r') removeEnd += 1
      if (source[removeEnd] === '\n') removeEnd += 1
      return { name, start, bodyEnd, removeEnd, text: source.slice(start, bodyEnd).trim() }
    }
  }
  throw new Error(`Could not match Page method body: ${name}`)
}

const methods = allMethods.map(findMethod)
const constantsStart = source.indexOf('const CANVAS_SIZE =')
const constantsEnd = source.indexOf('const MEMBER_PROFILE_STORAGE_KEY =')
if (constantsStart < 0 || constantsEnd < 0) throw new Error('Could not find pattern constants')
const constants = source.slice(constantsStart, constantsEnd).trim()

const moduleSource = `import { createCanvas, loadImage } from '@napi-rs/canvas'\nimport { createRequire } from 'node:module'\n\nconst require = createRequire(new URL('../../pages/index/index.js', import.meta.url))\nconst PALETTE = require('./palette.js')\nconst wx = { createOffscreenCanvas: ({ width, height }) => createCanvas(width, height) }\n\n${constants}\n\nconst coreMethods = {\n${methods.map((method) => method.text).join(',\n\n')}\n}\n\nexport async function generatePattern(imageBuffer, settings) {\n  const image = await loadImage(imageBuffer)\n  const runtime = Object.assign(Object.create(coreMethods), {\n    data: {\n      paletteSpec: String(settings.paletteSpec || '221'),\n      threshold: String(settings.threshold || 'none'),\n      sizeMode: settings.sizeMode === 'image' ? 'image' : 'board',\n      gridWidth: Number(settings.gridWidth) || 64,\n      gridHeight: Number(settings.gridHeight) || 64\n    },\n    activePaletteCacheKey: null,\n    activePaletteCache: null\n  })\n  const normalized = runtime.createNormalizedPixels(image)\n  const size = runtime.resolveGridSize(normalized.pixels, normalized.bounds)\n  const rawGrid = runtime.convertToGrid(normalized.pixels, size.columns, size.rows)\n  const grid = runtime.applyCartoonOutline(rawGrid, normalized)\n  const sourceRgbByCode = {}\n  let totalBeads = 0\n  const gridCodes = grid.map((row) => row.map((color) => {\n    if (!color || color.empty) return ''\n    totalBeads += 1\n    if (!sourceRgbByCode[color.code] && color.sourceRgb) sourceRgbByCode[color.code] = color.sourceRgb\n    return color.code\n  }))\n  return { gridCodes, sourceRgbByCode, columns: size.columns, rows: size.rows, totalBeads }\n}\n`

fs.writeFileSync(corePath, moduleSource)
const ranges = methods.filter((method) => movedMethods.includes(method.name))
  .sort((first, second) => second.start - first.start)
let updated = source
for (const range of ranges) updated = updated.slice(0, range.start) + updated.slice(range.removeEnd)
fs.writeFileSync(pagePath, updated)
console.log(`Moved ${movedMethods.length} pixel processing methods to ${path.relative(projectRoot, corePath)}; copied ${copiedHelpers.length} shared helpers.`)
