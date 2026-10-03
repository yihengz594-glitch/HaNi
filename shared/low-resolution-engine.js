// 独立的低格重构算法。只处理最长边不超过 51 格的结果；不改变 MARD 色板。
// 此文件使用 CommonJS，以便服务端与微信小程序本地生成共用同一份实现。

const EMPTY_CELL = {
  name: '空白背景',
  code: '',
  hex: '#ffffff',
  rgb: [255, 255, 255],
  empty: true
}

const PRESETS = [
  { id: 'LOW_GRID_27_DOWN', maxEdge: 27, maxColors: 6, occupancy: 0.78, mergeDelta: 17, coverage: 0.1, samples: 9 },
  { id: 'LOW_GRID_28_39', maxEdge: 39, maxColors: 8, occupancy: 0.8, mergeDelta: 14, coverage: 0.12, samples: 9 },
  { id: 'LOW_GRID_40_51', maxEdge: 51, maxColors: 12, occupancy: 0.82, mergeDelta: 10, coverage: 0.14, samples: 9 }
]

function getPreset(columns, rows) {
  const maxEdge = Math.max(columns, rows)
  return PRESETS.find((preset) => maxEdge <= preset.maxEdge) || null
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function median(values) {
  if (!values.length) return 0
  const sorted = values.slice().sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function medianRgb(samples) {
  return [0, 1, 2].map((channel) => median(samples.map((sample) => sample.rgb[channel])))
}

function rgbToLab(rgb) {
  const linear = rgb.map((value) => {
    const normalized = clamp(value, 0, 255) / 255
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
  })
  const x = (linear[0] * 0.4124564 + linear[1] * 0.3575761 + linear[2] * 0.1804375) / 0.95047
  const y = linear[0] * 0.2126729 + linear[1] * 0.7151522 + linear[2] * 0.072175
  const z = (linear[0] * 0.0193339 + linear[1] * 0.119192 + linear[2] * 0.9503041) / 1.08883
  const transform = (value) => value > 0.008856451679 ? Math.cbrt(value) : (7.787037 * value) + (16 / 116)
  const fx = transform(x)
  const fy = transform(y)
  const fz = transform(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function deltaE(first, second) {
  const lightness = first[0] - second[0]
  const a = first[1] - second[1]
  const b = first[2] - second[2]
  return Math.sqrt(lightness * lightness + a * a + b * b)
}

function rgbDistanceSquared(first, second) {
  const red = first[0] - second[0]
  const green = first[1] - second[1]
  const blue = first[2] - second[2]
  return red * red + green * green + blue * blue
}

function sampleBorder(pixels, width, height) {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 240))
  const samples = []
  const add = (x, y) => {
    const offset = (y * width + x) * 4
    if (pixels[offset + 3] < 28) return
    const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
    samples.push({ rgb, lab: rgbToLab(rgb) })
  }
  for (let x = 0; x < width; x += step) {
    add(x, 0)
    add(x, height - 1)
  }
  for (let y = step; y < height - 1; y += step) {
    add(0, y)
    add(width - 1, y)
  }
  if (samples.length < 24) return null

  const rgb = [0, 1, 2].map((channel) => median(samples.map((sample) => sample.rgb[channel])))
  const lab = rgbToLab(rgb)
  const distances = samples.map((sample) => deltaE(sample.lab, lab))
  const inliers = distances.filter((distance) => distance <= 12).length
  if (inliers / samples.length < 0.76) return null
  const inlierRgbDistances = samples
    .filter((sample) => deltaE(sample.lab, lab) <= 12)
    .map((sample) => Math.sqrt(rgbDistanceSquared(sample.rgb, rgb)))
  const tolerance = clamp(median(inlierRgbDistances) * 2 + 10, 14, 30)
  return { rgb, lab, tolerance }
}

function createForegroundMask(pixels, width, height) {
  const length = width * height
  const edgeMask = new Uint8Array(length)
  const border = sampleBorder(pixels, width, height)
  if (!border) {
    return {
      edgeMask,
      isForeground(index) {
        return pixels[index * 4 + 3] >= 28
      }
    }
  }

  const queue = new Int32Array(length)
  let queueLength = 0
  const isBackgroundCandidate = (index) => {
    const offset = index * 4
    if (pixels[offset + 3] < 28) return true
    return rgbDistanceSquared(
      [pixels[offset], pixels[offset + 1], pixels[offset + 2]],
      border.rgb
    ) <= border.tolerance * border.tolerance
  }
  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const index = y * width + x
    if (edgeMask[index] || !isBackgroundCandidate(index)) return
    edgeMask[index] = 1
    queue[queueLength] = index
    queueLength += 1
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0)
    enqueue(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y)
    enqueue(width - 1, y)
  }
  for (let cursor = 0; cursor < queueLength; cursor += 1) {
    const index = queue[cursor]
    const x = index % width
    const y = Math.floor(index / width)
    enqueue(x - 1, y)
    enqueue(x + 1, y)
    enqueue(x, y - 1)
    enqueue(x, y + 1)
  }

  let opaqueCount = 0
  let foregroundCount = 0
  for (let index = 0; index < length; index += 1) {
    if (pixels[index * 4 + 3] < 28) continue
    opaqueCount += 1
    if (!edgeMask[index]) foregroundCount += 1
  }
  // 整张白图或接近纯色的图不能被错误地裁成空图。
  if (foregroundCount < Math.max(16, opaqueCount * 0.003)) {
    edgeMask.fill(0)
    return {
      edgeMask,
      isForeground(index) {
        return pixels[index * 4 + 3] >= 28
      }
    }
  }
  return {
    edgeMask,
    isForeground(index) {
      return pixels[index * 4 + 3] >= 28 && !edgeMask[index]
    }
  }
}

