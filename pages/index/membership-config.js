const { PRODUCTS } = require('../../shared/product-catalog')

const MEMBERSHIP_POLICY = {
  freeRecentLimit: 5,
  memberRecentLimit: 30,
  memberBenefits: [
    '生成成功后扣除次数',
    '失败任务自动释放预占次数',
    '次数卡不限有效期',
    '永久卡生成不限次数'
  ]
}

// The shared catalog supplies one UI display fallback. The live server product
// endpoint overrides it; order amounts and benefits are always read by the server.
const PAYMENT_CONFIG = {
  mode: 'mock',
  apiBaseUrl: '',
  endpoints: {
    login: '/api/auth/login',
    membership: '/api/membership/me',
    products: '/api/products',
    createOrder: '/api/pay/orders',
    queryOrder: '/api/pay/orders',
    redeem: '/api/membership/redeem',
    quota: '/api/quota/me',
    tasks: '/api/pattern/tasks',
    taskByKey: '/api/pattern/tasks/by-key',
    accountHistory: '/api/account/history'
  }
}

module.exports = { PRODUCTS, MEMBERSHIP_POLICY, PAYMENT_CONFIG }
