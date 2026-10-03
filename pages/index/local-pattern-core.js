// Generated from server/src/pattern-core.js by scripts/sync-local-pattern-core.mjs.
// Do not edit pixel algorithms here; run the sync script after changing the server core.
const PALETTE = require('./palette')
const lowResolutionEngine = require('../../shared/small-pattern-engine.js')
const reconstructionEngine = require('../../shared/bead-reconstruction.js')
const { TARGET_VERSION } = require('../../shared/generation-settings.js')

const CANVAS_SIZE = 1200
const EXPORT_MIN_WIDTH = 1600
const EXPORT_MARGIN_X = 140
const EXPORT_GRID_TOP = 190
const EXPORT_MAX_EDGE = 4096
const CANVAS_FONT_FAMILY = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
// 背景分离使用比最终网格更细的分析网格。之前 180 格会把白纱、衣服等
// 和背景一起切成大片透明块；提高到 240 格后，边缘判断更接近真实轮廓。
const SEGMENT_SIZE = 240
// 以网格宽度换算后约留 2–5 格安全边距，避免主体贴边。
const NORMALIZED_INSET = 56
// 量化前只做轻度“提鲜”，不改动 MARD 色板本身；最终每格仍只会落到一个真实色号。
const COLOR_VIVIDNESS = 1.16
const COLOR_CONTRAST = 1.045
// 继续保留误差扩散以保护细节，但降低扩散强度，避免相邻格子看起来像混色噪点。
const DITHER_ERROR_SCALE = 0.52
// 低色号色板必须保留肤色/白色的稳定锚点。只靠 RGB 最远点采样时，72 色容易
// 选中黄色而漏掉浅肤色，随后脸部和手臂会被量化成黄块。
const LOW_PALETTE_ANCHOR_CODES = [
  'H7', 'H16', 'H6', 'H5', 'H2', 'H1',
  'E14', 'F16', 'F17', 'F20', 'G2', 'G3', 'G4', 'G9', 'G16', 'A23', 'M13'
]
// 脸和手臂优先使用这些真实 MARD 肤色；G4 保留在低色号锚点中供阴影使用，
// 但不再把它当成肤色锁定的首选，避免暖黄色阴影在脸上形成突兀色块。
const SKIN_TONE_ANCHOR_CODES = ['E14', 'F16', 'F17', 'F20', 'G2', 'G3', 'G16', 'A23', 'M13']
const EMPTY_COLOR = {
  name: '空白背景',
  code: '',
  hex: '#ffffff',
  rgb: [255, 255, 255],
  empty: true
}

const isNearWhiteRgb = (rgb) => Math.min(rgb[0], rgb[1], rgb[2]) >= 236
  && Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]) <= 18
  && rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 >= 240

