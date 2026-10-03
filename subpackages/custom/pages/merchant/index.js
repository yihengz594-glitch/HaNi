const api = require('../../api')

Page({
  data: { orders: [], loading: true, authorized: false },
  onShow() { this.refresh() },
  async refresh() {
    this.setData({ loading: true })
    try {
      const config = await api.request('/api/custom/config')
      if (!config.isMerchant) throw new Error('当前账号无商家权限')
      const result = await api.request('/api/custom/merchant/orders')
      this.setData({ orders: result.orders || [], authorized: true })
    } catch (error) { this.setData({ authorized: false }); api.toastError(error) }
    finally { this.setData({ loading: false }) }
  },
  openOrder(event) {
    wx.navigateTo({ url: `/subpackages/custom/pages/detail/index?id=${event.currentTarget.dataset.id}&merchant=1` })
  }
})
