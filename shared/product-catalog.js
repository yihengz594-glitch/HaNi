// Shared display fallback for the mini program and seed reference for the server.
// Live checkout and the public product endpoint still read the authoritative DB rows.
const PRODUCTS = [
  {
    id: 'credits10_v2', name: '10次卡', description: '拼豆图纸生成可用 · 不限有效期', badge: '',
    amountFen: 888, priceLabel: '¥8.88', creditAmount: 10, durationDays: 0,
    productType: 'CREDITS', sort: 10, featured: false
  },
  {
    id: 'credits30_v2', name: '30次卡', description: '适合持续创作 · 不限有效期', badge: '推荐',
    amountFen: 1888, priceLabel: '¥18.88', creditAmount: 30, durationDays: 0,
    productType: 'CREDITS', sort: 20, featured: true
  },
  {
    id: 'credits100_v2', name: '100次卡', description: '高频创作更省心 · 不限有效期', badge: '',
    amountFen: 6666, priceLabel: '¥66.66', creditAmount: 100, durationDays: 0,
    productType: 'CREDITS', sort: 30, featured: false
  },
  {
    id: 'permanent_v1', name: '永久卡', description: '永久权益 · 生成不限次数', badge: '永久',
    amountFen: 8888, priceLabel: '¥88.88', creditAmount: 0, durationDays: 0,
    productType: 'PERMANENT', sort: 40, featured: false
  }
]

if (typeof module !== 'undefined') module.exports = { PRODUCTS }