const coreMethods = {
convertToGrid(pixels, columns, rows) {
    const cellInfoGrid = []
    const cellWidth = CANVAS_SIZE / columns
    const cellHeight = CANVAS_SIZE / rows
    const cellCount = columns * rows
    // 每格只取一组原图 RGB，然后由抖动算法选出一个最终纯色。
    // 小尺寸最容易把眼睛、嘴线和轮廓平均掉，所以按画板大小增加采样密度；
    // 采样仍然只发生在 1200px 工作画布上，不会改变最终“一格一个色号”的规则。
    const sampleSteps = cellCount <= 676
      ? 9
      : cellCount <= 2704
        ? 7
        : cellCount <= 4096
          ? 6
          : cellCount <= 6084
            ? 5
            : cellCount <= 10000
              ? 4
              : 3
    const centerSampleWeight = cellCount <= 676
      ? 2.2
      : cellCount <= 2704
        ? 1.9
        : cellCount <= 4096
          ? 1.7
          : cellCount <= 6084
            ? 1.5
            : 1.35
    // 高格数时一个采样点就把整格拉成黑色，会让猫眼、鼻孔、胡须等变成脏块。
    // 因此黑色五官必须在这一格里占到足够面积才触发“深色细节保护”。
    const minimumDarkCoverage = cellCount > 10000
      ? 0.2
      : cellCount > 6000
        ? 0.17
        : cellCount > 2704
          ? 0.12
          : 0.08

    for (let row = 0; row < rows; row += 1) {
      const infoRow = []
      for (let col = 0; col < columns; col += 1) {
        const samples = []
        let red = 0
        let green = 0
        let blue = 0
        let totalWeight = 0
        let opaqueSamples = 0
        let darkWeight = 0
        let centerDark = false
        let centerRgb = null
        let minimumLuminance = 255
        let maximumLuminance = 0

        for (let sy = 0; sy < sampleSteps; sy += 1) {
          for (let sx = 0; sx < sampleSteps; sx += 1) {
            const x = Math.min(CANVAS_SIZE - 1, Math.floor(col * cellWidth + (sx + 0.5) * cellWidth / sampleSteps))
            const y = Math.min(CANVAS_SIZE - 1, Math.floor(row * cellHeight + (sy + 0.5) * cellHeight / sampleSteps))
            const index = (y * CANVAS_SIZE + x) * 4
            const alpha = pixels[index + 3]
            if (alpha < 28) {
              continue
            }
            // 不再做饱和度/对比度处理，最终画面优先保留原照片的 RGB 关系。
            const rgb = [pixels[index], pixels[index + 1], pixels[index + 2]]
            const isCenterSample = sx === Math.floor(sampleSteps / 2) && sy === Math.floor(sampleSteps / 2)
            const centerWeight = isCenterSample ? centerSampleWeight : 1
            samples.push({ rgb, weight: centerWeight })
            red += rgb[0] * centerWeight
            green += rgb[1] * centerWeight
            blue += rgb[2] * centerWeight
            totalWeight += centerWeight
            opaqueSamples += 1
            const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
            minimumLuminance = Math.min(minimumLuminance, luminance)
            maximumLuminance = Math.max(maximumLuminance, luminance)
            if (isCenterSample) {
              centerRgb = rgb
            }
            if (luminance < 78) {
              darkWeight += centerWeight
              centerDark = centerDark || isCenterSample
            }
          }
        }

        // 稀疏取样只用于选色，不能据此认定整格不存在主体。细发丝可能刚好落在
        // 3×3 取样点之间；准备留空/去白底的格子必须复核其完整像素范围。
        let hasSourceForeground = false
        const whiteSampleCount = samples.filter((sample) => isNearWhiteRgb(sample.rgb)).length
        if (!opaqueSamples || whiteSampleCount >= samples.length * 0.68) {
          const recoverMissedSamples = !opaqueSamples
          const left = Math.ceil(col * cellWidth)
          const right = Math.min(CANVAS_SIZE, Math.ceil((col + 1) * cellWidth))
          const top = Math.ceil(row * cellHeight)
          const bottom = Math.min(CANVAS_SIZE, Math.ceil((row + 1) * cellHeight))
          for (let y = top; y < bottom; y += 1) {
            for (let x = left; x < right; x += 1) {
              const index = (y * CANVAS_SIZE + x) * 4
              if (pixels[index + 3] < 28) continue
              const rgb = [pixels[index], pixels[index + 1], pixels[index + 2]]
              if (!isNearWhiteRgb(rgb)) hasSourceForeground = true
              if (recoverMissedSamples) {
                samples.push({ rgb, weight: 1 })
                red += rgb[0]
                green += rgb[1]
                blue += rgb[2]
                totalWeight += 1
                opaqueSamples += 1
                const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
                minimumLuminance = Math.min(minimumLuminance, luminance)
                maximumLuminance = Math.max(maximumLuminance, luminance)
                if (luminance < 78) darkWeight += 1
              }
            }
          }
        }

        const average = totalWeight
          ? [red / totalWeight, green / totalWeight, blue / totalWeight]
          : [255, 255, 255]
        const darkestSample = samples.reduce((darkest, sample) => {
          const luminance = sample.rgb[0] * 0.299 + sample.rgb[1] * 0.587 + sample.rgb[2] * 0.114
          if (!darkest || luminance < darkest.luminance) {
            return { rgb: sample.rgb, luminance }
          }
          return darkest
        }, null)
        const averageLuminance = average[0] * 0.299 + average[1] * 0.587 + average[2] * 0.114
        const darkCoverage = totalWeight ? darkWeight / totalWeight : 0
        // 中心采样点的单个深色常常是瞳孔、鼻尖或嘴线；允许它以“轻保护”形式保留，
        // 但不把边缘的一根胡须或噪点也当成整格黑色五官。
        // 采样变密后，单个中心采样的占比会变小；仍允许中心落在眼睛/嘴线上的情况
        // 进入轻保护，否则 16×16、26×26 会把关键五官直接吞掉。
        const centerDarkMinimum = cellCount <= 4096 ? 0.025 : minimumDarkCoverage * 0.62
        const hasMeaningfulDarkCoverage = darkCoverage >= minimumDarkCoverage || (centerDark && darkCoverage >= centerDarkMinimum)
        const darkFeature = darkestSample && darkestSample.luminance < 72 && averageLuminance - darkestSample.luminance > 58 && hasMeaningfulDarkCoverage

        const representative = this.getRepresentativeRgb(samples, average, cellCount, centerRgb)
        infoRow.push({
          samples,
          // 平均值容易把线稿、腮红和高光冲成灰色；中位色更接近这一格的主色，
          // 再做轻度提鲜后交给 MARD 量化，能让色块更干净、更有区分度。
          average: representative,
          // 这个标记基于未经过误差扩散的原始格子颜色，后续即使相邻黄色格
          // 把 RGB 工作值推偏，也不能解除肤色保护。
          skinLike: this.isSkinToneRgb(representative),
          // 背景已在像素级分离为透明；只有完全透明的格子才留白。
          // 白衣服、眼白、羊毛等仍会作为真正的白色拼豆显示色号。
          backgroundCandidate: opaqueSamples === 0,
          hasSourceForeground,
          // 保护已经占到足够面积的眼睛、眉毛、嘴巴等深色结构；孤立的一个暗采样点
          // 只会保留在平均色中，不会把整个浅色格错误涂黑。
          detailRgb: darkFeature ? darkestSample.rgb : null,
          detailCoverage: darkFeature ? darkCoverage : 0,
          // 小画板的一个格子经常横跨两个色块；这个值用于让量化阶段知道这里
          // 是真实轮廓/边界，而不是普通的抗锯齿灰边。
          edgeStrength: Math.max(0, maximumLuminance - minimumLuminance)
        })
      }
      cellInfoGrid.push(infoRow)
    }
    // 有些白底图片在缩放、压缩或主体贴边时，像素级去背景会保守地保留少量白底。
    // 量化前再按“白色 + 与四边连通”做一次格级清理：轮廓内的白色不会连到边缘，
    // 因此继续显示 H2 等色号；轮廓外的白底则留空，不参与色号统计和抖动。
    this.maskExternalWhiteBackground(cellInfoGrid)
    // 施工图必须使用真实 MARD 色板，而不是把照片里的 RGB 当成“拼豆色”。
    // 抖动负责把原图的明暗与细节分散到相邻网格，同时保证每格最终只有一种 MARD 纯色。
    const sourcePalette = this.getControlledQuantizationPalette(cellInfoGrid, this.getActivePalette())
    return this.applyFloydSteinbergDither(cellInfoGrid, sourcePalette)
  },

maskExternalWhiteBackground(cellInfoGrid) {
    const rows = cellInfoGrid.length
    const columns = cellInfoGrid[0] ? cellInfoGrid[0].length : 0
    if (!rows || !columns) {
      return
    }

    const isExternalWhiteCandidate = (info) => {
      if (!info || info.backgroundCandidate || info.hasSourceForeground || !info.samples || !info.samples.length) {
        return false
      }
      const whiteSamples = info.samples.filter((sample) => isNearWhiteRgb(sample.rgb)).length
      const whiteCoverage = whiteSamples / info.samples.length
      return whiteCoverage >= 0.68 && isNearWhiteRgb(info.average)
    }

    // 此时外部近白格还没有正式写成 backgroundCandidate，先保留独立标记，
    // 供后面的主体内部白色保护判断使用。
    cellInfoGrid.forEach((row) => {
      row.forEach((info) => {
        info.whiteBackgroundCandidate = isExternalWhiteCandidate(info)
      })
    })

    const edgeCells = []
    const enqueueEdge = (row, column) => {
      if (row < 0 || column < 0 || row >= rows || column >= columns) {
        return
      }
      const key = `${row}:${column}`
      if (edgeCells.some((cell) => cell.key === key)) {
        return
      }
      edgeCells.push({ row, column, key })
    }
    for (let column = 0; column < columns; column += 1) {
      enqueueEdge(0, column)
      enqueueEdge(rows - 1, column)
    }
    for (let row = 1; row < rows - 1; row += 1) {
      enqueueEdge(row, 0)
      enqueueEdge(row, columns - 1)
    }

    const whiteEdgeCount = edgeCells.filter((cell) => isExternalWhiteCandidate(cellInfoGrid[cell.row][cell.column])).length
    const edgeWhiteRate = edgeCells.length ? whiteEdgeCount / edgeCells.length : 0
    // 只有四周确实以近似纯白为主时才启用，避免把白色衣服、白色墙面或高光误当背景。
    if (edgeWhiteRate < 0.5) {
      return
    }

    const visited = new Set()
    const queue = []
    const enqueue = (row, column) => {
      if (row < 0 || column < 0 || row >= rows || column >= columns) {
        return
      }
      const key = `${row}:${column}`
      if (visited.has(key)) {
        return
      }
      const info = cellInfoGrid[row][column]
      if (!info.backgroundCandidate && !isExternalWhiteCandidate(info)) {
        return
      }
      visited.add(key)
      queue.push([row, column])
    }
    edgeCells.forEach((cell) => enqueue(cell.row, cell.column))

    let cursor = 0
    while (cursor < queue.length) {
      const current = queue[cursor]
      cursor += 1
      // 四向连通与像素级背景保持一致，不从对角接触处穿过单格轮廓。
      enqueue(current[0] - 1, current[1])
      enqueue(current[0] + 1, current[1])
      enqueue(current[0], current[1] - 1)
      enqueue(current[0], current[1] + 1)
    }

    // 至少保留一个非白色主体区域；整张纯白图不应被误判成“有主体的白底图”。
    const hasForeground = cellInfoGrid.some((row) => row.some((info) => {
      return !info.backgroundCandidate && !isExternalWhiteCandidate(info)
    }))
    if (!hasForeground) {
      return
    }
    // 不再用整行/整列包围范围“恢复”白格。那种做法会把人物轮廓外的
    // 凹口、手臂与身体之间的空隙也当成主体内部，正是白色异常区域的来源。
    // 这里以边缘连通结果为准：闭合轮廓内的白色自然保留，轮廓外的白底全部清空。
    visited.forEach((key) => {
      const parts = key.split(':')
      const row = Number(parts[0])
      const column = Number(parts[1])
      if (isExternalWhiteCandidate(cellInfoGrid[row][column])) {
        cellInfoGrid[row][column].backgroundCandidate = true
      }
    })
  },

createNormalizedPixels(image, targetSize) {
    const workCanvas = wx.createOffscreenCanvas
      ? wx.createOffscreenCanvas({ type: '2d', width: CANVAS_SIZE, height: CANVAS_SIZE })
      : this.canvas
    workCanvas.width = CANVAS_SIZE
    workCanvas.height = CANVAS_SIZE
    const workCtx = workCanvas.getContext('2d')
    if (typeof workCtx.imageSmoothingEnabled === 'boolean') {
      workCtx.imageSmoothingEnabled = true
    }
    workCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

    const sourceWidth = Math.max(1, Number(image.width) || CANVAS_SIZE)
    const sourceHeight = Math.max(1, Number(image.height) || CANVAS_SIZE)
    const scale = Math.min(CANVAS_SIZE / sourceWidth, CANVAS_SIZE / sourceHeight)
    const drawWidth = sourceWidth * scale
    const drawHeight = sourceHeight * scale
    const drawLeft = (CANVAS_SIZE - drawWidth) / 2
    const drawTop = (CANVAS_SIZE - drawHeight) / 2
    workCtx.drawImage(image, 0, 0, sourceWidth, sourceHeight, drawLeft, drawTop, drawWidth, drawHeight)

    const imageData = workCtx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    const backgroundInfo = this.removeEdgeBackground(imageData.data)
    // removeEdgeBackground 修改的是 ImageData，不写回画布会导致“裁剪依据”和
    // 实际重绘的内容不一致。此前白色衣服被第二次分离后出现碎块，根源就在这里。
    if (backgroundInfo.didRemoveBackground && typeof workCtx.putImageData === 'function') {
      workCtx.putImageData(imageData, 0, 0)
    } else if (backgroundInfo.didRemoveBackground) {
      backgroundInfo.didRemoveBackground = false
      backgroundInfo.confidence = 0
    }
    const sourceBounds = this.getVisiblePixelBounds(imageData.data)

    // 没有可用的离屏画布时，仍可使用已经完成安全背景分离的完整画面继续生成。
    if (!wx.createOffscreenCanvas || !sourceBounds) {
      return {
        pixels: imageData.data,
        bounds: sourceBounds || this.getFullCanvasBounds(),
        backgroundRemoved: backgroundInfo.didRemoveBackground,
        backgroundConfidence: backgroundInfo.confidence || 0,
        backgroundRgb: backgroundInfo.rgb || null
      }
    }

    const legacyLayout = this.data.layoutMode === 'legacy'
    // Retain the old framing only for regression comparison / rollback. Default
    // framing keeps two source pixels for antialiasing, not a percentage border.
    const cropBounds = legacyLayout ? this.addBoundsPadding(sourceBounds, 0.035) : {
      left: Math.max(0, sourceBounds.left - 2),
      top: Math.max(0, sourceBounds.top - 2),
      width: Math.min(CANVAS_SIZE, sourceBounds.left + sourceBounds.width + 2) - Math.max(0, sourceBounds.left - 2),
      height: Math.min(CANVAS_SIZE, sourceBounds.top + sourceBounds.height + 2) - Math.max(0, sourceBounds.top - 2)
    }
    const normalizedCanvas = wx.createOffscreenCanvas({ type: '2d', width: CANVAS_SIZE, height: CANVAS_SIZE })
    normalizedCanvas.width = CANVAS_SIZE
    normalizedCanvas.height = CANVAS_SIZE
    const normalizedCtx = normalizedCanvas.getContext('2d')
    if (typeof normalizedCtx.imageSmoothingEnabled === 'boolean') {
      normalizedCtx.imageSmoothingEnabled = true
    }
    normalizedCtx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

    // 保持主体原始比例，只缩放不拉伸。背景已在上一步一次性安全处理完毕，
    // 不在缩放后重复做背景分离，避免把白纱、白衣和眼白误当成空洞。
    // Compensate for rectangular grid sampling: each final bead is square even
    // though the intermediate Canvas is square. Fit, never cover or stretch.
    const columns = targetSize ? targetSize.columns : this.data.sizeMode === 'board' ? Math.max(8, Math.min(160, Number(this.data.gridWidth) || 64)) : 1
    const rows = targetSize ? targetSize.rows : this.data.sizeMode === 'board' ? Math.max(8, Math.min(160, Number(this.data.gridHeight) || 64)) : 1
    const availableSize = CANVAS_SIZE - (legacyLayout ? NORMALIZED_INSET * 2 : 0)
    const cropScale = legacyLayout
      ? Math.min(availableSize / cropBounds.width, availableSize / cropBounds.height)
      : Math.min(columns / cropBounds.width, rows / cropBounds.height)
    const targetWidth = cropBounds.width * cropScale * (legacyLayout ? 1 : CANVAS_SIZE / columns)
    const targetHeight = cropBounds.height * cropScale * (legacyLayout ? 1 : CANVAS_SIZE / rows)
    const targetLeft = (CANVAS_SIZE - targetWidth) / 2
    const targetTop = (CANVAS_SIZE - targetHeight) / 2
    normalizedCtx.drawImage(
      workCanvas,
      cropBounds.left,
      cropBounds.top,
      cropBounds.width,
      cropBounds.height,
      targetLeft,
      targetTop,
      targetWidth,
      targetHeight
    )
    const normalizedData = normalizedCtx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    return {
      pixels: normalizedData.data,
      bounds: this.getVisiblePixelBounds(normalizedData.data) || this.getFullCanvasBounds(),
      backgroundRemoved: backgroundInfo.didRemoveBackground,
      backgroundConfidence: backgroundInfo.confidence || 0,
      backgroundRgb: backgroundInfo.rgb || null
    }
  },

getFullCanvasBounds() {
    return { left: 0, top: 0, right: CANVAS_SIZE - 1, bottom: CANVAS_SIZE - 1, width: CANVAS_SIZE, height: CANVAS_SIZE }
  },

removeEdgeBackground(pixels) {
    const segmentSize = SEGMENT_SIZE
    const cellCount = segmentSize * segmentSize
    const samples = new Array(cellCount)
    const colorBins = {}
    const borderSamples = []
    const addBorderSample = (sample) => {
      // 只统计边缘；不能让人物肤色、衣服或画面中央的大色块来决定“背景色”。
      const key = `${Math.floor(sample.red / 24)}:${Math.floor(sample.green / 24)}:${Math.floor(sample.blue / 24)}`
      if (!colorBins[key]) {
        colorBins[key] = { count: 0, red: 0, green: 0, blue: 0 }
      }
      colorBins[key].count += 1
      colorBins[key].red += sample.red
      colorBins[key].green += sample.green
      colorBins[key].blue += sample.blue
      borderSamples.push(sample)
    }

    for (let row = 0; row < segmentSize; row += 1) {
      for (let column = 0; column < segmentSize; column += 1) {
        const x = Math.min(CANVAS_SIZE - 1, Math.floor((column + 0.5) * CANVAS_SIZE / segmentSize))
        const y = Math.min(CANVAS_SIZE - 1, Math.floor((row + 0.5) * CANVAS_SIZE / segmentSize))
        const index = (y * CANVAS_SIZE + x) * 4
        const sample = {
          red: pixels[index],
          green: pixels[index + 1],
          blue: pixels[index + 2],
          alpha: pixels[index + 3]
        }
        samples[row * segmentSize + column] = sample
        const isBorder = row < 3 || column < 3 || row >= segmentSize - 3 || column >= segmentSize - 3
        if (sample.alpha >= 28) {
          if (isBorder) {
            addBorderSample(sample)
          }
        }
      }
    }

    const emptyResult = { didRemoveBackground: false, confidence: 0, rgb: null }
    if (borderSamples.length < Math.max(32, segmentSize / 2)) {
      return emptyResult
    }
    let dominant = null
    Object.keys(colorBins).forEach((key) => {
      const bin = colorBins[key]
      if (!dominant || bin.count > dominant.count) {
        dominant = {
          count: bin.count,
          red: bin.red,
          green: bin.green,
          blue: bin.blue
        }
      }
    })
    if (!dominant || dominant.count < Math.max(12, borderSamples.length * 0.22)) {
      return emptyResult
    }

    let background = [dominant.red / dominant.count, dominant.green / dominant.count, dominant.blue / dominant.count]
    // 对同一边缘背景再次求均值，抵抗 JPG 压缩和细微的灯光变化。
    const coarseMatches = borderSamples.filter((sample) => this.rgbDistance([sample.red, sample.green, sample.blue], background) <= 42)
    if (coarseMatches.length) {
      background = [0, 1, 2].map((channel) => Math.round(coarseMatches.reduce((sum, sample) => sum + [sample.red, sample.green, sample.blue][channel], 0) / coarseMatches.length))
    }
    let spreadTotal = 0
    let spreadCount = 0
    borderSamples.forEach((sample) => {
      const distance = this.rgbDistance([sample.red, sample.green, sample.blue], background)
      if (distance <= 54) {
        spreadTotal += distance
        spreadCount += 1
      }
    })
    const averageSpread = spreadCount ? spreadTotal / spreadCount : 0
    const edgeMatchRate = spreadCount / borderSamples.length
    // 边缘颜色不够统一时，背景分离比保留原图更危险，直接跳过。
    if (edgeMatchRate < 0.62 || averageSpread > 28) {
      return emptyResult
    }
    const backgroundLuminance = background[0] * 0.299 + background[1] * 0.587 + background[2] * 0.114
    const backgroundChroma = Math.max(background[0], background[1], background[2]) - Math.min(background[0], background[1], background[2])
    // 只有接近纯白的背景才允许被擦除。粉色、蓝色、绿色等有色背景即使边缘很统一，
    // 也必须作为真实拼豆区域保留，不能因为“像一整块背景”就被误判为空白。
    const nearWhiteBackground = backgroundLuminance >= 240
      && backgroundChroma <= 18
      && Math.min(background[0], background[1], background[2]) >= 236
    if (!nearWhiteBackground) {
      return emptyResult
    }
    const tolerance = Math.max(18, Math.min(nearWhiteBackground ? 34 : 44, 18 + averageSpread * 1.45))
    const candidate = new Uint8Array(cellCount)
    const visited = new Uint8Array(cellCount)
    const queue = []
    const isBackgroundLike = (sample) => sample.alpha < 28 || this.rgbDistance([sample.red, sample.green, sample.blue], background) <= tolerance

    samples.forEach((sample, index) => {
      if (isBackgroundLike(sample)) {
        candidate[index] = 1
      }
    })
    const enqueue = (row, column) => {
      if (row < 0 || column < 0 || row >= segmentSize || column >= segmentSize) {
        return
      }
      const index = row * segmentSize + column
      if (!candidate[index] || visited[index]) {
        return
      }
      visited[index] = 1
      queue.push(index)
    }
    for (let i = 0; i < segmentSize; i += 1) {
      enqueue(0, i)
      enqueue(segmentSize - 1, i)
      enqueue(i, 0)
      enqueue(i, segmentSize - 1)
    }
    let cursor = 0
    while (cursor < queue.length) {
      const index = queue[cursor]
      const row = Math.floor(index / segmentSize)
      const column = index % segmentSize
      cursor += 1
      enqueue(row - 1, column)
      enqueue(row + 1, column)
      enqueue(row, column - 1)
      enqueue(row, column + 1)
    }

    let visitedCount = 0
    let opaqueCount = 0
    for (let row = 0; row < segmentSize; row += 1) {
      for (let column = 0; column < segmentSize; column += 1) {
        const index = row * segmentSize + column
        if (samples[index].alpha >= 28) {
          opaqueCount += 1
        }
        if (visited[index]) {
          visitedCount += 1
        }
      }
    }
    const removedRate = opaqueCount ? visitedCount / opaqueCount : 0
    // 纯白背景经常会延伸到画面中央，尤其是主体较小或四周留白较多的照片；
    // 这本身不是白衣/白纱与背景粘连的证据。真正的背景只会通过“边缘连通”被移除，
    // 因此不能再用 centralBackgroundRate 直接放弃去背景，否则整片白底会被量化成 H1/H2。
    // 纯白背景的主体有时已经铺满画布，只剩窄边；只要四周颜色高度一致，
    // 仍应允许移除这部分边缘背景，否则白底会在量化阶段变成 H1/H2 色号。
    // 后面的前景连通性检查会继续拦截“整张图都被误删”的情况。
    const minimumRemovedRate = nearWhiteBackground && edgeMatchRate >= 0.82 ? 0.04 : 0.16
    if (removedRate < minimumRemovedRate) {
      return emptyResult
    }

    // 背景之外的像素如果已经碎成许多小岛，也不适合继续去背景。
    // 这类往往是复杂照片、拼贴图或边缘噪点，而不是一个清晰的独立主体。
    const foregroundVisited = new Uint8Array(cellCount)
    let foregroundCount = 0
    let largestForeground = 0
    const enqueueForeground = (row, column, component) => {
      if (row < 0 || column < 0 || row >= segmentSize || column >= segmentSize) {
        return
      }
      const index = row * segmentSize + column
      if (foregroundVisited[index] || visited[index] || samples[index].alpha < 28) {
        return
      }
      foregroundVisited[index] = 1
      component.push(index)
    }
    for (let index = 0; index < cellCount; index += 1) {
      if (visited[index] || samples[index].alpha < 28 || foregroundVisited[index]) {
        continue
      }
      const component = []
      enqueueForeground(Math.floor(index / segmentSize), index % segmentSize, component)
      let componentCursor = 0
      while (componentCursor < component.length) {
        const current = component[componentCursor]
        componentCursor += 1
        const row = Math.floor(current / segmentSize)
        const column = current % segmentSize
        enqueueForeground(row - 1, column, component)
        enqueueForeground(row + 1, column, component)
        enqueueForeground(row, column - 1, component)
        enqueueForeground(row, column + 1, component)
      }
      foregroundCount += component.length
      largestForeground = Math.max(largestForeground, component.length)
    }
    if (!foregroundCount || largestForeground / foregroundCount < 0.38) {
      return emptyResult
    }

    // 白裙、白袖和白色高光可能在分析网格层面与外部白底相连。
    // 旧逻辑用整行/整列的首尾主体范围来保护白格，范围一大就会把人物轮廓外
    // 的凹口、四肢之间的空隙也保留下来。改成“近距离四向闭合”保护：只有白格
    // 四周很近都能看到真实前景，才认为它可能是白色衣物内部；开放到边缘的白底
    // 不再被保护，后续会被透明化。
    const localForegroundRadius = Math.max(6, Math.round(segmentSize * 0.025))
    const isForegroundSample = (row, column) => {
      if (row < 0 || column < 0 || row >= segmentSize || column >= segmentSize) {
        return false
      }
      const index = row * segmentSize + column
      return !candidate[index] && samples[index].alpha >= 28
    }
    const hasForegroundTowards = (row, column, rowOffset, columnOffset) => {
      for (let distance = 1; distance <= localForegroundRadius; distance += 1) {
        if (isForegroundSample(row + rowOffset * distance, column + columnOffset * distance)) {
          return true
        }
      }
      return false
    }
    const protectedInterior = new Uint8Array(cellCount)
    for (let row = 0; row < segmentSize; row += 1) {
      for (let column = 0; column < segmentSize; column += 1) {
        const index = row * segmentSize + column
        if (!visited[index]) {
          continue
        }
        const enclosedHorizontally = hasForegroundTowards(row, column, 0, -1)
          && hasForegroundTowards(row, column, 0, 1)
        const enclosedVertically = hasForegroundTowards(row, column, -1, 0)
          && hasForegroundTowards(row, column, 1, 0)
        if (enclosedHorizontally && enclosedVertically) {
          protectedInterior[index] = 1
        }
      }
    }

    // 粗网格只能提出候选区域，不能证明像素与外部连通。5px 分析格可能跨过
    // 1px 发丝/轮廓，直接擦除整格里的白色会在主体上打洞。再沿真实像素四向
    // 连通核验，只有能从画布边缘走到的候选白底才允许透明化。
    const pixelTolerance = Math.max(14, tolerance * 0.7)
    const pixelCount = CANVAS_SIZE * CANVAS_SIZE
    const pixelVisited = new Uint8Array(pixelCount)
    const pixelQueue = new Int32Array(pixelCount)
    let pixelQueueLength = 0
    const enqueuePixel = (x, y) => {
      if (x < 0 || y < 0 || x >= CANVAS_SIZE || y >= CANVAS_SIZE) return
      const index = y * CANVAS_SIZE + x
      if (pixelVisited[index]) return
      pixelVisited[index] = 1
      const pixelIndex = index * 4
      if (pixels[pixelIndex + 3] >= 28) {
        const segmentIndex = Math.floor(y * segmentSize / CANVAS_SIZE) * segmentSize
          + Math.floor(x * segmentSize / CANVAS_SIZE)
        if (!visited[segmentIndex] || protectedInterior[segmentIndex]) return
        const red = pixels[pixelIndex] - background[0]
        const green = pixels[pixelIndex + 1] - background[1]
        const blue = pixels[pixelIndex + 2] - background[2]
        if (red * red + green * green + blue * blue > pixelTolerance * pixelTolerance) return
      }
      pixels[pixelIndex + 3] = 0
      pixelQueue[pixelQueueLength++] = index
    }
    for (let i = 0; i < CANVAS_SIZE; i += 1) {
      enqueuePixel(i, 0)
      enqueuePixel(i, CANVAS_SIZE - 1)
      enqueuePixel(0, i)
      enqueuePixel(CANVAS_SIZE - 1, i)
    }
    for (let cursor = 0; cursor < pixelQueueLength; cursor += 1) {
      const index = pixelQueue[cursor]
      const x = index % CANVAS_SIZE
      const y = Math.floor(index / CANVAS_SIZE)
      enqueuePixel(x - 1, y)
      enqueuePixel(x + 1, y)
      enqueuePixel(x, y - 1)
      enqueuePixel(x, y + 1)
    }
    const consistency = Math.max(0, 1 - averageSpread / 36)
    const confidence = Math.min(1, edgeMatchRate * 0.68 + consistency * 0.22 + Math.min(1, removedRate / 0.55) * 0.1)
    return { didRemoveBackground: true, confidence, rgb: background }
  },

getVisiblePixelBounds(pixels) {
    let left = CANVAS_SIZE
    let top = CANVAS_SIZE
    let right = -1
    let bottom = -1
    // 每 2 像素扫描一次已足够定位拼豆的主体边界，避免在手机端做不必要的重复计算。
    for (let y = 0; y < CANVAS_SIZE; y += 2) {
      for (let x = 0; x < CANVAS_SIZE; x += 2) {
        const alpha = pixels[(y * CANVAS_SIZE + x) * 4 + 3]
        if (alpha < 28) {
          continue
        }
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
    if (right < left || bottom < top) {
      return null
    }
    return {
      left,
      top,
      right,
      bottom,
      width: right - left + 2,
      height: bottom - top + 2
    }
  },

addBoundsPadding(bounds, ratio) {
    const padding = Math.max(8, Math.round(Math.max(bounds.width, bounds.height) * ratio))
    const left = Math.max(0, bounds.left - padding)
    const top = Math.max(0, bounds.top - padding)
    const right = Math.min(CANVAS_SIZE - 1, bounds.right + padding)
    const bottom = Math.min(CANVAS_SIZE - 1, bounds.bottom + padding)
    return {
      left,
      top,
      right,
      bottom,
      width: right - left + 1,
      height: bottom - top + 1
    }
  },

resolveGridSize(pixels, bounds) {
    const safeBounds = bounds || this.getFullCanvasBounds()
    const ratio = Math.max(0.18, Math.min(5.5, safeBounds.width / Math.max(1, safeBounds.height)))
    const columns = Math.max(8, Math.min(160, Number(this.data.gridWidth) || 64))
    if (this.data.sizeMode === 'image') {
      return {
        columns,
        rows: Math.max(8, Math.min(160, Math.round(columns / ratio)))
      }
    }
    return {
      columns,
      rows: Math.max(8, Math.min(160, Number(this.data.gridHeight) || 64))
    }
  },

buildDitherPalette(cellInfoGrid) {
    const cellCount = cellInfoGrid.length * (cellInfoGrid[0] ? cellInfoGrid[0].length : 0)
    const requested = Number(this.data.paletteSpec) || 221
    let maxColors = cellCount <= 1600 ? 32 : cellCount <= 4096 ? 48 : cellCount <= 6400 ? 64 : cellCount <= 10000 ? 80 : 96
    if (this.data.threshold === 'light') {
      maxColors = Math.round(maxColors * 0.88)
    } else if (this.data.threshold === 'medium') {
      maxColors = Math.round(maxColors * 0.74)
    } else if (this.data.threshold === 'strong') {
      maxColors = Math.round(maxColors * 0.58)
    } else if (this.data.threshold === 'veryStrong') {
      maxColors = Math.round(maxColors * 0.42)
    }
    maxColors = Math.max(12, Math.min(requested, maxColors))
    const bins = {}
    cellInfoGrid.forEach((row) => {
      row.forEach((info) => {
        if (info.backgroundCandidate) {
          return
        }
        const rgb = info.average
        const key = `${Math.floor(rgb[0] / 24)}:${Math.floor(rgb[1] / 24)}:${Math.floor(rgb[2] / 24)}`
        if (!bins[key]) {
          bins[key] = { count: 0, red: 0, green: 0, blue: 0 }
        }
        bins[key].count += 1
        bins[key].red += rgb[0]
        bins[key].green += rgb[1]
        bins[key].blue += rgb[2]
      })
    })
    const candidates = Object.keys(bins).map((key) => {
      const bin = bins[key]
      return {
        count: bin.count,
        rgb: [Math.round(bin.red / bin.count), Math.round(bin.green / bin.count), Math.round(bin.blue / bin.count)]
      }
    }).sort((a, b) => b.count - a.count)
    const selected = []
    const tryAdd = (candidate, minimumDistance) => {
      const isFarEnough = selected.every((existing) => this.rgbDistance(existing.rgb, candidate.rgb) >= minimumDistance)
      if (isFarEnough && selected.length < maxColors) {
        selected.push(candidate)
      }
    }
    candidates.forEach((candidate) => tryAdd(candidate, 20))
    // 保护很少但关键的深色五官和高饱和配饰，不让它们被大面积肤色或衣服吞掉。
    candidates.filter((candidate) => {
      const rgb = candidate.rgb
      const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
      return luminance < 62 || Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]) > 145
    }).forEach((candidate) => tryAdd(candidate, 14))
    candidates.forEach((candidate) => tryAdd(candidate, 0))
    if (!selected.length) {
      selected.push({ rgb: [128, 128, 128], count: 1 })
    }
    return selected
  },

getControlledQuantizationPalette(cellInfoGrid, palette) {
    const available = palette && palette.length ? palette : PALETTE
    const cellCount = cellInfoGrid.length * (cellInfoGrid[0] ? cellInfoGrid[0].length : 0)
    // 小画板每一格承载的信息更多，适当放宽实际使用的色号上限，
    // 避免肤色、眼白、阴影和衣服被压成同一个近似色；仍受用户选择的 MARD 色板限制。
    let maxColors = cellCount <= 1024 ? 28 : cellCount <= 2704 ? 44 : cellCount <= 4096 ? 56 : cellCount <= 6084 ? 64 : 80
    const reductions = { none: 1, light: 0.88, medium: 0.76, strong: 0.64, veryStrong: 0.52 }
    maxColors = Math.max(16, Math.round(maxColors * (reductions[this.data.threshold] || 1)))
    maxColors = Math.min(maxColors, available.length)

    const scores = {}
    cellInfoGrid.forEach((row) => {
      row.forEach((info) => {
        if (info.backgroundCandidate) {
          return
        }
        const skinHint = Boolean(info.skinLike || this.isSkinToneRgb(info.average))
        const target = this.toneMapRgb(info.average, skinHint)
        const nearest = this.findNearestRgb(target, available, { skinHint })
        if (!scores[nearest.code]) {
          scores[nearest.code] = { color: nearest, score: 0 }
        }
        const detailBoost = cellCount <= 2704 ? 3.4 : cellCount <= 4096 ? 3.0 : cellCount <= 6084 ? 2.6 : 2.2
        scores[nearest.code].score += info.detailRgb ? detailBoost : 1
      })
    })

    const ranked = Object.keys(scores)
      .map((code) => scores[code])
      .sort((first, second) => second.score - first.score)
    const withScore = available.map((color) => scores[color.code] || { color, score: 0 })
    const selected = []
    const addIfUseful = (entry, minimumDistance) => {
      const candidate = entry && (entry.color || entry)
      if (!candidate || selected.length >= maxColors || selected.some((color) => color.code === candidate.code)) {
        return
      }
      const farEnough = selected.every((color) => this.rgbDistance(color.rgb, candidate.rgb) >= minimumDistance)
      if (farEnough) {
        selected.push(candidate)
      }
    }

    // 只有原图里确实存在足够深的线稿/五官时，才把 H7 放进候选色板。
    // 过去无条件加入纯黑，会让浅色照片的边缘不必要地向黑色跳变。
    const outline = available.find((color) => color.code === 'H7')
    const hasDeepFeature = cellInfoGrid.some((row) => row.some((info) => {
      const rgb = info.detailRgb || info.average
      return rgb && rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 < 58
    }))
    if (hasDeepFeature) {
      addIfUseful(outline, 0)
    }
    // 所有色号规格都预留肤色锚点。221 色同样会先压缩为实际用色子集，
    // 如果肤色只占画面一小块，单靠频率排序仍可能把浅肤色淘汰并跳到黄色。
    SKIN_TONE_ANCHOR_CODES.forEach((code) => {
      addIfUseful(available.find((color) => color.code === code), 0)
    })
    withScore
      .filter((entry) => entry.score > 0)
      .sort((first, second) => {
        const firstLuminance = first.color.rgb[0] * 0.299 + first.color.rgb[1] * 0.587 + first.color.rgb[2] * 0.114
        const secondLuminance = second.color.rgb[0] * 0.299 + second.color.rgb[1] * 0.587 + second.color.rgb[2] * 0.114
        return firstLuminance - secondLuminance
      })
      .slice(0, 4)
      .forEach((entry) => addIfUseful(entry, 12))
    withScore
      .filter((entry) => entry.score > 0)
      .sort((first, second) => {
        const firstChroma = Math.max(...first.color.rgb) - Math.min(...first.color.rgb)
        const secondChroma = Math.max(...second.color.rgb) - Math.min(...second.color.rgb)
        return secondChroma - firstChroma
      })
      .slice(0, 8)
      .forEach((entry) => addIfUseful(entry, 18))

    // 按实际出现频率补齐，最小间距过滤掉几乎相同的相邻色阶。
    ranked.forEach((entry) => addIfUseful(entry, 18))
    if (selected.length < Math.min(8, maxColors)) {
      available.forEach((color) => addIfUseful({ color, score: 0 }, 12))
    }
    return selected.length ? selected : available
  },

applyFloydSteinbergDither(cellInfoGrid, sourcePalette) {
    const rows = cellInfoGrid.length
    const columns = cellInfoGrid[0] ? cellInfoGrid[0].length : 0
    const cellCount = rows * columns
    // 大尺寸已经有足够的真实像素格，不需要把误差扩散得太远；否则会形成不自然的
    // “椒盐噪点”。小尺寸仍保留更明显的抖动，以保护明暗层次。
    const ditherScale = cellCount >= 9000
      ? 0.24
      : cellCount >= 6000
        ? 0.32
        : cellCount >= 2704
          ? 0.42
          : DITHER_ERROR_SCALE
    const working = cellInfoGrid.map((row) => row.map((info) => info.backgroundCandidate ? null : [info.average[0], info.average[1], info.average[2]]))
    const grid = cellInfoGrid.map((row) => row.map((info) => info.backgroundCandidate ? EMPTY_COLOR : null))
    const addError = (row, column, error, weight) => {
      if (row < 0 || column < 0 || row >= rows || column >= columns || !working[row][column]) {
        return
      }
      const targetInfo = cellInfoGrid[row][column]
      // 误差扩散可以保护普通区域的明暗，但不能把黄色/橙色的色差带进脸和手臂。
      // 肤色格只接收近似中性的亮度误差，保留原始红绿蓝比例。
      const safeError = targetInfo && targetInfo.skinLike
        ? (() => {
          const luminanceError = error[0] * 0.299 + error[1] * 0.587 + error[2] * 0.114
          return [luminanceError, luminanceError, luminanceError]
        })()
        : error
      working[row][column][0] = Math.max(0, Math.min(255, working[row][column][0] + safeError[0] * weight))
      working[row][column][1] = Math.max(0, Math.min(255, working[row][column][1] + safeError[1] * weight))
      working[row][column][2] = Math.max(0, Math.min(255, working[row][column][2] + safeError[2] * weight))
    }

    for (let row = 0; row < rows; row += 1) {
      const direction = row % 2 === 0 ? 1 : -1
      let column = direction === 1 ? 0 : columns - 1
      while (column >= 0 && column < columns) {
        const current = working[row][column]
        if (current) {
          const info = cellInfoGrid[row][column]
          const skinHint = Boolean(info.skinLike && (!info.detailRgb || (info.detailCoverage || 0) < 0.14))
          let sourceRgb = this.toneMapRgb(current, skinHint)
          // 小面积深色五官/描边优先级更高；仅在该格明显存在深色细节时启用。
          if (info.detailRgb) {
            const currentLuminance = sourceRgb[0] * 0.299 + sourceRgb[1] * 0.587 + sourceRgb[2] * 0.114
            const detailLuminance = info.detailRgb[0] * 0.299 + info.detailRgb[1] * 0.587 + info.detailRgb[2] * 0.114
            if (currentLuminance - detailLuminance > 58) {
              // 深色在格内覆盖得越多，才越明显地向原图深色靠拢。
              // 这能保住瞳孔、鼻尖和嘴线，同时避免一根胡须/一粒噪点把整格染成 H7。
              const detailWeight = Math.min(0.68, Math.max(0.3, 0.16 + (info.detailCoverage || 0) * 1.15))
              sourceRgb = info.detailRgb.map((value, index) => Math.round(value * detailWeight + sourceRgb[index] * (1 - detailWeight)))
            }
          }
          const selected = this.findNearestRgb(sourceRgb, sourcePalette, { skinHint })
          grid[row][column] = this.makeMardColor(selected, sourceRgb)
          // 误差只用于邻格的色号选择，不会写回画布，因此不会产生半透明或混色格。
          // 五官、描线等深色结构不向四周强烈扩散误差，避免眼睛边缘长出杂乱黑点。
          // 肤色区域在 72 色下最容易被相邻黄色吸走；降低其误差扩散，
          // 防止上一格的量化误差把下一格推过肤色/黄色的色相边界。
          const localDitherScale = skinHint
            ? Math.min(0.08, ditherScale * 0.22)
            : info.detailRgb
            ? ditherScale * 0.42
            : info.edgeStrength > 110 && cellCount <= 4096
              ? ditherScale * 0.68
              : ditherScale
          const error = [
            (sourceRgb[0] - selected.rgb[0]) * localDitherScale,
            (sourceRgb[1] - selected.rgb[1]) * localDitherScale,
            (sourceRgb[2] - selected.rgb[2]) * localDitherScale
          ]
          addError(row, column + direction, error, 7 / 16)
          addError(row + 1, column - direction, error, 3 / 16)
          addError(row + 1, column, error, 5 / 16)
          addError(row + 1, column + direction, error, 1 / 16)
        }
        column += direction
      }
    }
    return this.stabilizeSkinColors(grid, cellInfoGrid, sourcePalette)
  },

stabilizeSkinColors(grid, cellInfoGrid, palette) {
    const rows = grid.length
    const columns = grid[0] ? grid[0].length : 0
    const skinPalette = this.getSkinPaletteCandidates(palette)
    if (!rows || !columns || !skinPalette.length) {
      return grid
    }
    const result = grid.map((row) => row.slice())
    const neighborOffsets = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    const inBounds = (row, column) => row >= 0 && column >= 0 && row < rows && column < columns
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const info = cellInfoGrid[row][column]
        const color = result[row][column]
        if (!info || !color || color.empty) {
          continue
        }
        const skinNeighbors = neighborOffsets.reduce((count, offset) => {
          const neighborRow = row + offset[0]
          const neighborColumn = column + offset[1]
          if (!inBounds(neighborRow, neighborColumn)) {
            return count
          }
          const neighbor = cellInfoGrid[neighborRow][neighborColumn]
          return count + (neighbor && neighbor.skinLike ? 1 : 0)
        }, 0)
        const directSkin = Boolean(info.skinLike)
        const surroundedSkin = skinNeighbors >= 2
        if ((!directSkin && !surroundedSkin) || !this.isStrongYellowRgb(color.rgb)) {
          continue
        }
        const target = this.toneMapRgb(info.average, true)
        const replacement = this.findNearestRgb(target, skinPalette, { skinHint: true })
        result[row][column] = this.makeMardColor(replacement, info.average)
      }
    }
    return result
  },

