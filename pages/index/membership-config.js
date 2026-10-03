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

// 临时体验开关：先让所有体验者直接在小程序本机生成，避免服务端未部署或
// 额度服务异常阻断制图。后续接入稳定服务端后，将 allowLocalForAll 改为 false，
// 即可恢复原有登录、预占和扣次流程。
const GENERATION_POLICY = {
  mode: 'local-free',
  allowLocalForAll: true,
  label: '当前体验版生成不限次数'
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

module.exports = { PRODUCTS, MEMBERSHIP_POLICY, GENERATION_POLICY, PAYMENT_CONFIG }