function readOriginalPixels(image, createCanvas, sourceSize) {
  const canvas = createCanvas({ type: '2d', width: sourceSize, height: sourceSize })
  canvas.width = sourceSize
  canvas.height = sourceSize
  const context = canvas.getContext('2d')
  if (typeof context.imageSmoothingEnabled === 'boolean') context.imageSmoothingEnabled = true
  context.clearRect(0, 0, sourceSize, sourceSize)
  const imageWidth = Math.max(1, Number(image.width) || sourceSize)
  const imageHeight = Math.max(1, Number(image.height) || sourceSize)
  const scale = Math.min(sourceSize / imageWidth, sourceSize / imageHeight)
  const width = imageWidth * scale
  const height = imageHeight * scale
  context.drawImage(image, 0, 0, imageWidth, imageHeight,
    (sourceSize - width) / 2, (sourceSize - height) / 2, width, height)
  return context.getImageData(0, 0, sourceSize, sourceSize).data
}

function findForegroundBounds(pixels, width, height, mask) {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask.isForeground(y * width + x)) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) return null
  return { left, top, width: right - left + 1, height: bottom - top + 1 }
}

function medianLab(samples) {
  return [0, 1, 2].map((channel) => median(samples.map((sample) => sample.lab[channel])))
}

function sampleGrid(pixels, sourceSize, columns, rows, bounds, mask, preset) {
  const scale = Math.min(
    columns * preset.occupancy / bounds.width,
    rows * preset.occupancy / bounds.height
  )
  const cropWidth = columns / scale
  const cropHeight = rows / scale
  const cropLeft = (bounds.left + bounds.width / 2) - cropWidth / 2
  const cropTop = (bounds.top + bounds.height / 2) - cropHeight / 2
  const steps = preset.samples
  const grid = []

  for (let row = 0; row < rows; row += 1) {
    const gridRow = []
    for (let column = 0; column < columns; column += 1) {
      const samples = []
      for (let sy = 0; sy < steps; sy += 1) {
        for (let sx = 0; sx < steps; sx += 1) {
          const sourceX = cropLeft + (column + (sx + 0.5) / steps) * cropWidth / columns
          const sourceY = cropTop + (row + (sy + 0.5) / steps) * cropHeight / rows
          const x = Math.floor(sourceX)
          const y = Math.floor(sourceY)
          if (x < 0 || y < 0 || x >= sourceSize || y >= sourceSize) continue
          const pixelIndex = y * sourceSize + x
          if (!mask.isForeground(pixelIndex)) continue
          const offset = pixelIndex * 4
          const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
          samples.push({ rgb, lab: rgbToLab(rgb) })
        }
      }

      const coverage = samples.length / (steps * steps)
      if (!samples.length) {
        gridRow.push({ foreground: false, protected: false, coverage, lab: null, rgb: null })
        continue
      }
      const dark = samples.filter((sample) => sample.lab[0] < 38)
      // 高饱和鼻头、耳朵内侧等是局部特征；门槛保持高于常见肤色暖调，
      // 避免把整张脸误识别成装饰色。
      const vivid = samples.filter((sample) => Math.sqrt(sample.lab[1] ** 2 + sample.lab[2] ** 2) > 22)
      const cool = samples.filter((sample) => sample.rgb[2] > sample.rgb[0] + 10
        && sample.rgb[2] > sample.rgb[1] + 5)
      const darkFeature = dark.length >= 2 && dark.length / samples.length >= 0.025
      const vividFeature = vivid.length >= 2 && vivid.length / samples.length >= 0.025
      const coolFeature = cool.length > 0 && cool.length / samples.length >= 0.012
      const protectedFeature = darkFeature || vividFeature || coolFeature
      // 一格可能同时覆盖蓝虹膜和黑瞳孔。低格重新構图优先保留高辨识度色彩特征，
      // 其纯色 MARD 豆通常比原图像素比例更重要；瞳孔仍由邻格/轮廓深色保护。
      const representativeSamples = coolFeature && cool.length / samples.length < 0.62
        ? cool
        : vividFeature && vivid.length / samples.length < 0.62
          ? vivid
        : darkFeature && dark.length / samples.length < 0.62
          ? dark
          : samples
      const rgb = medianRgb(representativeSamples)
      gridRow.push({
        foreground: coverage >= preset.coverage || (protectedFeature && coverage >= 0.025),
        protected: protectedFeature,
        darkFeature,
        vividFeature,
        coolFeature,
        coverage,
        lab: rgbToLab(rgb),
        rgb
      })
    }
    grid.push(gridRow)
  }
  return grid
}