findConnectedBackgroundCells(cellInfoGrid) {
    const rows = cellInfoGrid.length
    const columns = cellInfoGrid[0] ? cellInfoGrid[0].length : 0
    const visited = new Set()
    const queue = []
    const enqueue = (row, column) => {
      if (row < 0 || column < 0 || row >= rows || column >= columns) {
        return
      }
      const key = `${row}:${column}`
      if (visited.has(key) || !cellInfoGrid[row][column].backgroundCandidate) {
        return
      }
      visited.add(key)
      queue.push([row, column])
    }

    for (let column = 0; column < columns; column += 1) {
      enqueue(0, column)
      enqueue(rows - 1, column)
    }
    for (let row = 0; row < rows; row += 1) {
      enqueue(row, 0)
      enqueue(row, columns - 1)
    }

    let cursor = 0
    while (cursor < queue.length) {
      const currentCell = queue[cursor]
      const row = currentCell[0]
      const column = currentCell[1]
      cursor += 1
      enqueue(row - 1, column)
      enqueue(row + 1, column)
      enqueue(row, column - 1)
      enqueue(row, column + 1)
    }
    return visited
  },

keepInteriorWhiteCells(cellInfoGrid, backgroundCells) {
    const rows = cellInfoGrid.length
    const columns = cellInfoGrid[0] ? cellInfoGrid[0].length : 0
    const rowInside = []
    const columnInside = []

    for (let row = 0; row < rows; row += 1) {
      let first = -1
      let last = -1
      for (let column = 0; column < columns; column += 1) {
        const info = cellInfoGrid[row][column]
        if (!info.backgroundCandidate && !info.whiteBackgroundCandidate) {
          if (first < 0) {
            first = column
          }
          last = column
        }
      }
      rowInside[row] = { first, last }
    }

    for (let column = 0; column < columns; column += 1) {
      let first = -1
      let last = -1
      for (let row = 0; row < rows; row += 1) {
        const info = cellInfoGrid[row][column]
        if (!info.backgroundCandidate && !info.whiteBackgroundCandidate) {
          if (first < 0) {
            first = row
          }
          last = row
        }
      }
      columnInside[column] = { first, last }
    }

    backgroundCells.forEach((key) => {
      const parts = key.split(':')
      const row = Number(parts[0])
      const column = Number(parts[1])
      const horizontal = rowInside[row]
      const vertical = columnInside[column]
      const isInsideHorizontal = horizontal && horizontal.first >= 0 && column > horizontal.first && column < horizontal.last
      const isInsideVertical = vertical && vertical.first >= 0 && row > vertical.first && row < vertical.last
      if (isInsideHorizontal && isInsideVertical) {
        backgroundCells.delete(key)
      }
    })
  },

