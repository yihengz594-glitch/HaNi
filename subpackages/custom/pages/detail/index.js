const api = require('../../api')

function chooseImage() {
  return new Promise((resolve, reject) => wx.chooseMedia({
    count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
    success(result) {
      const item = result.tempFiles?.[0]
      if (!item?.tempFilePath || item.size > 15 * 1024 * 1024) reject(new Error('请选择15MB以内的图片'))
      else resolve(item.tempFilePath)
    }, fail(error) { reject(new Error(error.errMsg || '未选择图片')) }
  }))
}

function confirm(title, content) {
  return new Promise((resolve) => wx.showModal({ title, content, success: (r) => resolve(Boolean(r.confirm)) }))
}

Page({
  data: {
    id: '', merchant: false, loading: true, busy: false, order: null, messages: [], files: [],
    messageText: '', reason: '', previewId: '', finalQId: '', patternId: '', colorsId: '',
    pendingChatFileId: ''
  },
  onLoad(options) {
    this.setData({ id: options.id || '', merchant: options.merchant === '1' })
    this.pendingAction = null
    this.pendingMessage = null
  },
  onShow() {
    this.refresh()
    this.poller = setInterval(() => { if (!this.data.busy) this.refresh(true) }, 20000)
  },
  onHide() { clearInterval(this.poller) },
  onUnload() { clearInterval(this.poller) },
  async refresh(silent) {
    try {
      const flag = this.data.merchant ? '?asMerchant=1' : ''
      const result = await api.request(`/api/custom/orders/${encodeURIComponent(this.data.id)}${flag}`)
      this.setData({ order: result.order, messages: result.messages || [], files: result.files || [], loading: false })
    } catch (error) { if (!silent) api.toastError(error); this.setData({ loading: false }) }
  },
  onTextInput(event) { this.setData({ messageText: event.detail.value }) },
  onReasonInput(event) { this.setData({ reason: event.detail.value }) },
  async sendMessage() {
    if (this.data.busy) return
    const body = this.data.messageText.trim()
    const fileId = this.data.pendingChatFileId || null
    if (!body && !fileId) return
    const payload = { body, fileId, asMerchant: this.data.merchant }
    const fingerprint = JSON.stringify(payload)
    if (this.pendingMessage?.fingerprint !== fingerprint) {
      this.pendingMessage = { fingerprint, key: api.newKey('custom-message') }
    }
    this.setData({ busy: true })
    try {
      await api.request(`/api/custom/orders/${this.data.id}/messages`, 'POST', payload, this.pendingMessage.key)
      this.pendingMessage = null
      this.setData({ messageText: '', pendingChatFileId: '' })
      await this.refresh()
    } catch (error) { api.toastError(error) } finally { this.setData({ busy: false }) }
  },
  async attachChatImage() {
    if (this.data.busy) return
    try {
      const path = await chooseImage()
      this.setData({ busy: true })
      const file = await api.upload(path, 'CHAT', this.data.id)
      this.setData({ pendingChatFileId: file.id, busy: false })
      await this.sendMessage()
    } catch (error) { api.toastError(error) } finally { this.setData({ busy: false }) }
  },
  async uploadAsset(event) {
    if (this.data.busy || !this.data.merchant) return
    const kind = event.currentTarget.dataset.kind
    const map = { Q_PREVIEW: 'previewId', Q_FINAL: 'finalQId', PATTERN: 'patternId', COLORS: 'colorsId' }
    if (!map[kind]) return
    try {
      const path = await chooseImage()
      this.setData({ busy: true })
      const file = await api.upload(path, kind, this.data.id)
      this.setData({ [map[kind]]: file.id })
      wx.showToast({ title: '上传成功，待确认发布', icon: 'none' })
    } catch (error) { api.toastError(error) } finally { this.setData({ busy: false }) }
  },
  async runAction(event) {
    if (this.data.busy) return
    const action = event.currentTarget.dataset.action
    const fileIds = action === 'preview' ? { preview: this.data.previewId }
      : action === 'deliver' ? { finalQ: this.data.finalQId, pattern: this.data.patternId, colors: this.data.colorsId } : {}
    const reason = this.data.reason.trim()
    if (['reject', 'revise'].includes(action) && !reason) return wx.showToast({ title: '请先填写原因或修改意见', icon: 'none' })
    if (['reject', 'cancel', 'deliver'].includes(action)) {
      if (!await confirm('确认操作', action === 'deliver' ? '确认三份高清文件已齐全并正式交付、结算次数？' : '确认此操作？预占次数将退回。')) return
    }
    const payload = { action, fileIds, reason, asMerchant: this.data.merchant }
    const fingerprint = JSON.stringify(payload)
    if (this.pendingAction?.fingerprint !== fingerprint) this.pendingAction = { fingerprint, key: api.newKey('custom-action') }
    this.setData({ busy: true })
    try {
      await api.request(`/api/custom/orders/${this.data.id}/actions`, 'POST', payload, this.pendingAction.key)
      this.pendingAction = null
      this.setData({ reason: '', previewId: '', finalQId: '', patternId: '', colorsId: '' })
      await this.refresh()
    } catch (error) { api.toastError(error) } finally { this.setData({ busy: false }) }
  },
  async previewFile(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    try {
      wx.showLoading({ title: '下载原图' })
      const path = await api.download(id)
      wx.hideLoading()
      wx.previewImage({ urls: [path], current: path })
    } catch (error) { wx.hideLoading(); api.toastError(error) }
  },
  async saveFile(event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    try {
      wx.showLoading({ title: '保存高清图' })
      const path = await api.download(id)
      const file = this.data.files.find((item) => item.id === id)
      const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[file?.mime_type] || 'jpg'
      const destPath = `${wx.env.USER_DATA_PATH}/custom-${id}.${ext}`
      await new Promise((resolve, reject) => wx.getFileSystemManager().copyFile({ srcPath: path, destPath,
        success: resolve, fail: reject }))
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: destPath, success: resolve, fail: reject }))
      wx.hideLoading()
      wx.showToast({ title: '已保存原始高清图', icon: 'none' })
    } catch (error) { wx.hideLoading(); api.toastError(error) }
  }
})