function closeSingleCellHoles(grid) {
  const rows = grid.length
  const columns = grid[0] ? grid[0].length : 0
  const result = grid.map((row) => row.map((cell) => ({ ...cell })))
  for (let row = 1; row < rows - 1; row += 1) {
    for (let column = 1; column < columns - 1; column += 1) {
      if (grid[row][column].foreground || grid[row][column].coverage === 0) continue
      let neighbors = 0
      const labs = []
      const rgbs = []
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue
          const neighbor = grid[row + dy][column + dx]
          if (!neighbor.foreground) continue
          neighbors += 1
          labs.push(neighbor.lab)
          rgbs.push({ rgb: neighbor.rgb })
        }
      }
      if (neighbors >= 7) {
        result[row][column] = {
          foreground: true,
          protected: false,
          coverage: grid[row][column].coverage,
          lab: [0, 1, 2].map((channel) => median(labs.map((lab) => lab[channel]))),
          rgb: medianRgb(rgbs)
        }
      }
    }
  }
  return result
}

function markOutsideCells(grid) {
  const rows = grid.length
  const columns = grid[0] ? grid[0].length : 0
  const outside = new Uint8Array(rows * columns)
  const queue = new Int32Array(rows * columns)
  let length = 0
  const enqueue = (row, column) => {
    if (row < 0 || column < 0 || row >= rows || column >= columns) return
    const index = row * columns + column
    if (outside[index] || grid[row][column].foreground) return
    outside[index] = 1
    queue[length] = index
    length += 1
  }
  for (let column = 0; column < columns; column += 1) {
    enqueue(0, column)
    enqueue(rows - 1, column)
  }
  for (let row = 1; row < rows - 1; row += 1) {
    enqueue(row, 0)
    enqueue(row, columns - 1)
  }
  for (let cursor = 0; cursor < length; cursor += 1) {
    const index = queue[cursor]
    const row = Math.floor(index / columns)
    const column = index % columns
    enqueue(row - 1, column)
    enqueue(row + 1, column)
    enqueue(row, column - 1)
    enqueue(row, column + 1)
  }
  return outside
}