applyCartoonOutline(grid, normalization) {
    const rows = grid.length
    const columns = grid[0] ? grid[0].length : 0
    const hasEmptyBackground = grid.some((row) => row.some((color) => color.empty))
    if (!hasEmptyBackground || !normalization || !normalization.backgroundRemoved || normalization.backgroundConfidence < 0.7) {
      return grid
    }
    const outlineColor = this.getOutlineColor()
    const outlined = grid.map((row) => row.slice())
    // 只把“与画布外部相连”的空白当作背景；主体内部的白色缺口、泪水和衣服镂空不描黑。
    const outsideEmpty = new Set()
    const queue = []
    const enqueueEmpty = (row, column) => {
      if (row < 0 || column < 0 || row >= rows || column >= columns || !grid[row][column].empty) {
        return
      }
      const key = `${row}:${column}`
      if (outsideEmpty.has(key)) {
        return
      }
      outsideEmpty.add(key)
      queue.push([row, column])
    }
    for (let column = 0; column < columns; column += 1) {
      enqueueEmpty(0, column)
      enqueueEmpty(rows - 1, column)
    }
    for (let row = 0; row < rows; row += 1) {
      enqueueEmpty(row, 0)
      enqueueEmpty(row, columns - 1)
    }
    let queueIndex = 0
    while (queueIndex < queue.length) {
      const current = queue[queueIndex]
      queueIndex += 1
      const neighbors = [
        [current[0] - 1, current[1]],
        [current[0] + 1, current[1]],
        [current[0], current[1] - 1],
        [current[0], current[1] + 1]
      ]
      neighbors.forEach((neighbor) => enqueueEmpty(neighbor[0], neighbor[1]))
    }
    const adjacentToEmpty = (row, column) => {
      const neighbors = [
        [row - 1, column],
        [row + 1, column],
        [row, column - 1],
        [row, column + 1]
      ]
      return neighbors.some((neighbor) => {
        const neighborRow = neighbor[0]
        const neighborColumn = neighbor[1]
        return neighborRow >= 0 && neighborColumn >= 0 && neighborRow < rows && neighborColumn < columns && outsideEmpty.has(`${neighborRow}:${neighborColumn}`)
      })
    }

    // 先标记连通主体。只有足够大的主体才允许强化边缘，避免背景噪点变成黑色碎片。
    const componentIds = Array.from({ length: rows }, () => Array(columns).fill(-1))
    const componentSizes = []
    let componentId = 0
    let filledCount = 0
    const enqueueFilled = (row, column, queue) => {
      if (row < 0 || column < 0 || row >= rows || column >= columns || grid[row][column].empty || componentIds[row][column] >= 0) {
        return
      }
      componentIds[row][column] = componentId
      queue.push([row, column])
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (grid[row][column].empty || componentIds[row][column] >= 0) {
          continue
        }
        const queue = []
        enqueueFilled(row, column, queue)
        let cursor = 0
        while (cursor < queue.length) {
          const current = queue[cursor]
          cursor += 1
          enqueueFilled(current[0] - 1, current[1], queue)
          enqueueFilled(current[0] + 1, current[1], queue)
          enqueueFilled(current[0], current[1] - 1, queue)
          enqueueFilled(current[0], current[1] + 1, queue)
        }
        componentSizes[componentId] = queue.length
        filledCount += queue.length
        componentId += 1
      }
    }
    const minimumComponentSize = Math.max(5, Math.round(filledCount * 0.003))
    grid.forEach((row, rowIndex) => {
      row.forEach((color, columnIndex) => {
        if (color.empty || componentSizes[componentIds[rowIndex][columnIndex]] < minimumComponentSize || !adjacentToEmpty(rowIndex, columnIndex) || this.isDarkOutlineColor(color)) {
          return
        }
        const sourceRgb = color.sourceRgb || color.rgb
        const sourceLuminance = sourceRgb[0] * 0.299 + sourceRgb[1] * 0.587 + sourceRgb[2] * 0.114
        // 只有原图这一格本身已接近深色线稿时才加深到 H7；亮色的衣服、皮肤、白纱
        // 保持自己的 MARD 色号，外轮廓由原图真实的深色格承担。
        if (sourceLuminance < 62) {
          outlined[rowIndex][columnIndex] = this.makeMardColor(outlineColor, sourceRgb)
        }
      })
    })
    return this.fillSmallEnclosedHoles(outlined, outsideEmpty)
  },

