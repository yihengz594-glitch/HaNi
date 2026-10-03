const api = require('../../api')

Page({
  data: { orders: [], loading: true },
  onShow() { this.refresh() },
  async refresh() {
    this.setData({ loading: true })
    try {
      const result = await api.request('/api/custom/orders')
      this.setData({ orders: result.orders || [] })
    } catch (error) { api.toastError(error) } finally { this.setData({ loading: false }) }
  },
  openOrder(event) {
    wx.navigateTo({ url: `/subpackages/custom/pages/detail/index?id=${event.currentTarget.dataset.id}` })
  },
  openSubmit() { wx.navigateTo({ url: '/subpackages/custom/pages/submit/index' }) }
})
