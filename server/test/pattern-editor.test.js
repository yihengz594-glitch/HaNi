import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPatternEditor, clientToCell, lineCells } = require('../../pages/index/pattern-editor.js')
const PALETTE = require('../../pages/index/palette.js')

test('stroke history groups drag, keeps empty distinct from white and invalidates redo after new paint', () => {
  const source = [['H2', '', 'H7']]
  const editor = createPatternEditor(source, PALETTE.map((color) => color.code))
  editor.startStroke()
  assert.equal(editor.paint(0, 0, ''), true)
  assert.equal(editor.paint(0, 1, 'H2'), true)
  assert.equal(editor.finishStroke(), true)
  assert.deepEqual(source, [['H2', '', 'H7']], 'source grid must not mutate')
  assert.deepEqual(editor.copyDraft(), [['', 'H2', 'H7']])
  assert.equal(editor.undo(), true)
  assert.deepEqual(editor.copyDraft(), source)
  assert.equal(editor.redo(), true)
  assert.deepEqual(editor.copyDraft(), [['', 'H2', 'H7']])
  editor.startStroke()
  editor.paint(0, 2, 'H2')
  editor.finishStroke()
  assert.equal(editor.canRedo(), false)
  assert.equal(editor.restoreOriginal(), true)
  assert.deepEqual(editor.copyDraft(), source)
  assert.equal(editor.undo(), true, 'restore is itself undoable')
  assert.deepEqual(editor.copyDraft(), [['', 'H2', 'H2']])
  assert.throws(() => editor.paint(0, 0, 'NOT_A_MARD_CODE'), /未知/)
  const reopened = createPatternEditor([['', 'H2', 'H7']], PALETTE.map((color) => color.code), source)
  assert.equal(reopened.restoreOriginal(), true)
  assert.deepEqual(reopened.copyDraft(), source, 'saved edits must still restore the generated original')
})

test('touch cell coordinates account for viewport position, zoom and pan; fast drags fill intermediates', () => {
  const viewport = { left: 10, top: 20, width: 300, height: 300 }
  const preview = { left: 0, top: 0, width: 1200, height: 1200 }
  assert.deepEqual(clientToCell(47.5, 57.5, viewport, 1, 0, 0, preview, 4, 4), { row: 0, col: 0 })
  // Grid cell (row 2, col 1) is at logical viewport (112.5, 187.5).
  assert.deepEqual(clientToCell(115, 230, viewport, 2, 30, -15, preview, 4, 4), { row: 2, col: 1 })
  assert.equal(clientToCell(0, 0, viewport, 1, 0, 0, preview, 4, 4), null)
  assert.deepEqual(lineCells({ row: 0, col: 0 }, { row: 0, col: 4 }).map((cell) => cell.col), [0, 1, 2, 3, 4])
})