fillSmallEnclosedHoles(grid, outsideEmpty) {
    const rows = grid.length
    const columns = grid[0] ? grid[0].length : 0
    const filled = grid.map((row) => row.slice())
    const visited = new Set()
    const maxHoleCells = 4
    const directions = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1]
    ]
    const surroundingDirections = [
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],           [0, 1],
      [1, -1],  [1, 0],  [1, 1]
    ]

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const startKey = `${row}:${column}`
        if (!grid[row][column].empty || outsideEmpty.has(startKey) || visited.has(startKey)) {
          continue
        }

        const component = [[row, column]]
        visited.add(startKey)
        let cursor = 0
        while (cursor < component.length) {
          const [currentRow, currentColumn] = component[cursor]
          cursor += 1
          directions.forEach(([rowOffset, columnOffset]) => {
            const nextRow = currentRow + rowOffset
            const nextColumn = currentColumn + columnOffset
            if (nextRow < 0 || nextColumn < 0 || nextRow >= rows || nextColumn >= columns) {
              return
            }
            const nextKey = `${nextRow}:${nextColumn}`
            if (!grid[nextRow][nextColumn].empty || outsideEmpty.has(nextKey) || visited.has(nextKey)) {
              return
            }
            visited.add(nextKey)
            component.push([nextRow, nextColumn])
          })
        }

        if (component.length > maxHoleCells) {
          continue
        }

        const votes = new Map()
        let opensDiagonallyToBackground = false
        component.forEach(([cellRow, cellColumn]) => {
          surroundingDirections.forEach(([rowOffset, columnOffset]) => {
            const neighborRow = cellRow + rowOffset
            const neighborColumn = cellColumn + columnOffset
            if (neighborRow < 0 || neighborColumn < 0 || neighborRow >= rows || neighborColumn >= columns) {
              opensDiagonallyToBackground = true
              return
            }
            const neighborKey = `${neighborRow}:${neighborColumn}`
            if (outsideEmpty.has(neighborKey)) {
              opensDiagonallyToBackground = true
              return
            }
            const color = grid[neighborRow][neighborColumn]
            if (color.empty) {
              return
            }
            const vote = votes.get(color.code) || { count: 0, color }
            vote.count += 1
            votes.set(color.code, vote)
          })
        })

        if (opensDiagonallyToBackground || !votes.size) {
          continue
        }
        const winner = Array.from(votes.values()).reduce((best, vote) => (
          !best || vote.count > best.count ? vote : best
        ), null).color
        const repairedColor = this.makeMardColor(winner, winner.sourceRgb || winner.rgb)
        component.forEach(([cellRow, cellColumn]) => {
          filled[cellRow][cellColumn] = repairedColor
        })
      }
    }

    return filled
  },