function computeOutline(grid, palette, paletteLab) {
  const rows = grid.length
  const columns = grid[0] ? grid[0].length : 0
  const outside = markOutsideCells(grid)
  const ring = new Uint8Array(rows * columns)
  const edgeSamples = []
  const offsets = [
    [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]
  ]
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cell = grid[row][column]
      if (!cell.foreground) continue
      let isEdge = false
      offsets.forEach(([dy, dx]) => {
        const nextRow = row + dy
        const nextColumn = column + dx
        if (nextRow < 0 || nextColumn < 0 || nextRow >= rows || nextColumn >= columns) return
        const index = nextRow * columns + nextColumn
        if (outside[index]) {
          isEdge = true
        }
      })
      if (isEdge) {
        // 轮廓落在主体边缘本身，而不是再向外扩一格；这样深色原始线稿不会和
        // 人工描边叠成两格粗边，也避免侵占低格图仅有的脸部/肢体面积。
        ring[row * columns + column] = 1
        edgeSamples.push(cell.lab)
      }
    }
  }
  const darkSource = edgeSamples.filter((lab) => lab[0] < 62)
  const target = darkSource.length
    ? [0, 1, 2].map((channel) => median(darkSource.map((lab) => lab[channel])))
    : [0, 1, 2].map((channel) => median(grid.flat().filter((cell) => cell.foreground).map((cell) => cell.lab[channel])))
  const darkIndices = palette.map((color, index) => ({ index, lab: paletteLab[index] }))
    .filter((entry) => entry.lab[0] <= 52)
  const choices = darkIndices.length ? darkIndices : paletteLab.map((lab, index) => ({ index, lab }))
  const outline = choices.reduce((best, candidate) => (
    !best || deltaE(candidate.lab, target) < deltaE(best.lab, target) ? candidate : best
  ), null)
  return { ring, outlineColor: palette[outline.index] }
}

function colorBinKey(lab) {
  return [Math.round(lab[0] / 10), Math.round(lab[1] / 12), Math.round(lab[2] / 12)].join(':')
}

