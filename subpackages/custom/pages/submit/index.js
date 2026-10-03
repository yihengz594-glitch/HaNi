const api = require('../../api')

Page({
  data: {
    ready: false, busy: false, service: null, photoPath: '', sourceFileId: '',
    persons: '1', style: '', features: '', size: '', notes: '',
    minorInPhoto: false, guardianConfirmed: false, consentHumanThirdParty: false, confirmTerms: false,
    requestKey: ''
  },
  onLoad() {
    api.request('/api/custom/config').then((service) => this.setData({ service, ready: true }))
      .catch((error) => { this.setData({ ready: true }); api.toastError(error) })
  },
  onFieldInput(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [field]: event.detail.value, requestKey: '' })
  },
  onSwitchChange(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [field]: event.detail.value, requestKey: '' })
  },
  choosePhoto() {
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: (result) => {
        const item = result.tempFiles?.[0]
        if (!item?.tempFilePath) return
        if (item.size > 15 * 1024 * 1024) return wx.showToast({ title: '照片请小于15MB', icon: 'none' })
        this.setData({ photoPath: item.tempFilePath, sourceFileId: '', requestKey: '' })
      }
    })
  },
  async submit() {
    if (this.data.busy) return
    const d = this.data
    if (!d.service?.canSubmit) return wx.showToast({ title: '仅授权测试账号可提交', icon: 'none' })
    if (!d.photoPath || !d.style.trim() || !d.features.trim() || !d.size.trim()) {
      return wx.showToast({ title: '请补全照片和定制需求', icon: 'none' })
    }
    if (!d.consentHumanThirdParty || !d.confirmTerms || (d.minorInPhoto && !d.guardianConfirmed)) {
      return wx.showToast({ title: '请先确认处理及扣次规则', icon: 'none' })
    }
    const requestKey = d.requestKey || api.newKey('manual-order')
    this.setData({ busy: true, requestKey })
    try {
      let sourceFileId = d.sourceFileId
      if (!sourceFileId) {
        const file = await api.upload(d.photoPath, 'SOURCE')
        sourceFileId = file.id
        this.setData({ sourceFileId })
      }
      const result = await api.request('/api/custom/orders', 'POST', {
        sourceFileId,
        requirements: {
          persons: Number(d.persons), style: d.style, features: d.features, size: d.size, notes: d.notes,
          minorInPhoto: d.minorInPhoto, guardianConfirmed: d.guardianConfirmed,
          consentHumanThirdParty: d.consentHumanThirdParty, confirmTerms: d.confirmTerms
        }
      }, requestKey)
      wx.redirectTo({ url: `/subpackages/custom/pages/detail/index?id=${result.orderId}` })
    } catch (error) { api.toastError(error) } finally { this.setData({ busy: false }) }
  },
  openOrders() { wx.navigateTo({ url: '/subpackages/custom/pages/list/index' }) }
})