for (const generationMode of ['legacy', 'target']) test(`${generationMode}: editing, history and export share one matrix without generation`, () => {
  const previousPage = globalThis.Page
  const previousWx = globalThis.wx
  let definition
  let cached = null
  try {
    globalThis.Page = (value) => { definition = value }
    globalThis.wx = { setStorageSync: (_, value) => { cached = value }, showToast: () => {}, showLoading: () => {} }
    delete require.cache[require.resolve('../../pages/index/index.js')]
    require('../../pages/index/index.js')
    const page = Object.assign({}, definition, {
      data: { ...definition.data, generationMode, generationModeIndex: generationMode === 'target' ? 1 : 0, targetVersion: generationMode === 'target' ? 'target-v1' : '', gridWidth: 2, gridHeight: 2, patternReady: true, imagePath: '/tmp/source.jpg' },
      setData(change, callback) { Object.assign(this.data, change); if (callback) callback() },
      drawGrid() {},
      getActivePalette: () => PALETTE,
      initCanvas(callback) { if (callback) callback() }
    })
    const white = page.makeMardColor(PALETTE.find((color) => color.code === 'H2'))
    const black = page.makeMardColor(PALETTE.find((color) => color.code === 'H7'))
    page.patternGrid = [[white, white], [black, { code: '', empty: true, hex: '#ffffff' }]]
    page.recordRecentWork(page.patternGrid)
    const recentId = page.currentRecentWorkId
    page.startPatternEdit()
    page.setData({ editorTool: 'erase' })
    page.editorSession.startStroke()
    page.paintEditorCells([{ row: 0, col: 0 }])
    page.editorSession.finishStroke()
    page.finishEditorStroke()
    assert.equal(page.data.totalBeads, 2)
    assert.equal(page.patternGrid[0][0].code, 'H2', 'draft must not mutate original grid')
    page.cancelPatternEdit()
    assert.equal(page.data.totalBeads, 3)
    assert.equal(cached[0].patternCodes[0][0], 'H2', 'cancel must not persist the draft')

    page.startPatternEdit()
    page.setData({ editorTool: 'erase' })
    page.editorSession.startStroke()
    page.paintEditorCells([{ row: 0, col: 0 }])
    page.editorSession.finishStroke()
    page.finishEditorStroke()
    page.setData({ editorTool: 'brush', editorColorCode: 'H2' })
    page.editorSession.startStroke()
    page.paintEditorCells([{ row: 1, col: 1 }])
    page.editorSession.finishStroke()
    page.finishEditorStroke()
    page.savePatternEdit()
    assert.equal(page.data.recentWorks.length, 1)
    assert.equal(page.currentRecentWorkId, recentId)
    assert.deepEqual(cached[0].patternCodes, [['', 'H2'], ['H7', 'H2']])
    assert.equal(cached[0].generationMode, generationMode)
    assert.equal(cached[0].targetVersion, generationMode === 'target' ? 'target-v1' : '')
    assert.equal(page.data.totalBeads, 3)
    assert.deepEqual(page.data.colorStats.map(({ code, count }) => [code, count]), [['H2', 2], ['H7', 1]])

    page.canvas = {}
    page.exportCanvas = {
      getContext: () => ({ fillRect() {}, fillText() {} }),
      requestAnimationFrame: (callback) => callback()
    }
    let exported
    page.drawSheetToContext = (_, grid) => { exported.codes = page.getRecentPatternCodes(grid) }
    page.drawExportLegend = (_, stats) => { exported.legend = stats.map(({ code, count }) => [code, count]) }
    page.exportCanvasToFile = (_, width, height, callback) => { exported.size = [width, height]; callback(null, '/tmp/edited.png') }
    page.saveToAlbum = (path) => { exported.path = path }
    globalThis.wx.hideLoading = () => {}
    page.generatePattern = () => { throw new Error('editing/export must never regenerate or rebill') }
    exported = {}
    page.savePattern()
    assert.deepEqual(exported.codes, cached[0].patternCodes)
    assert.deepEqual(exported.legend, [['H2', 2], ['H7', 1]])
    assert.equal(exported.path, '/tmp/edited.png')
    assert.ok(exported.size[0] > 0 && exported.size[1] > 0)
    page.openRecentWork({ currentTarget: { dataset: { id: recentId } } })
    assert.equal(page.data.generationMode, generationMode)
    assert.deepEqual(page.getRecentPatternCodes(page.patternGrid), exported.codes)
    page.startPatternEdit()
    page.restoreOriginalPattern()
    assert.deepEqual(page.editorSession.copyDraft(), [['H2', 'H2'], ['H7', '']])
    page.undoPatternEdit()
    assert.deepEqual(page.editorSession.copyDraft(), exported.codes)
    page.cancelPatternEdit()

    // 视口查询异步完成前，整段快速拖动已经抬起，也必须补齐中间格并作为一步撤销。
    let viewportQuery
    globalThis.wx.createSelectorQuery = () => ({
      select() { return this },
      boundingClientRect() { return this },
      exec(callback) { viewportQuery = callback }
    })
    page.startPatternEdit()
    page.setData({ editorTool: 'erase' })
    page.editorCellAt = (x) => ({ row: 1, col: x < 20 ? 0 : 1 })
    page.editorTouchStart({ touches: [{ clientX: 15, clientY: 30 }] })
    page.editorTouchMove({ touches: [{ clientX: 22, clientY: 30 }] })
    page.editorTouchEnd({ type: 'touchend', changedTouches: [{ clientX: 25, clientY: 30 }] })
    viewportQuery([{ left: 0, top: 0, width: 100, height: 100 }])
    assert.deepEqual(page.editorSession.copyDraft(), [['', 'H2'], ['', '']])
    assert.equal(page.data.totalBeads, 1)
    page.undoPatternEdit()
    assert.deepEqual(page.editorSession.copyDraft(), exported.codes)
    page.cancelPatternEdit()

    // 查询在拖动途中返回时，起点和已移动到的格子也属于同一笔，不可只涂末格。
    page.startPatternEdit()
    page.setData({ editorTool: 'erase' })
    page.editorCellAt = (x) => ({ row: 1, col: x < 20 ? 0 : 1 })
    page.editorTouchStart({ touches: [{ clientX: 15, clientY: 30 }] })
    page.editorTouchMove({ touches: [{ clientX: 25, clientY: 30 }] })
    viewportQuery([{ left: 0, top: 0, width: 100, height: 100 }])
    page.editorTouchEnd({ type: 'touchend', changedTouches: [{ clientX: 25, clientY: 30 }] })
    assert.deepEqual(page.editorSession.copyDraft(), [['', 'H2'], ['', '']])
    page.cancelPatternEdit()

    // Storage quota/errors must not be reported as a durable save, although the current grid remains exportable.
    const previousWarn = console.warn
    const previousCached = cached
    let saveNotice = ''
    globalThis.wx.setStorageSync = () => { throw new Error('storage full') }
    globalThis.wx.showToast = ({ title }) => { saveNotice = title }
    console.warn = () => {}
    try {
      page.startPatternEdit()
      page.setData({ editorTool: 'brush', editorColorCode: 'H7' })
      page.editorSession.startStroke()
      page.paintEditorCells([{ row: 0, col: 1 }])
      page.editorSession.finishStroke()
      page.savePatternEdit()
      assert.equal(saveNotice, '当前可导出，历史保存失败')
      assert.equal(page.patternGrid[0][1].code, 'H7')
      assert.equal(cached, previousCached, 'failed storage write must not claim persistence')
    } finally {
      console.warn = previousWarn
    }
  } finally {
    globalThis.Page = previousPage
    globalThis.wx = previousWx
  }
})