getOutlineColor() {
    const palette = this.getActivePalette()
    return palette.reduce((best, color) => {
      if (!best) {
        return color
      }
      const bestLuminance = best.rgb[0] * 0.299 + best.rgb[1] * 0.587 + best.rgb[2] * 0.114
      const luminance = color.rgb[0] * 0.299 + color.rgb[1] * 0.587 + color.rgb[2] * 0.114
      return luminance < bestLuminance ? color : best
    }, null) || PALETTE[0]
  },

isDarkOutlineColor(color) {
    const luminance = color.rgb[0] * 0.299 + color.rgb[1] * 0.587 + color.rgb[2] * 0.114
    return luminance < 92
  },

toneMapRgb(rgb, preserveSkinHue = false) {
    const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
    const chroma = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])
    const contrast = preserveSkinHue ? 1.012 : COLOR_CONTRAST
    const saturation = preserveSkinHue || luminance < 24 || luminance > 242 || chroma < 8
      ? 1.01
      : COLOR_VIVIDNESS
    const contrasted = luminance + (luminance - 128) * (contrast - 1)
    return rgb.map((channel) => {
      const saturated = contrasted + (channel - luminance) * saturation
      return Math.round(Math.max(0, Math.min(255, saturated)))
    })
  },

getRepresentativeRgb(samples, average, cellCount, centerRgb) {
    if (!samples.length) {
      return average.map((value) => Math.max(0, Math.min(255, Math.round(value))))
    }
    const channels = [0, 1, 2].map((channel) => {
      const values = samples.map((sample) => sample.rgb[channel]).sort((a, b) => a - b)
      return values[Math.floor(values.length / 2)]
    })
    let representative = channels.map((channel, index) => channel * 0.62 + average[index] * 0.38)
    if (centerRgb && cellCount <= 4096) {
      const luminances = samples.map((sample) => sample.rgb[0] * 0.299 + sample.rgb[1] * 0.587 + sample.rgb[2] * 0.114)
      const spread = Math.max(...luminances) - Math.min(...luminances)
      if (spread >= 56) {
        const centerWeight = cellCount <= 676 ? 0.44 : cellCount <= 2704 ? 0.36 : 0.28
        representative = representative.map((value, index) => value * (1 - centerWeight) + centerRgb[index] * centerWeight)
      }
    }
    return representative.map((value) => Math.max(0, Math.min(255, Math.round(value))))
  },