function createCenters(cells, limit, outlineLab, mergeDelta) {
  const bins = new Map()
  cells.forEach((cell) => {
    const key = colorBinKey(cell.lab)
    const bin = bins.get(key) || { lab: [0, 0, 0], weight: 0 }
    const weight = cell.protected ? 3.2 : 1
    for (let channel = 0; channel < 3; channel += 1) bin.lab[channel] += cell.lab[channel] * weight
    bin.weight += weight
    bins.set(key, bin)
  })
  const dominant = Array.from(bins.values()).map((bin) => ({
    lab: bin.lab.map((value) => value / bin.weight),
    weight: bin.weight,
    protected: false
  })).sort((first, second) => second.weight - first.weight)[0]
  let centers = dominant ? [{ ...dominant, lab: dominant.lab.slice() }] : []
  if (outlineLab && centers.length < limit && deltaE(centers[0].lab, outlineLab) > mergeDelta) {
    centers.push({ lab: outlineLab.slice(), weight: 2.5, protected: true })
  }
  const coolFeatures = cells.filter((cell) => cell.coolFeature)
  const vividFeatures = cells.filter((cell) => cell.vividFeature)
  const darkFeatures = cells.filter((cell) => cell.darkFeature)
  const featureSeedLimit = Math.min(3, Math.max(0, limit - centers.length))
  let featureSeeds = 0
  for (const features of [coolFeatures, vividFeatures, darkFeatures]) {
    while (featureSeeds < featureSeedLimit && features.length) {
      let candidate = null
      let candidateDistance = -1
      features.forEach((cell) => {
        const nearestDistance = Math.min(...centers.map((center) => deltaE(cell.lab, center.lab)))
        if (nearestDistance > candidateDistance) {
          candidateDistance = nearestDistance
          candidate = cell
        }
      })
      if (!candidate || candidateDistance < mergeDelta) break
      centers.push({ lab: candidate.lab.slice(), weight: 4, protected: true })
      const candidateIndex = features.indexOf(candidate)
      if (candidateIndex >= 0) features.splice(candidateIndex, 1)
      featureSeeds += 1
    }
  }

  while (centers.length < limit) {
    let candidate = null
    let score = -1
    cells.forEach((cell) => {
      const nearest = Math.min(...centers.map((center) => deltaE(cell.lab, center.lab)))
      const weightedScore = nearest * nearest * (cell.protected ? 3.2 : 1)
      if (weightedScore > score) {
        score = weightedScore
        candidate = cell
      }
    })
    if (!candidate || Math.sqrt(score) < mergeDelta * 0.65) break
    centers.push({ lab: candidate.lab.slice(), weight: 1, protected: candidate.protected })
  }
  if (!centers.length && cells.length) centers.push({ lab: cells[0].lab.slice(), weight: 1, protected: false })

  for (let iteration = 0; iteration < 7; iteration += 1) {
    const clusters = centers.map(() => ({ sums: [0, 0, 0], weight: 0, protected: false }))
    cells.forEach((cell) => {
      let nearestIndex = 0
      let nearestDistance = Infinity
      centers.forEach((center, index) => {
        const distance = deltaE(cell.lab, center.lab)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearestIndex = index
        }
      })
      const cluster = clusters[nearestIndex]
      const weight = cell.protected ? 3.2 : 1
      for (let channel = 0; channel < 3; channel += 1) cluster.sums[channel] += cell.lab[channel] * weight
      cluster.weight += weight
      cluster.protected = cluster.protected || cell.protected
    })
    centers = centers.map((center, index) => clusters[index].weight
      ? { lab: clusters[index].sums.map((value) => value / clusters[index].weight), weight: clusters[index].weight, protected: clusters[index].protected }
      : center)
  }

  for (let first = 0; first < centers.length; first += 1) {
    for (let second = first + 1; second < centers.length;) {
      if (deltaE(centers[first].lab, centers[second].lab) >= mergeDelta
        || (centers[first].protected && centers[second].protected)) {
        second += 1
        continue
      }
      const firstWeight = centers[first].weight || 1
      const secondWeight = centers[second].weight || 1
      const totalWeight = firstWeight + secondWeight
      centers[first] = {
        lab: centers[first].lab.map((value, channel) => (value * firstWeight + centers[second].lab[channel] * secondWeight) / totalWeight),
        weight: totalWeight,
        protected: centers[first].protected || centers[second].protected
      }
      centers.splice(second, 1)
    }
  }
  return centers
}

