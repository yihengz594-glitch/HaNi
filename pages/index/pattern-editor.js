// 编辑器只处理 MARD 色号网格；空字符串是空格，任何白色色号仍是一颗豆。
const cloneCodes = (codes) => codes.map((row) => row.slice())

function createPatternEditor(codes, validCodes, originalCodes = codes) {
  if (!Array.isArray(codes) || !codes.length || !Array.isArray(codes[0]) || !codes[0].length) {
    throw new Error('图纸网格无效')
  }
  const width = codes[0].length
  if (codes.some((row) => !Array.isArray(row) || row.length !== width)) throw new Error('图纸行宽不一致')
  if (!Array.isArray(originalCodes) || originalCodes.length !== codes.length ||
      originalCodes.some((row) => !Array.isArray(row) || row.length !== width)) throw new Error('原始图纸尺寸不一致')
  const allowed = new Set(validCodes)
  const original = cloneCodes(originalCodes)
  const draft = cloneCodes(codes)
  const undoStack = []
  const redoStack = []
  let stroke = null

  function startStroke() { stroke = new Map() }

  function paint(row, col, code) {
    if (!stroke) startStroke()
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= draft.length || col >= width) return false
    if (code !== '' && !allowed.has(code)) throw new Error('未知 MARD 色号')
    if (draft[row][col] === code) return false
    const key = row * width + col
    const prior = stroke.get(key)
    stroke.set(key, { row, col, before: prior ? prior.before : draft[row][col], after: code })
    draft[row][col] = code
    return true
  }

  function finishStroke() {
    if (!stroke) return false
    const changes = [...stroke.values()].filter((change) => change.before !== change.after)
    stroke = null
    if (!changes.length) return false
    undoStack.push(changes)
    if (undoStack.length > 50) undoStack.shift()
    redoStack.length = 0
    return true
  }

  function applyHistory(from, to, key) {
    finishStroke()
    if (!from.length) return false
    const changes = from.pop()
    changes.forEach((change) => { draft[change.row][change.col] = change[key] })
    to.push(changes)
    return true
  }

  function restoreOriginal() {
    finishStroke()
    startStroke()
    for (let row = 0; row < draft.length; row += 1) {
      for (let col = 0; col < width; col += 1) paint(row, col, original[row][col])
    }
    return finishStroke()
  }

  return {
    original,
    draft,
    startStroke,
    paint,
    finishStroke,
    undo: () => applyHistory(undoStack, redoStack, 'before'),
    redo: () => applyHistory(redoStack, undoStack, 'after'),
    restoreOriginal,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    copyDraft: () => cloneCodes(draft)
  }
}

function clientToCell(clientX, clientY, viewport, zoom, offsetX, offsetY, preview, rows, columns) {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0 || zoom <= 0) return null
  const localX = (clientX - viewport.left - viewport.width / 2 - offsetX) / zoom + viewport.width / 2
  const localY = (clientY - viewport.top - viewport.height / 2 - offsetY) / zoom + viewport.height / 2
  const canvasX = localX * 1200 / viewport.width
  const canvasY = localY * 1200 / viewport.height
  const col = Math.floor((canvasX - preview.left) * columns / preview.width)
  const row = Math.floor((canvasY - preview.top) * rows / preview.height)
  return row >= 0 && row < rows && col >= 0 && col < columns ? { row, col } : null
}

function lineCells(first, last) {
  if (!first || !last) return last ? [last] : []
  const result = []
  let x = first.col
  let y = first.row
  const dx = Math.abs(last.col - x)
  const dy = Math.abs(last.row - y)
  const sx = x < last.col ? 1 : -1
  const sy = y < last.row ? 1 : -1
  let error = dx - dy
  while (true) {
    result.push({ row: y, col: x })
    if (x === last.col && y === last.row) break
    const doubled = error * 2
    if (doubled > -dy) { error -= dy; x += sx }
    if (doubled < dx) { error += dx; y += sy }
  }
  return result
}

module.exports = { createPatternEditor, clientToCell, lineCells }