chooseCellColor(samples, average) {
    if (!samples.length) {
      return this.findNearestColor(average)
    }
    const averageLuminance = average[0] * 0.299 + average[1] * 0.587 + average[2] * 0.114
    const darkestSample = samples.reduce((darkest, sample) => {
      const luminance = sample.rgb[0] * 0.299 + sample.rgb[1] * 0.587 + sample.rgb[2] * 0.114
      if (!darkest || luminance < darkest.luminance) {
        return { sample, luminance }
      }
      return darkest
    }, null)
    // 眼睛、眉毛、嘴巴通常只占一个格子的少量采样点，不能被平均色冲掉。
    if (darkestSample && darkestSample.luminance < 68 && averageLuminance - darkestSample.luminance > 72) {
      const featureColor = this.findNearestColor(darkestSample.sample.rgb)
      if (this.isDarkOutlineColor(featureColor)) {
        return featureColor
      }
    }
    const darkSamples = samples.filter((sample) => {
      const red = sample.rgb[0]
      const green = sample.rgb[1]
      const blue = sample.rgb[2]
      return red * 0.299 + green * 0.587 + blue * 0.114 < 82
    })
    const protectOutline = darkSamples.length >= Math.max(2, Math.ceil(samples.length * 0.18))
    const votes = {}
    samples.forEach((sample) => {
      const color = this.findNearestColor(sample.rgb)
      const luminance = sample.rgb[0] * 0.299 + sample.rgb[1] * 0.587 + sample.rgb[2] * 0.114
      const edgeWeight = protectOutline && luminance < 82 ? 1.28 : 1
      const score = sample.weight * edgeWeight
      if (!votes[color.hex]) {
        votes[color.hex] = { color, score }
      } else {
        votes[color.hex].score += score
      }
    })
    return Object.keys(votes).reduce((best, key) => {
      if (!best || votes[key].score > best.score) {
        return votes[key]
      }
      return best
    }, null).color
  },

detectWhiteBackground(pixels) {
    const samplePoints = [
      [28, 28],
      [CANVAS_SIZE - 29, 28],
      [28, CANVAS_SIZE - 29],
      [CANVAS_SIZE - 29, CANVAS_SIZE - 29]
    ]
    const radius = 24
    let whiteCorners = 0
    samplePoints.forEach((point) => {
      const centerX = point[0]
      const centerY = point[1]
      let total = 0
      let white = 0
      for (let y = centerY - radius; y <= centerY + radius; y += 6) {
        for (let x = centerX - radius; x <= centerX + radius; x += 6) {
          const safeX = Math.max(0, Math.min(CANVAS_SIZE - 1, x))
          const safeY = Math.max(0, Math.min(CANVAS_SIZE - 1, y))
          const index = (safeY * CANVAS_SIZE + safeX) * 4
          if (pixels[index + 3] < 20 || this.isNearWhite([pixels[index], pixels[index + 1], pixels[index + 2]])) {
            white += 1
          }
          total += 1
        }
      }
      if (total && white / total >= 0.72) {
        whiteCorners += 1
      }
    })
    return whiteCorners >= 2
  },

isNearWhite(rgb) {
    const minimum = Math.min(rgb[0], rgb[1], rgb[2])
    const maximum = Math.max(rgb[0], rgb[1], rgb[2])
    return minimum >= 245 && maximum - minimum <= 14
  },