function nearestPaletteColor(lab, palette, paletteLab) {
  let bestIndex = 0
  let bestDistance = Infinity
  paletteLab.forEach((candidate, index) => {
    const distance = deltaE(lab, candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return palette[bestIndex]
}

function cleanSmallColorRegions(codes, grid, paletteByCode, outlineCode) {
  const rows = codes.length
  const columns = codes[0] ? codes[0].length : 0
  const visited = new Uint8Array(rows * columns)
  const changes = []
  const cardinal = [[-1, 0], [1, 0], [0, -1], [0, 1]]
  const surrounding = [...cardinal, [-1, -1], [-1, 1], [1, -1], [1, 1]]
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const code = codes[row][column]
      const start = row * columns + column
      if (!code || code === outlineCode || visited[start]) continue
      const component = [[row, column]]
      visited[start] = 1
      for (let cursor = 0; cursor < component.length; cursor += 1) {
        const [currentRow, currentColumn] = component[cursor]
        cardinal.forEach(([dy, dx]) => {
          const nextRow = currentRow + dy
          const nextColumn = currentColumn + dx
          if (nextRow < 0 || nextColumn < 0 || nextRow >= rows || nextColumn >= columns) return
          const index = nextRow * columns + nextColumn
          if (visited[index] || codes[nextRow][nextColumn] !== code) return
          visited[index] = 1
          component.push([nextRow, nextColumn])
        })
      }
      if (component.length > 2 || component.some(([cellRow, cellColumn]) => grid[cellRow][cellColumn].protected)) continue

      const votes = new Map()
      component.forEach(([cellRow, cellColumn]) => {
        surrounding.forEach(([dy, dx]) => {
          const nextRow = cellRow + dy
          const nextColumn = cellColumn + dx
          if (nextRow < 0 || nextColumn < 0 || nextRow >= rows || nextColumn >= columns) return
          const nextCode = codes[nextRow][nextColumn]
          if (!nextCode || nextCode === code) return
          const entry = votes.get(nextCode) || { count: 0, distance: 0 }
          entry.count += 1
          entry.distance += deltaE(grid[cellRow][cellColumn].lab, paletteByCode.get(nextCode).lab)
          votes.set(nextCode, entry)
        })
      })
      const replacement = Array.from(votes.entries()).sort((first, second) => {
        return second[1].count - first[1].count || first[1].distance - second[1].distance
      })[0]
      if (replacement) component.forEach(([cellRow, cellColumn]) => changes.push([cellRow, cellColumn, replacement[0]]))
    }
  }
  changes.forEach(([row, column, code]) => { codes[row][column] = code })
}

function generate(runtime, image, size, createCanvas, sourceSize = 1200) {
  const columns = Math.max(1, Number(size.columns) || 1)
  const rows = Math.max(1, Number(size.rows) || 1)
  const preset = getPreset(columns, rows)
  if (!preset) throw new Error('低格清晰模式仅支持最长边不超过 51 格')
  const pixels = readOriginalPixels(image, createCanvas, sourceSize)
  const mask = createForegroundMask(pixels, sourceSize, sourceSize)
  const bounds = findForegroundBounds(pixels, sourceSize, sourceSize, mask)
  if (!bounds) return Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ ...EMPTY_CELL })))

  const sampled = closeSingleCellHoles(sampleGrid(pixels, sourceSize, columns, rows, bounds, mask, preset))
  const palette = runtime.getActivePalette()
  const paletteLab = palette.map((color) => rgbToLab(color.rgb))
  const activeCells = sampled.flat().filter((cell) => cell.foreground)
  if (!activeCells.length) return Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ ...EMPTY_CELL })))

  const outline = computeOutline(sampled, palette, paletteLab)
  const outlineLab = rgbToLab(outline.outlineColor.rgb)
  const centers = createCenters(activeCells, preset.maxColors - 1, outlineLab, preset.mergeDelta)
  const selectedByCode = new Map()
  centers.forEach((center) => {
    const color = nearestPaletteColor(center.lab, palette, paletteLab)
    if (!selectedByCode.has(color.code)) selectedByCode.set(color.code, color)
  })
  selectedByCode.set(outline.outlineColor.code, outline.outlineColor)
  const selected = Array.from(selectedByCode.values()).slice(0, preset.maxColors)
  if (!selected.some((color) => color.code === outline.outlineColor.code)) {
    selected[selected.length - 1] = outline.outlineColor
  }
  const selectedLab = selected.map((color) => rgbToLab(color.rgb))
  const paletteByCode = new Map(selected.map((color, index) => [color.code, { color, lab: selectedLab[index] }]))
  const codes = sampled.map((row) => row.map((cell) => {
    if (!cell.foreground) return ''
    return nearestPaletteColor(cell.lab, selected, selectedLab).code
  }))

  cleanSmallColorRegions(codes, sampled, paletteByCode, outline.outlineColor.code)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (outline.ring[row * columns + column]) codes[row][column] = outline.outlineColor.code
    }
  }

  const selectedByCodeFinal = new Map(selected.map((color) => [color.code, color]))
  const result = codes.map((row, rowIndex) => row.map((code, columnIndex) => {
    if (!code) return { ...EMPTY_CELL }
    const color = selectedByCodeFinal.get(code) || outline.outlineColor
    const sourceRgb = sampled[rowIndex][columnIndex].rgb || color.rgb
    return runtime.makeMardColor(color, sourceRgb)
  }))
  return result
}

module.exports = {
  EMPTY_CELL,
  PRESETS,
  getPreset,
  rgbToLab,
  deltaE,
  generate
}
