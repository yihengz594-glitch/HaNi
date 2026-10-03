const groups = {
  '1': { title: '拼豆作品示例', ids: [1, 2] },
  '2': { title: 'Q版人物图纸示例', ids: [3, 4] },
  '3': { title: '宠物图纸示例', ids: [5, 6] },
  '4': { title: '拼豆作品示例', ids: [7, 8] }
}

function makeExample(id) {
  const number = String(id).padStart(2, '0')
  return {
    id,
    name: `作品 ${number}`,
    thumb: id <= 6
      ? `../../assets/example-thumb-${number}.jpg`
      : `../../../../assets/pinbead-cat/gallery/example-thumb-${number}.jpg`,
    url: `../../assets/example-sheet-${number}.jpg`,
    loaded: false,
    failed: false,
    renderImage: true
  }
}

Page({
  data: {
    title: '作品示例',
    mode: 'all',
    examples: [],
    currentIndex: 0,
    currentItem: null
  },

  onLoad(options) {
    const group = String(options.group || 'all')
    const mode = String(options.mode || 'all')
    const ids = group === 'all' ? [1, 2, 3, 4, 5, 6, 7, 8] : (groups[group]?.ids || [1, 2, 3, 4, 5, 6, 7, 8])
    const examples = ids.map(makeExample)
    const imageId = Number(options.imageId)
    const imageIndex = imageId ? examples.findIndex((item) => item.id === imageId) : -1
    const requestedIndex = Math.max(0, Math.min(examples.length - 1, imageIndex >= 0 ? imageIndex : Number(options.index) || 0))
    this.setData({
      title: group === 'all' ? '全部作品示例' : (groups[group]?.title || '作品示例'),
      mode: ['tray', 'cards', 'stepper', 'all', 'preview'].includes(mode) ? mode : 'all',
      examples,
      currentIndex: requestedIndex,
      currentItem: examples[requestedIndex] || null
    })
    wx.setNavigationBarTitle({ title: group === 'all' ? '作品示例' : (groups[group]?.title || '作品示例') })
  },

  closePage() {
    wx.navigateBack({ delta: 1 })
  },

  updateExample(index, changes) {
    const examples = this.data.examples.slice()
    if (!Number.isInteger(index) || !examples[index]) return
    examples[index] = Object.assign({}, examples[index], changes)
    const update = { examples }
    if (index === this.data.currentIndex) update.currentItem = examples[index]
    this.setData(update)
  },

  markImageLoaded(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || !this.data.examples[index]) return
    this.updateExample(index, { loaded: true, failed: false })
  },

  markImageFailed(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || !this.data.examples[index]) return
    this.updateExample(index, { failed: true, loaded: false })
  },

  retryImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.examples[index]
    if (!item) return
    this.updateExample(index, { renderImage: false, failed: false, loaded: false })
    wx.getImageInfo({
      src: this.data.mode === 'all' ? item.thumb : item.url,
      success: () => this.updateExample(index, { renderImage: true }),
      fail: () => this.updateExample(index, { renderImage: true, failed: true })
    })
  },

  showLargeImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.examples[index]
    if (!item || item.failed) return
    wx.previewImage({ current: item.url, urls: this.data.examples.map((example) => example.url) })
  },

  previousExample() {
    this.setCurrentIndex(this.data.currentIndex - 1)
  },

  nextExample() {
    this.setCurrentIndex(this.data.currentIndex + 1)
  },

  setCurrentIndex(value) {
    const index = (value + this.data.examples.length) % this.data.examples.length
    this.setData({ currentIndex: index, currentItem: this.data.examples[index] })
  }
})