findNearestRgb(rgb, palette, options = {}) {
    const skinHint = options.skinHint === true || this.isSkinToneRgb(rgb)
    const darkAnchor = skinHint ? null : this.findNeutralDarkAnchor(rgb, palette)
    if (darkAnchor) {
      return darkAnchor
    }
    // 误差扩散后的 RGB 可能已经不再满足肤色阈值，所以由原始格子传入的
    // skinHint 具有更高优先级。肤色只在安全锚点中匹配，避免跨到亮黄色。
    const skinCandidates = skinHint ? this.getSkinPaletteCandidates(palette) : []
    const candidates = skinCandidates.length ? skinCandidates : palette
    let nearest = candidates[0] || palette[0]
    let bestDistance = Number.POSITIVE_INFINITY
    candidates.forEach((candidate) => {
      const distance = this.mardColorDistance(rgb, candidate.rgb)
      if (distance < bestDistance) {
        bestDistance = distance
        nearest = candidate
      }
    })
    return nearest
  },

getSkinPaletteCandidates(palette) {
    return (palette || []).filter((color) => {
      // 肤色保护使用明确的 MARD 锚点，而不是把所有“偏暖”的 RGB 都算成肤色。
      // 这样 A11/G11 等米黄高光不会在脸部被误当成安全肤色。
      return SKIN_TONE_ANCHOR_CODES.indexOf(color.code) >= 0
        && !this.isStrongYellowRgb(color.rgb)
    })
  },

isStrongYellowRgb(rgb) {
    if (!rgb || rgb.length < 3) {
      return false
    }
    const red = Number(rgb[0])
    const green = Number(rgb[1])
    const blue = Number(rgb[2])
    // 排除高亮黄/橙黄，但保留低饱和的米色、棕色和真实暖肤色。
    return red >= 178
      && green >= 148
      && blue <= 142
      && green - blue >= 44
      && red - green <= 112
  },

rgbToOklab(rgb) {
    const linearize = (value) => {
      const channel = Math.max(0, Math.min(255, Number(value) || 0)) / 255
      return channel <= 0.04045
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4)
    }
    const red = linearize(rgb[0])
    const green = linearize(rgb[1])
    const blue = linearize(rgb[2])
    const l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue
    const m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue
    const s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue
    const cubeRoot = (value) => Math.pow(Math.max(0, value), 1 / 3)
    const lRoot = cubeRoot(l)
    const mRoot = cubeRoot(m)
    const sRoot = cubeRoot(s)
    return [
      0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
      1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
      0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
    ]
  },

oklabDistance(first, second) {
    const firstLab = this.rgbToOklab(first)
    const secondLab = this.rgbToOklab(second)
    const lightness = firstLab[0] - secondLab[0]
    const greenRed = firstLab[1] - secondLab[1]
    const blueYellow = firstLab[2] - secondLab[2]
    return Math.sqrt(lightness * lightness + greenRed * greenRed + blueYellow * blueYellow)
  },

isSkinToneRgb(rgb) {
    if (!rgb || rgb.length < 3) {
      return false
    }
    const red = Number(rgb[0])
    const green = Number(rgb[1])
    const blue = Number(rgb[2])
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue)
    const redGreenGap = red - green
    const greenBlueGap = green - blue
    // 过滤掉黑色、纯黄色和高饱和橙色；保留从浅肤色到暖肤色的范围。
    return red >= green
      && green >= blue
      && red >= 150
      && blue >= 92
      && luminance >= 105
      && luminance <= 242
      && redGreenGap >= 8
      && redGreenGap <= 96
      && greenBlueGap >= 10
      && greenBlueGap <= 82
      && chroma >= 24
      && chroma <= 132
  },

isSkinToneColor(color) {
    return Boolean(color && SKIN_TONE_ANCHOR_CODES.indexOf(color.code) >= 0)
      || this.isSkinToneRgb(color && color.rgb)
  },

rgbDistance(first, second) {
    const red = first[0] - second[0]
    const green = first[1] - second[1]
    const blue = first[2] - second[2]
    return Math.sqrt(red * red + green * green + blue * blue)
  },

mardColorDistance(first, second) {
    const perceptualDistance = this.oklabDistance(first, second) * 255
    const firstLuminance = first[0] * 0.299 + first[1] * 0.587 + first[2] * 0.114
    const secondLuminance = second[0] * 0.299 + second[1] * 0.587 + second[2] * 0.114
    const luminancePenalty = Math.abs(firstLuminance - secondLuminance) * 0.08
    return perceptualDistance + luminancePenalty
  },

findNeutralDarkAnchor(rgb, palette) {
    if (!rgb || !palette || !palette.length) {
      return null
    }
    const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
    const chroma = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])
    if (luminance > 66 || chroma > 46) {
      return null
    }
    const neutralDark = palette.filter((color) => {
      const colorLuminance = color.rgb[0] * 0.299 + color.rgb[1] * 0.587 + color.rgb[2] * 0.114
      const colorChroma = Math.max(...color.rgb) - Math.min(...color.rgb)
      return colorLuminance <= 100 && colorChroma <= 28
    })
    if (!neutralDark.length) {
      return null
    }
    const pureBlack = neutralDark.find((color) => color.code === 'H7')
    // 亮度很低时直接使用 H7；稍亮的黑衣阴影保留 H16/H6 等中性深灰层次。
    if (pureBlack && luminance <= 38) {
      return pureBlack
    }
    return neutralDark.reduce((best, color) => {
      if (!best || this.mardColorDistance(rgb, color.rgb) < this.mardColorDistance(rgb, best.rgb)) {
        return color
      }
      return best
    }, null)
  },

makeMardColor(color, sourceRgb) {
    const mard = color || PALETTE[0]
    const source = sourceRgb
      ? [Math.round(sourceRgb[0]), Math.round(sourceRgb[1]), Math.round(sourceRgb[2])]
      : mard.rgb.slice()
    return {
      name: mard.name,
      code: mard.code,
      // 图面和导出图都使用真实 MARD 颜色，避免出现“色号是一个、画面颜色是另一个”的问题。
      hex: mard.hex,
      rgb: mard.rgb.slice(),
      sourceRgb: source,
      mardHex: mard.hex,
      mardRgb: mard.rgb.slice(),
      empty: false
    }
  },

makeOriginalRgbColor(rgb) {
    const sourceRgb = [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])]
    return this.makeMardColor(this.findNearestColor(sourceRgb), sourceRgb)
  },

rgbToHex(rgb) {
    const toPart = (value) => {
      const part = Math.max(0, Math.min(255, Math.round(value))).toString(16)
      return part.length < 2 ? `0${part}` : part
    }
    return `#${toPart(rgb[0])}${toPart(rgb[1])}${toPart(rgb[2])}`
  },

findNearestColor(rgb) {
    const palette = this.getActivePalette()
    return this.findNearestRgb(rgb, palette)
  },

getActivePalette() {
    const requestedCount = Number(this.data.paletteSpec) || 221
    const cacheKey = `${requestedCount}-${this.data.threshold}`
    if (this.activePaletteCacheKey === cacheKey && this.activePaletteCache) {
      return this.activePaletteCache
    }
    let palette = PALETTE
    if (requestedCount < PALETTE.length) {
      const chosen = []
      const distanceToChosen = (candidate) => {
        if (!chosen.length) {
          return Number.POSITIVE_INFINITY
        }
        return Math.min(...chosen.map((color) => {
          const r = candidate.rgb[0] - color.rgb[0]
          const g = candidate.rgb[1] - color.rgb[1]
          const b = candidate.rgb[2] - color.rgb[2]
          return r * r + g * g + b * b
        }))
      }
      chosen.push(PALETTE[0])

      // 低色号也必须保留黑白和中性深灰锚点。先加入锚点，再做最远点补齐，
      // 才不会因为 requestedCount 较小而把它们排除在可用色板之外。
      LOW_PALETTE_ANCHOR_CODES.forEach((code) => {
        if (chosen.length >= requestedCount || chosen.some((color) => color.code === code)) {
          return
        }
        const anchor = PALETTE.find((color) => color.code === code)
        if (anchor) {
          chosen.push(anchor)
        }
      })

      while (chosen.length < requestedCount) {
        let next = null
        let bestDistance = -1
        PALETTE.forEach((candidate) => {
          if (chosen.indexOf(candidate) >= 0) {
            return
          }
          const distance = distanceToChosen(candidate)
          if (distance > bestDistance) {
            bestDistance = distance
            next = candidate
          }
        })
        if (!next) {
          break
        }
        chosen.push(next)
      }

      palette = chosen
    }

    const thresholds = { none: 0, light: 10, medium: 20, strong: 34, veryStrong: 52 }
    const threshold = thresholds[this.data.threshold] || 0
    if (!threshold) {
      this.activePaletteCacheKey = cacheKey
      this.activePaletteCache = palette
      return palette
    }
    const merged = []
    const thresholdSquared = threshold * threshold
    palette.forEach((color) => {
      const tooClose = merged.some((kept) => {
        const r = color.rgb[0] - kept.rgb[0]
        const g = color.rgb[1] - kept.rgb[1]
        const b = color.rgb[2] - kept.rgb[2]
        return r * r + g * g + b * b < thresholdSquared
      })
      if (!tooClose) {
        merged.push(color)
      }
    })
    this.activePaletteCacheKey = cacheKey
    this.activePaletteCache = merged.length ? merged : palette
    return this.activePaletteCache
  }
}

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
