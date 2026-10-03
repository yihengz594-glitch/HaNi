const PALETTE = require('./palette')
const { PRODUCTS, MEMBERSHIP_POLICY, PAYMENT_CONFIG } = require('./membership-config')
const { canUseLocalGeneration } = require('./local-generation-policy')
const { generateLocalPattern } = require('./local-pattern-core')
const { createPatternEditor, clientToCell, lineCells } = require('./pattern-editor')
// 会员中心页面与支付入口保持在本地 MVP 中；真实权益仍以服务端返回为准。

// 预览画布使用更大的 backing store，避免手机屏幕缩放后出现糊边和小字发虚。
// 导出的高清大图仍使用下面的动态尺寸，不受预览画布尺寸限制。
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

const MEMBER_PROFILE_STORAGE_KEY = 'pinbead.memberProfile.v1'
const RECENT_WORKS_STORAGE_KEY = 'pinbead.recentWorks.v1'
const SESSION_TOKEN_STORAGE_KEY = 'pinbead.sessionToken.v1'
const DEFAULT_MEMBER_PROFILE = {
  active: false,
  permanentEntitlement: false,
  billingMode: 'CREDITS',
  statusLabel: '未开通',
  note: '普通制图和 AI 生成均免广告',
  title: '高级版会员',
  description: '普通制图和 AI 生成均免广告',
  planName: '',
  daysRemaining: 0,
  expiresAt: '',
  creditsRemaining: 0,
  quotaLabel: '剩余 0 次'
}

Page({
  data: {
    activeTab: 'home',
    localGenerationMode: false,
  pageTitle: '拼豆高级版',
    customServiceLabel: '人工定制尚未开放接单',
    customServiceMerchant: false,
    homeHeroImage: '../../assets/website-covers/cover-2.jpg',
    galleryGuideImage: '../../assets/website-covers/cover-3.jpg',
    navItems: [
      { key: 'home', name: 'AI首页', icon: '✦', theme: 'purple' },
      { key: 'make', name: '直接制图', icon: '▦', theme: 'blue' },
      { key: 'mine', name: '我的', icon: '●', theme: 'black' }
    ],
    // 首页只展示插画，不再把插画作为风格选择或生成参数。
    homeIllustrations: [
      {
        image: '../../assets/website-covers/cover-5.jpg',
        group: 'all', loaded: false, failed: false, renderImage: true
      },
      {
        image: '../../assets/website-covers/cover-6.jpg',
        group: 'all', loaded: false, failed: false, renderImage: true
      },
      {
        image: '../../assets/website-covers/cover-7.jpg',
        group: 'all', loaded: false, failed: false, renderImage: true
      },
      {
        image: '../../assets/website-covers/cover-8.jpg',
        group: 'all', loaded: false, failed: false, renderImage: true
      },
      {
        image: '../../assets/website-covers/cover-9.jpg',
        group: 'all', loaded: false, failed: false, renderImage: true
      },
      {
        image: '../../assets/website-covers/cover-10.jpg',
        group: 'all', loaded: false, failed: false, renderImage: true
      }
    ],
    homeHeroLoaded: false,
    homeHeroFailed: false,
    homeGuideLoaded: false,
    homeGuideFailed: false,
    expandedIllustrationGroup: '',
    expandedGalleryItems: [
      { image: '../../assets/pinbead-cat/gallery/example-thumb-07.jpg', index: 6 },
      { image: '../../assets/pinbead-cat/gallery/example-thumb-08.jpg', index: 7 }
    ],
    maxGridSize: 160,
    featureItems: [
      { name: '文字拼豆', description: '输入文字生成图纸', icon: 'Aa', theme: 'purple' },
      { name: '画拼豆', description: '手绘你的作品', icon: '▣', theme: 'green' },
      { name: '色号识别', description: '上传图片识别色号', icon: '识', theme: 'blue' },
      { name: '打印', description: '选择豆板打印尺寸', icon: '印', theme: 'black' }
    ],
    membershipOptions: PRODUCTS,
    productCatalogStatus: '套餐价格由统一商品配置提供',
    memberProfile: DEFAULT_MEMBER_PROFILE,
    recentWorks: [],
    recentLimit: MEMBERSHIP_POLICY.freeRecentLimit,
    paymentModeLabel: '开发测试模式：未连接支付服务',
    paymentBusy: false,
    redeemVisible: false,
    redeemCode: '',
    historyVisible: false,
    historyLoading: false,
    accountHistory: [],
    imagePath: '',
    gridSize: 64,
    gridWidth: 64,
    gridHeight: 64,
    // 尺寸始终由用户选择或填写，不再根据图片自动推荐/改写尺寸。
    sizeMode: 'board',
    customWidth: 64,
    customHeight: 64,
    sizeOptions: [
      { label: '16×16', width: 16, height: 16 },
      { label: '26×26', width: 26, height: 26 },
      { label: '52×52', width: 52, height: 52 },
      { label: '64×64', width: 64, height: 64 },
      { label: '78×78', width: 78, height: 78 },
      { label: '104×104', width: 104, height: 104 },
      { label: '128×128', width: 128, height: 128 }
    ],
    paletteStandard: 'MARD',
    paletteSpec: '221',
    paletteOptions: [
      { value: '72', name: '72色', description: '入门款，基础色系' },
      { value: '96', name: '96色', description: '进阶款，颜色更丰富' },
      { value: '144', name: '144色', description: '专业款，完整常用色' },
      { value: '221', name: '221色', description: '推荐，MARD专业完整款' },
      { value: '238', name: '238色', description: '扩展款，含新色系' },
      { value: '291', name: '291色', description: '全色款，适合收藏' }
    ],
    threshold: 'none',
    thresholdName: '不合并',
    thresholdOptions: [
      { value: 'none', name: '不合并', description: '保留所有原始色号' },
      { value: 'light', name: '轻度合并', description: '仅合并极相近颜色' },
      { value: 'medium', name: '中度合并', description: '明显减少颜色种类' },
      { value: 'strong', name: '较强合并', description: '颜色种类较少' },
      { value: 'veryStrong', name: '强力合并', description: '大幅减少颜色数量' }
    ],
    sheetType: '',
    viewMode: 'sheet',
    generating: false,
    patternReady: false,
    totalBeads: 0,
    colorStats: [],
    editing: false,
    editorTool: 'brush',
    editorColorCode: 'H2',
    editorColorHex: '#ffffff',
    editorScale: 1,
    editorOffsetX: 0,
    editorOffsetY: 0,
    editorCanUndo: false,
    editorCanRedo: false,
    editorPaletteVisible: false,
    editorPaletteSearch: '',
    editorPaletteOptions: []
  },

  onReady() {
    this.initCanvas()
  },

  onLoad() {
    this.setData({ localGenerationMode: canUseLocalGeneration(wx, this.getPaymentBaseUrl()) })
    this.loadLocalMemberData()
  },

  onShow() {
    this.loadLocalMemberData()
    this.refreshMemberState()
    this.refreshCustomService()
  },

  refreshCustomService() {
    if (!this.getPaymentBaseUrl()) return
    this.ensureSession((loginError, token) => {
      if (loginError) return
      this.apiRequest('/api/custom/config', {}, token, (error, result) => {
        if (error || !result) return
        this.setData({
          customServiceLabel: result.canSubmit ? result.chargeLabel : '仅授权测试账号可提交，正式接单未开放',
          customServiceMerchant: result.isMerchant === true
        })
      })
    })
  },

  loadLocalMemberData() {
    let cachedProfile = null
    let cachedWorks = []
    try {
      cachedProfile = wx.getStorageSync(MEMBER_PROFILE_STORAGE_KEY)
      cachedWorks = wx.getStorageSync(RECENT_WORKS_STORAGE_KEY) || []
    } catch (error) {
      console.warn('[membership] local cache unavailable', error)
    }
    const memberProfile = this.normalizeMemberProfile(cachedProfile)
    const recentLimit = this.getRecentLimit(memberProfile)
    const normalizedWorks = Array.isArray(cachedWorks)
      ? cachedWorks.slice(0, recentLimit).map((item) => this.normalizeRecentWorkImagePaths(item))
      : []
    if (Array.isArray(cachedWorks) && JSON.stringify(cachedWorks.slice(0, recentLimit)) !== JSON.stringify(normalizedWorks)) {
      try {
        wx.setStorageSync(RECENT_WORKS_STORAGE_KEY, normalizedWorks)
      } catch (error) {
        console.warn('[membership] failed to clean recent image cache')
      }
    }
    this.setData({
      memberProfile,
      recentWorks: normalizedWorks,
      recentLimit
    })
  },

  isTemporaryImagePath(filePath) {
    const path = String(filePath || '').trim()
    return /^(?:https?:\/\/tmp\/|https?:\/\/127\.0\.0\.1(?::\d+)?\/__tmp__\/|https?:\/\/localhost(?::\d+)?\/__tmp__\/|wxfile:\/\/tmp\/|\/tmp\/)/i.test(path)
  },

  normalizeRecentWorkImagePaths(item) {
    if (!item || typeof item !== 'object') return item
    const normalized = Object.assign({}, item)
    if (this.isTemporaryImagePath(normalized.previewPath)) normalized.previewPath = ''
    if (this.isTemporaryImagePath(normalized.sourceImagePath)) normalized.sourceImagePath = ''
    if (this.isTemporaryImagePath(normalized.cachedImagePath)) normalized.cachedImagePath = ''
    return normalized
  },

  getRecentSourceImagePath(item) {
    const normalized = this.normalizeRecentWorkImagePaths(item)
    return normalized && (normalized.sourceImagePath || normalized.previewPath) || ''
  },

  persistRecentSourceImage(id, tempFilePath) {
    if (!id || !tempFilePath || !wx.saveFile || !this.isTemporaryImagePath(tempFilePath)) return
    wx.saveFile({
      tempFilePath,
      success: (result) => {
        const savedPath = result && result.savedFilePath
        if (!savedPath || this.isTemporaryImagePath(savedPath)) return
        const recentWorks = (this.data.recentWorks || []).map((item) => item.id === id
          ? Object.assign({}, item, { previewPath: savedPath, sourceImagePath: savedPath, cachedImagePath: savedPath })
          : item)
        if (!recentWorks.some((item) => item.id === id)) {
          wx.removeSavedFile && wx.removeSavedFile({ filePath: savedPath, fail: () => {} })
          return
        }
        try {
          wx.setStorageSync(RECENT_WORKS_STORAGE_KEY, recentWorks)
        } catch (error) {
          console.warn('[membership] failed to cache recent image')
          wx.removeSavedFile && wx.removeSavedFile({ filePath: savedPath, fail: () => {} })
          return
        }
        this.setData({ recentWorks })
      },
      fail: () => {
        // The pattern data remains usable; a source thumbnail is optional.
      }
    })
  },

  normalizeMemberProfile(profile) {
    const source = profile && typeof profile === 'object' ? profile : {}
    const creditsRemaining = Math.max(0, Number(source.creditsRemaining) || 0)
    const daysRemaining = Math.max(0, Number(source.daysRemaining) || 0)
    const permanentEntitlement = source.permanentEntitlement === true
    const hasTimeMembership = daysRemaining > 0
    const active = permanentEntitlement || source.active === true || source.status === 'active' || hasTimeMembership || creditsRemaining > 0
    return Object.assign({}, DEFAULT_MEMBER_PROFILE, source, {
      active,
      permanentEntitlement,
      billingMode: permanentEntitlement ? 'PERMANENT' : (source.billingMode || (hasTimeMembership ? 'MEMBERSHIP' : 'CREDITS')),
      statusLabel: permanentEntitlement ? '永久卡已开通' : active ? (source.statusLabel || `${source.planName || '次数卡'}用户`) : '未开通',
      note: permanentEntitlement ? '永久权益 · 生成不限次数' : hasTimeMembership ? '旧版会员有效期内生成不限次数' : (source.note || (creditsRemaining > 0 ? '生成成功后按次扣除' : '生成图纸需使用次数卡或永久权益')),
      title: source.title || '高级版会员',
      description: permanentEntitlement
        ? '永久权益 · 生成不限次数'
        : active
        ? (hasTimeMembership
          ? `${source.planName || '高级版'} · 剩余 ${daysRemaining} 天`
          : (source.description || `剩余 ${creditsRemaining} 次生成额度`))
        : '暂无可用生成次数',
      daysRemaining,
      expiresAt: source.expiresAt || '',
      creditsRemaining,
      quotaLabel: source.quotaLabel || `剩余 ${creditsRemaining} 次`
    })
  },

  getRecentLimit(memberProfile) {
    const profile = memberProfile || this.data.memberProfile || DEFAULT_MEMBER_PROFILE
    return profile.active ? MEMBERSHIP_POLICY.memberRecentLimit : MEMBERSHIP_POLICY.freeRecentLimit
  },

  persistMemberProfile(profile) {
    const normalized = this.normalizeMemberProfile(profile)
    try {
      wx.setStorageSync(MEMBER_PROFILE_STORAGE_KEY, normalized)
    } catch (error) {
      console.warn('[membership] failed to cache member profile', error)
    }
    const recentLimit = this.getRecentLimit(normalized)
    let recentWorks = this.data.recentWorks || []
    if (recentWorks.length > recentLimit) {
      const removedWorks = recentWorks.slice(recentLimit)
      recentWorks = recentWorks.slice(0, recentLimit)
      try {
        wx.setStorageSync(RECENT_WORKS_STORAGE_KEY, recentWorks)
      } catch (error) {
        console.warn('[membership] failed to trim recent works', error)
      }
      this.removeCachedRecentImages(removedWorks, recentWorks)
    }
    this.setData({ memberProfile: normalized, recentLimit, recentWorks })
  },

  removeCachedRecentImages(removedWorks, retainedWorks) {
    const retainedPaths = new Set((retainedWorks || []).map((item) => item && item.cachedImagePath).filter(Boolean))
    const paths = new Set((removedWorks || []).map((item) => item && item.cachedImagePath).filter((path) => path && !retainedPaths.has(path)))
    paths.forEach((filePath) => {
      if (wx.removeSavedFile) wx.removeSavedFile({ filePath, fail: () => {} })
    })
  },

  getPaymentBaseUrl() {
    return String(PAYMENT_CONFIG.apiBaseUrl || '').replace(/\/$/, '')
  },

  makeRequestKey(prefix) {
    const randomPart = Math.random().toString(36).slice(2)
    return `${prefix}-${Date.now().toString(36)}-${randomPart}`.slice(0, 96)
  },

  apiRequest(path, options, token, callback) {
    const baseUrl = this.getPaymentBaseUrl()
    if (!baseUrl) {
      callback(new Error('支付服务端地址未配置'))
      return
    }
    const requestOptions = options || {}
    const headers = Object.assign({ 'content-type': 'application/json' }, requestOptions.header || {})
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    wx.request({
      url: `${baseUrl}${path}`,
      method: requestOptions.method || 'GET',
      data: requestOptions.data,
      header: headers,
      success: (response) => {
        const statusCode = Number(response.statusCode) || 0
        if (statusCode >= 200 && statusCode < 300) {
          callback(null, response.data || {})
          return
        }
        const message = response.data && (response.data.message || response.data.error)
        const requestError = new Error(message || `服务端返回 ${statusCode}`)
        requestError.statusCode = statusCode
        callback(requestError, response.data)
      },
      fail: (error) => callback(error || new Error('网络请求失败'))
    })
  },

  ensureSession(callback) {
    let cachedToken = ''
    try {
      cachedToken = wx.getStorageSync(SESSION_TOKEN_STORAGE_KEY) || ''
    } catch (error) {
      cachedToken = ''
    }
    if (cachedToken) {
      callback(null, cachedToken)
      return
    }
    wx.login({
      success: (loginResult) => {
        if (!loginResult || !loginResult.code) {
          callback(new Error('微信登录凭证获取失败'))
          return
        }
        this.apiRequest(PAYMENT_CONFIG.endpoints.login, {
          method: 'POST',
          data: { code: loginResult.code }
        }, '', (error, response) => {
          if (error) {
            callback(error)
            return
          }
          const token = response && (response.token || response.sessionToken)
          if (!token) {
            callback(new Error('登录服务端未返回会话令牌'))
            return
          }
          try {
            wx.setStorageSync(SESSION_TOKEN_STORAGE_KEY, token)
          } catch (storageError) {
            console.warn('[membership] failed to cache session token', storageError)
          }
          callback(null, token)
        })
      },
      fail: (error) => callback(error || new Error('微信登录失败'))
    })
  },

  refreshMemberState() {
    if (!this.getPaymentBaseUrl()) {
      this.setData({ paymentModeLabel: '开发测试模式：不会发起真实支付' })
      return
    }
    this.setData({
      paymentModeLabel: PAYMENT_CONFIG.mode === 'live' ? '权益及价格由服务端确认' : '已连接测试服务：不会发起真实支付',
      productCatalogStatus: '正在同步服务端商品配置…'
    })
    this.ensureSession((loginError, token) => {
      if (loginError) {
        console.warn('[membership] login failed', loginError)
        this.setData({ paymentModeLabel: '登录或会员状态刷新失败，保留上次缓存' })
        return
      }
      this.apiRequest(PAYMENT_CONFIG.endpoints.products, { method: 'GET' }, token, (productError, productResponse) => {
        if (productError || !Array.isArray(productResponse && productResponse.products)) {
          this.setData({ productCatalogStatus: '服务端套餐暂不可用，价格显示统一配置参考值' })
          return
        }
        this.setData({ membershipOptions: productResponse.products, productCatalogStatus: '价格已同步服务端商品配置' })
      })
      this.apiRequest(PAYMENT_CONFIG.endpoints.membership, { method: 'GET' }, token, (error, response) => {
        if (error) {
          console.warn('[membership] refresh failed', error)
          this.setData({ paymentModeLabel: '会员状态刷新失败，保留上次缓存' })
          return
        }
        const profile = response && (response.memberProfile || response.membership || response)
        if (profile) {
          this.persistMemberProfile(profile)
        }
      })
    })
  },

  buyMembershipPlan(e) {
    const planId = String(e.currentTarget.dataset.productId || '')
    const plan = (this.data.membershipOptions || []).find((item) => item.id === planId)
    if (!plan || this.data.paymentBusy) {
      return
    }
    if (this.data.memberProfile.permanentEntitlement) {
      wx.showModal({ title: '永久卡已开通', content: '你的账号已拥有永久权益，无需再次购买次数卡或永久卡。', showCancel: false })
      return
    }
    if (PAYMENT_CONFIG.mode !== 'live' || !this.getPaymentBaseUrl()) {
      wx.showModal({
        title: '支付服务尚未配置',
        content: '当前是开发测试模式，不会发起真实扣款，也不会伪造会员开通。配置 HTTPS 后端、商户号和支付权限后才能购买。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    this.setData({ paymentBusy: true })
    this.ensureSession((loginError, token) => {
      if (loginError) {
        this.setData({ paymentBusy: false })
        wx.showToast({ title: loginError.message || '登录失败', icon: 'none' })
        return
      }
      // 只传 productId；金额、次数和权益由服务端商品行及订单快照决定。
      this.apiRequest(PAYMENT_CONFIG.endpoints.createOrder, {
        method: 'POST',
        data: { productId: planId },
        header: { 'Idempotency-Key': this.makeRequestKey('order') }
      }, token, (error, response) => {
        if (error) {
          this.setData({ paymentBusy: false })
          wx.showToast({ title: error.message || '订单创建失败', icon: 'none' })
          return
        }
        if (response && response.paid === true) {
          this.setData({ paymentBusy: false })
          if (response.memberProfile) {
            this.persistMemberProfile(response.memberProfile)
          }
          this.refreshMemberState()
          wx.showToast({ title: '订单已支付，会员状态已刷新', icon: 'success' })
          return
        }
        const payment = response && (response.payment || response.paymentParams)
        const orderNo = response && (response.orderNo || response.outTradeNo)
        if (!payment || !orderNo || !payment.timeStamp || !payment.nonceStr || !payment.package || !payment.paySign) {
          this.setData({ paymentBusy: false })
          wx.showToast({ title: '支付参数不完整', icon: 'none' })
          return
        }
        wx.requestPayment({
          timeStamp: String(payment.timeStamp),
          nonceStr: payment.nonceStr,
          package: payment.package,
          signType: payment.signType || 'RSA',
          paySign: payment.paySign,
          success: () => this.pollPaymentOrder(orderNo, token, 0),
          fail: (paymentError) => {
            this.setData({ paymentBusy: false })
            const message = paymentError && paymentError.errMsg ? paymentError.errMsg : ''
            wx.showToast({ title: /cancel/i.test(message) ? '已取消支付' : '支付未完成', icon: 'none' })
          }
        })
      })
    })
  },

  pollPaymentOrder(orderNo, token, attempt) {
    const path = `${PAYMENT_CONFIG.endpoints.queryOrder}/${encodeURIComponent(orderNo)}`
    this.apiRequest(path, { method: 'GET' }, token, (error, response) => {
      if (!error && response && (response.paid === true || response.status === 'SUCCESS' || response.tradeState === 'SUCCESS')) {
        this.setData({ paymentBusy: false })
        this.refreshMemberState()
        wx.showToast({ title: '支付成功，会员状态已刷新', icon: 'success' })
        return
      }
      if (attempt < 3) {
        setTimeout(() => this.pollPaymentOrder(orderNo, token, attempt + 1), 1200)
        return
      }
      this.setData({ paymentBusy: false })
      wx.showModal({
        title: '支付结果确认中',
        content: '微信已返回，但服务端还未确认订单。请稍后在“我的”页面刷新会员状态，不要重复购买。',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  openRedeem() {
    this.redeemRequestKey = ''
    this.setData({ redeemVisible: true, redeemCode: '' })
  },

  closeRedeem() {
    if (!this.data.paymentBusy) {
      this.setData({ redeemVisible: false, redeemCode: '' })
    }
  },

  onRedeemInput(e) {
    this.redeemRequestKey = ''
    this.setData({ redeemCode: String(e.detail && e.detail.value || '').trim() })
  },

  submitRedeem() {
    const code = String(this.data.redeemCode || '').trim()
    if (!code) {
      wx.showToast({ title: '请输入兑换码', icon: 'none' })
      return
    }
    if (!this.getPaymentBaseUrl()) {
      wx.showModal({
        title: '兑换服务尚未配置',
        content: '兑换码必须由已配置的服务端验证，不能在本地直接判定为有效。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    this.setData({ paymentBusy: true })
    if (!this.redeemRequestKey) this.redeemRequestKey = this.makeRequestKey('redeem')
    this.ensureSession((loginError, token) => {
      if (loginError) {
        this.setData({ paymentBusy: false })
        wx.showToast({ title: loginError.message || '登录失败', icon: 'none' })
        return
      }
      this.apiRequest(PAYMENT_CONFIG.endpoints.redeem, {
        method: 'POST',
        data: { code },
        header: { 'Idempotency-Key': this.redeemRequestKey }
      }, token, (error, response) => {
        this.setData({ paymentBusy: false })
        if (error) {
          wx.showToast({ title: error.message || '兑换失败', icon: 'none' })
          return
        }
        const profile = response && (response.memberProfile || response.membership || response)
        if (profile) {
          this.persistMemberProfile(profile)
        }
        this.setData({ redeemVisible: false, redeemCode: '' })
        this.redeemRequestKey = ''
        wx.showToast({ title: '兑换成功', icon: 'success' })
      })
    })
  },

  onTabTap(e) {
    if (this.data.editing) return
    const tab = e.currentTarget.dataset.tab
    const titles = {
      home: '拼豆高级版',
      make: '拼豆制作',
      mine: '我的'
    }
    if (!titles[tab]) {
      return
    }
    this.setData({ activeTab: tab, pageTitle: titles[tab] }, () => {
      if (tab === 'make') {
        this.initCanvas()
      }
    })
  },

  goMake() {
    this.setData({ activeTab: 'make', pageTitle: '拼豆制作' }, () => this.initCanvas())
  },

  goCustomSubmit() { wx.navigateTo({ url: '/subpackages/custom/pages/submit/index' }) },
  goCustomList() { wx.navigateTo({ url: '/subpackages/custom/pages/list/index' }) },
  goCustomMerchant() { wx.navigateTo({ url: '/subpackages/custom/pages/merchant/index' }) },

  onFeatureTap(e) {
    const feature = e.currentTarget.dataset.feature
    wx.showToast({ title: `${feature}功能即将开放`, icon: 'none' })
  },

  openGallery(e) {
    const group = String(e.currentTarget.dataset.group || 'all')
    if (group === '4') {
      this.setData({ expandedIllustrationGroup: this.data.expandedIllustrationGroup === group ? '' : group })
      return
    }
    const modes = { '1': 'tray', '2': 'cards', '3': 'stepper', all: 'all' }
    const mode = modes[group] || 'all'
    wx.navigateTo({
      url: `/subpackages/gallery/pages/index/index?group=${encodeURIComponent(group)}&mode=${mode}`,
      fail: () => wx.showToast({ title: '示例暂时无法打开，请稍后重试', icon: 'none' })
    })
  },

  onHomeIllustrationLoad(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isInteger(index)) this.setData({ [`homeIllustrations[${index}].loaded`]: true, [`homeIllustrations[${index}].failed`]: false })
  },

  onHomeIllustrationError(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isInteger(index)) this.setData({ [`homeIllustrations[${index}].loaded`]: false, [`homeIllustrations[${index}].failed`]: true })
  },

  retryHomeIllustration(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.homeIllustrations[index]
    if (!item) return
    this.setData({ [`homeIllustrations[${index}].renderImage`]: false, [`homeIllustrations[${index}].failed`]: false })
    wx.getImageInfo({
      src: item.image,
      success: () => this.setData({ [`homeIllustrations[${index}].renderImage`]: true }),
      fail: () => this.setData({ [`homeIllustrations[${index}].renderImage`]: true, [`homeIllustrations[${index}].failed`]: true })
    })
  },

  onHomeHeroLoad() { this.setData({ homeHeroLoaded: true, homeHeroFailed: false }) },
  onHomeHeroError() { this.setData({ homeHeroLoaded: false, homeHeroFailed: true }) },
  retryHomeHero() {
    this.setData({ homeHeroFailed: false, homeHeroLoaded: false })
    wx.getImageInfo({
      src: this.data.homeHeroImage,
      success: () => this.setData({ homeHeroLoaded: true }),
      fail: () => this.setData({ homeHeroFailed: true })
    })
  },
  onHomeGuideLoad() { this.setData({ homeGuideLoaded: true, homeGuideFailed: false }) },
  onHomeGuideError() { this.setData({ homeGuideLoaded: false, homeGuideFailed: true }) },
  retryHomeGuide() {
    this.setData({ homeGuideFailed: false, homeGuideLoaded: false })
    wx.getImageInfo({
      src: this.data.galleryGuideImage,
      success: () => this.setData({ homeGuideLoaded: true }),
      fail: () => this.setData({ homeGuideFailed: true })
    })
  },

  previewExpandedExample(e) {
    const imageId = Number(e.currentTarget.dataset.index) + 1
    wx.navigateTo({
      url: `/subpackages/gallery/pages/index/index?group=4&mode=preview&imageId=${imageId}`,
      fail: () => wx.showToast({ title: '作品暂时无法打开，请稍后重试', icon: 'none' })
    })
  },

  openAccountHistory() {
    if (!this.getPaymentBaseUrl()) {
      wx.showModal({ title: '账户记录暂不可用', content: '连接并登录服务端后，才能查看购买、兑换和使用记录。', showCancel: false })
      return
    }
    this.setData({ historyVisible: true, historyLoading: true })
    this.ensureSession((loginError, token) => {
      if (loginError) {
        this.setData({ historyLoading: false })
        wx.showToast({ title: '登录失败，记录未刷新', icon: 'none' })
        return
      }
      this.apiRequest(PAYMENT_CONFIG.endpoints.accountHistory, { method: 'GET' }, token, (error, response) => {
        if (error) {
          this.setData({ historyLoading: false })
          wx.showToast({ title: error.message || '记录暂不可用', icon: 'none' })
          return
        }
        const accountHistory = (response.history || []).map((item) => Object.assign({}, item, {
          timeLabel: item.createdAt ? this.formatRecentTime(new Date(item.createdAt).getTime()) : '',
          amountLabel: item.amountFen ? `¥${(Number(item.amountFen) / 100).toFixed(2)}` : ''
        }))
        this.setData({ accountHistory, historyLoading: false })
      })
    })
  },

  closeAccountHistory() {
    this.setData({ historyVisible: false })
  },

  getRecentPatternCodes(grid) {
    return (grid || []).map((row) => row.map((color) => color && !color.empty ? color.code : ''))
  },

  recordRecentWork(grid, originalPatternCodes) {
    if (!grid || !grid.length) {
      return
    }
    const now = Date.now()
    const codes = this.getRecentPatternCodes(grid)
    const originalCodes = originalPatternCodes && originalPatternCodes.length === codes.length &&
      originalPatternCodes.every((row) => row.length === codes[0].length) ? originalPatternCodes : codes
    const recentWork = {
      id: `local-${now}`,
      name: `拼豆图纸 ${this.data.gridWidth}×${this.data.gridHeight}`,
      previewPath: this.isTemporaryImagePath(this.data.imagePath) ? '' : (this.data.imagePath || ''),
      sourceImagePath: this.isTemporaryImagePath(this.data.imagePath) ? '' : (this.data.imagePath || ''),
      patternCodes: codes,
      originalPatternCodes: originalCodes.map((row) => row.slice()),
      gridWidth: this.data.gridWidth,
      gridHeight: this.data.gridHeight,
      paletteStandard: this.data.paletteStandard,
      paletteSpec: this.data.paletteSpec,
      totalBeads: this.countFilledBeads(grid),
      createdAt: now,
      timeLabel: this.formatRecentTime(now)
    }
    const previous = (this.data.recentWorks || []).filter((item) => item && item.id !== recentWork.id)
    const recentWorks = [recentWork].concat(previous).slice(0, this.getRecentLimit())
    const removedWorks = previous.filter((item) => !recentWorks.some((retained) => retained.id === item.id))
    let stored = true
    try {
      wx.setStorageSync(RECENT_WORKS_STORAGE_KEY, recentWorks)
    } catch (error) {
      stored = false
      console.warn('[membership] failed to cache recent work', error)
    }
    this.setData({ recentWorks })
    this.currentRecentWorkId = recentWork.id
    this.originalPatternCodes = recentWork.originalPatternCodes.map((row) => row.slice())
    this.removeCachedRecentImages(removedWorks, recentWorks)
    this.persistRecentSourceImage(recentWork.id, this.data.imagePath)
    return stored
  },

  updateRecentWork(grid) {
    const id = this.currentRecentWorkId
    const existing = this.findRecentWork(id)
    if (!existing) {
      return this.recordRecentWork(grid, this.originalPatternCodes)
    }
    const updated = Object.assign({}, existing, {
      patternCodes: this.getRecentPatternCodes(grid),
      originalPatternCodes: (existing.originalPatternCodes || this.originalPatternCodes || existing.patternCodes).map((row) => row.slice()),
      totalBeads: this.countFilledBeads(grid)
    })
    const recentWorks = (this.data.recentWorks || []).map((item) => item.id === id ? updated : item)
    let stored = true
    try {
      wx.setStorageSync(RECENT_WORKS_STORAGE_KEY, recentWorks)
    } catch (error) {
      stored = false
      console.warn('[pattern-editor] failed to cache edited pattern', error)
    }
    this.setData({ recentWorks })
    return stored
  },

  formatRecentTime(timestamp) {
    const date = new Date(Number(timestamp) || Date.now())
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  },

  inflateRecentPattern(item) {
    if (!item || !Array.isArray(item.patternCodes) || !item.patternCodes.length) {
      return null
    }
    const colorMap = {}
    PALETTE.forEach((color) => {
      colorMap[color.code] = color
    })
    return item.patternCodes.map((row) => row.map((code) => {
      if (!code) {
        return EMPTY_COLOR
      }
      const color = colorMap[code] || this.findNearestColor([128, 128, 128])
      return this.makeMardColor(color, color.rgb)
    }))
  },

  findRecentWork(id) {
    return (this.data.recentWorks || []).find((item) => item && item.id === id) || null
  },

  openRecentWork(e) {
    if (this.data.editing) return
    const item = this.findRecentWork(String(e.currentTarget.dataset.id || ''))
    if (!item) {
      return
    }
    const grid = this.inflateRecentPattern(item)
    if (!grid) {
      wx.showToast({ title: '该历史记录缺少图纸数据', icon: 'none' })
      return
    }
    this.patternGrid = grid
    this.currentRecentWorkId = item.id
    this.originalPatternCodes = (item.originalPatternCodes || item.patternCodes).map((row) => row.slice())
    this.setData({
      activeTab: 'make',
      pageTitle: '拼豆制作',
      imagePath: this.getRecentSourceImagePath(item),
      gridWidth: Number(item.gridWidth) || grid[0].length,
      gridHeight: Number(item.gridHeight) || grid.length,
      gridSize: Number(item.gridWidth) || grid[0].length,
      customWidth: Number(item.gridWidth) || grid[0].length,
      customHeight: Number(item.gridHeight) || grid.length,
      paletteStandard: item.paletteStandard || this.data.paletteStandard,
      paletteSpec: item.paletteSpec || this.data.paletteSpec,
      patternReady: true,
      totalBeads: this.countFilledBeads(grid),
      colorStats: this.buildColorStats(grid),
      viewMode: 'sheet'
    }, () => {
      this.initCanvas(() => this.drawGrid(grid))
      wx.showToast({ title: '已打开最近图纸', icon: 'none' })
    })
  },

  reExportRecentWork(e) {
    if (this.data.editing) return
    const item = this.findRecentWork(String(e.currentTarget.dataset.id || ''))
    const grid = this.inflateRecentPattern(item)
    if (!item || !grid) {
      wx.showToast({ title: '该历史记录无法导出', icon: 'none' })
      return
    }
    this.patternGrid = grid
    this.currentRecentWorkId = item.id
    this.originalPatternCodes = (item.originalPatternCodes || item.patternCodes).map((row) => row.slice())
    this.setData({
      activeTab: 'make',
      pageTitle: '拼豆制作',
      imagePath: this.getRecentSourceImagePath(item),
      paletteStandard: item.paletteStandard || this.data.paletteStandard,
      paletteSpec: item.paletteSpec || this.data.paletteSpec,
      gridWidth: Number(item.gridWidth) || grid[0].length,
      gridHeight: Number(item.gridHeight) || grid.length,
      gridSize: Number(item.gridWidth) || grid[0].length,
      customWidth: Number(item.gridWidth) || grid[0].length,
      customHeight: Number(item.gridHeight) || grid.length,
      patternReady: true,
      totalBeads: this.countFilledBeads(grid),
      colorStats: this.buildColorStats(grid),
      viewMode: 'sheet'
    }, () => {
      this.initCanvas(() => {
        this.drawGrid(grid)
        setTimeout(() => this.savePattern(), 80)
      })
    })
  },

  deleteRecentWork(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) {
      return
    }
    wx.showModal({
      title: '删除这张图纸？',
      content: '删除后只会移除本机缓存，不影响已经导出的图片。',
      confirmText: '删除',
      confirmColor: '#b4444c',
      success: (result) => {
        if (!result.confirm) {
          return
        }
        const removedWorks = (this.data.recentWorks || []).filter((item) => item.id === id)
        const recentWorks = (this.data.recentWorks || []).filter((item) => item.id !== id)
        try {
          wx.setStorageSync(RECENT_WORKS_STORAGE_KEY, recentWorks)
        } catch (error) {
          console.warn('[membership] failed to delete recent work', error)
        }
        this.setData({ recentWorks })
        this.removeCachedRecentImages(removedWorks, recentWorks)
      }
    })
  },

  showShareHint() {
    wx.showToast({ title: '可使用微信右上角菜单分享', icon: 'none' })
  },

  initCanvas(callback) {
    const query = wx.createSelectorQuery()
    query.select('#patternCanvas').node()
    query.select('#patternCanvas').boundingClientRect()
    query.select('#exportCanvas').node()
    query.exec((res) => {
      if (!res || !res[0] || !res[0].node) {
        if (callback) callback(new Error('图纸画布尚未就绪'))
        return
      }
      this.canvas = res[0].node
      this.canvas.width = CANVAS_SIZE
      this.canvas.height = CANVAS_SIZE
      this.ctx = this.canvas.getContext('2d')
      this.canvasRect = res[1] || { left: 0, top: 0, width: CANVAS_SIZE, height: CANVAS_SIZE }
      this.exportCanvas = res[2] && res[2].node
      if (callback) {
        callback()
      }
    })
  },

  chooseImage() {
    if (this.data.editing) return
    if (this.activeGenerationKey) {
      wx.showModal({
        title: '生成任务仍在确认',
        content: '请先完成或查询当前服务端任务，再更换图片，避免任务结果与当前画面不一致。',
        showCancel: false
      })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) {
          return
        }
        this.setData({
          imagePath: file.tempFilePath,
          patternReady: false,
          viewMode: 'sheet',
          colorStats: [],
          totalBeads: 0
        })
      },
      fail: () => {
        wx.chooseImage({
          count: 1,
          sourceType: ['album', 'camera'],
          success: (res) => {
            const path = res.tempFilePaths && res.tempFilePaths[0]
            if (path) {
              this.setData({
                imagePath: path,
                patternReady: false,
                viewMode: 'sheet',
                colorStats: [],
                totalBeads: 0
              })
            }
          }
        })
      }
    })
  },

  onSizeTap(e) {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    const width = Number(e.currentTarget.dataset.width)
    const height = Number(e.currentTarget.dataset.height)
    if (!width || !height) {
      return
    }
    this.setData({
      gridSize: width,
      gridWidth: width,
      gridHeight: height,
      customWidth: width,
      customHeight: height,
      sizeMode: 'board',
      sheetType: ''
    }, () => {
      if (this.data.imagePath && this.data.patternReady) {
        this.generatePattern()
      }
    })
  },

  openSizeSheet() {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    this.setData({ sheetType: 'size' })
  },

  openPaletteSheet() {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    this.setData({ sheetType: 'palette' })
  },

  openThresholdSheet() {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    this.setData({ sheetType: 'threshold' })
  },

  closeSettingsSheet() {
    this.setData({ sheetType: '' })
  },

  stopSheetTap() {},

  onSizeModeTap(e) {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    const mode = e.currentTarget.dataset.mode
    if (mode !== 'image' && mode !== 'board') {
      return
    }
    this.setData({ sizeMode: mode }, () => {
      if (this.data.imagePath && this.data.patternReady) {
        this.generatePattern()
      }
    })
  },

  onCustomSizeInput(e) {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    const field = e.currentTarget.dataset.field
    const value = Number(e.detail && e.detail.value)
    if (field === 'width') {
      this.setData({ customWidth: value || '' })
    } else if (field === 'height') {
      this.setData({ customHeight: value || '' })
    }
  },

  confirmCustomSize() {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    const width = Math.max(8, Math.min(160, Number(this.data.customWidth) || 52))
    const height = Math.max(8, Math.min(160, Number(this.data.customHeight) || 52))
    this.setData({
      gridSize: width,
      gridWidth: width,
      gridHeight: height,
      customWidth: width,
      customHeight: height,
      sizeMode: 'board',
      sheetType: ''
    }, () => {
      if (this.data.imagePath && this.data.patternReady) {
        this.generatePattern()
      }
    })
  },

  onPaletteTap(e) {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    const paletteSpec = String(e.currentTarget.dataset.spec || '')
    if (!paletteSpec) {
      return
    }
    this.setData({ paletteSpec, sheetType: '' }, () => {
      if (this.data.imagePath && this.data.patternReady) {
        this.generatePattern()
      }
    })
  },

  onThresholdTap(e) {
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    const threshold = String(e.currentTarget.dataset.threshold || '')
    if (!threshold) {
      return
    }
    const selected = this.data.thresholdOptions.find((item) => item.value === threshold)
    this.setData({ threshold, thresholdName: selected ? selected.name : threshold, sheetType: '' }, () => {
      if (this.data.imagePath && this.data.patternReady) {
        this.generatePattern()
      }
    })
  },

  onViewModeTap(e) {
    if (this.data.editing) return
    const mode = e.currentTarget.dataset.mode
    if (mode !== 'sheet' && mode !== 'bead') {
      return
    }
    this.setData({ viewMode: mode }, () => {
      if (this.patternGrid) {
        this.drawGrid(this.patternGrid)
      }
    })
  },

  generatePattern() {
    if (this.data.editing) {
      wx.showToast({ title: '请先保存或放弃图纸编辑', icon: 'none' })
      return
    }
    if (!this.data.imagePath || this.data.generating) {
      return
    }
    if (!this.getPaymentBaseUrl()) {
      if (this.activeGenerationKey) return this.showGenerationPendingHint()
      if (canUseLocalGeneration(wx, this.getPaymentBaseUrl())) {
        if (this.localGenerationNoticeShown) {
          this.generateLocalTestPattern()
          return
        }
        wx.showModal({
          title: '开发版本地测试',
          content: '服务端尚未配置。本次仅在微信开发版手机本地生成；不会扣次，也不会创建服务端任务。正式用户仍须使用服务端生成。',
          confirmText: '继续生成',
          success: (response) => {
            if (!response.confirm) return
            this.localGenerationNoticeShown = true
            this.generateLocalTestPattern()
          }
        })
        return
      }
      wx.showModal({
        title: '服务端生成尚未配置',
        content: '正式版必须由已部署的服务端生成和扣次。请联系管理员完成服务端配置；本地测试仅对微信开发版开放。',
        showCancel: false
      })
      return
    }
    this.setData({ generating: true })
    this.ensureSession((loginError, token) => {
      if (loginError) {
        this.setData({ generating: false })
        wx.showToast({ title: loginError.message || '登录失败', icon: 'none' })
        return
      }
      if (this.activeGenerationKey) {
        this.recoverPatternTaskByKey(token, this.activeGenerationKey, true)
        return
      }
      this.apiRequest(PAYMENT_CONFIG.endpoints.quota, { method: 'GET' }, token, (error, response) => {
        if (error) {
          this.setData({ generating: false })
          wx.showToast({ title: error.message || '额度状态无法确认', icon: 'none' })
          return
        }
        const profile = this.normalizeMemberProfile(response.memberProfile || {})
        this.persistMemberProfile(profile)
        const billable = profile.billingMode !== 'MEMBERSHIP' && profile.billingMode !== 'PERMANENT' && !profile.permanentEntitlement
        if (billable && profile.creditsRemaining < 1) {
          this.setData({ generating: false })
          wx.showModal({
            title: '生成次数不足',
            content: '当前剩余0次。可在“我的”页面购买次数卡或兑换权益。',
            showCancel: false
          })
          return
        }
        const confirmation = billable
          ? `当前剩余 ${profile.creditsRemaining} 次。本次成功生成并保存服务端结果后扣除1次；失败任务会释放预占次数。`
          : '本次由现有会员权益覆盖，不扣次数。服务端成功交付结果后才会完成任务。'
        wx.showModal({
          title: '确认生成拼豆图纸',
          content: confirmation,
          confirmText: '确认生成',
          success: (modal) => {
            if (!modal.confirm) {
              this.setData({ generating: false })
              return
            }
            this.activeGenerationKey = this.makeRequestKey('pattern')
            this.activeGenerationSnapshot = this.getGenerationSnapshot()
            this.uploadPatternTask(token, this.activeGenerationKey)
          },
          fail: () => this.setData({ generating: false })
        })
      })
    })
  },

  generateLocalTestPattern() {
    // 不调用额度、下单或服务端任务接口；开发版结果只留在本机。
    this.setData({ generating: true }, () => {
      this.initCanvas((canvasError) => {
        if (canvasError || !this.canvas || typeof this.canvas.createImage !== 'function') {
          this.setData({ generating: false })
          wx.showToast({ title: '本地画布尚未就绪，请重试', icon: 'none' })
          return
        }
        const imagePath = this.data.imagePath
        const settings = this.getGenerationSnapshot().settings
        const image = this.canvas.createImage()
        image.onload = () => {
          if (this.data.imagePath !== imagePath) {
            this.setData({ generating: false })
            return
          }
          try {
            const result = generateLocalPattern(image, settings, this.canvas)
            this.acceptServerPattern(result)
          } catch (error) {
            console.error('[pattern] local development generation failed', error)
            this.setData({ generating: false })
            wx.showToast({ title: '本地生成失败，请重试', icon: 'none' })
          }
        }
        image.onerror = () => {
          this.setData({ generating: false })
          wx.showToast({ title: '原图无法读取，请重新选择', icon: 'none' })
        }
        image.src = imagePath
      })
    })
  },

  showGenerationPendingHint() {
    wx.showToast({ title: '请先确认当前生成任务状态', icon: 'none' })
  },

  getGenerationSnapshot() {
    return {
      imagePath: this.data.imagePath,
      settings: {
        sizeMode: this.data.sizeMode,
        gridWidth: this.data.gridWidth,
        gridHeight: this.data.gridHeight,
        paletteSpec: String(this.data.paletteSpec),
        threshold: this.data.threshold
      }
    }
  },

  uploadPatternTask(token, requestKey) {
    const snapshot = this.activeGenerationSnapshot || this.getGenerationSnapshot()
    wx.uploadFile({
      url: `${this.getPaymentBaseUrl()}${PAYMENT_CONFIG.endpoints.tasks}`,
      filePath: snapshot.imagePath,
      name: 'image',
      formData: {
        taskType: 'DIRECT_PATTERN',
        settings: JSON.stringify(snapshot.settings)
      },
      header: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': requestKey
      },
      success: (response) => {
        let payload = {}
        try {
          payload = typeof response.data === 'string' ? JSON.parse(response.data) : (response.data || {})
        } catch {
          this.recoverPatternTaskByKey(token, requestKey, false)
          return
        }
        if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
          this.activeGenerationKey = ''
          this.activeGenerationSnapshot = null
          this.setData({ generating: false })
          if (payload.memberProfile) this.persistMemberProfile(payload.memberProfile)
          wx.showToast({ title: payload.message || '生成任务提交失败', icon: 'none' })
          return
        }
        this.handlePatternTaskResponse(token, payload, 0)
      },
      fail: () => this.recoverPatternTaskByKey(token, requestKey, false)
    })
  },

  recoverPatternTaskByKey(token, requestKey, allowResubmit) {
    const path = `${PAYMENT_CONFIG.endpoints.taskByKey}/${encodeURIComponent(requestKey)}`
    this.apiRequest(path, { method: 'GET' }, token, (error, response) => {
      if (error) {
        if (error.statusCode === 404 && allowResubmit) {
          this.uploadPatternTask(token, requestKey)
          return
        }
        this.setData({ generating: false })
        wx.showToast({ title: '生成状态暂无法确认，请再次点击安全重试', icon: 'none' })
        return
      }
      this.handlePatternTaskResponse(token, response, 0)
    })
  },

  handlePatternTaskResponse(token, response, attempt) {
    const taskId = String(response && response.taskId || '')
    const status = String(response && response.status || '')
    if (response && response.memberProfile) this.persistMemberProfile(response.memberProfile)
    if (status === 'SUCCEEDED') {
      this.acceptServerPattern(response.result)
      this.activeGenerationKey = ''
      this.activeGenerationSnapshot = null
      return
    }
    if (status === 'FAILED') {
      this.activeGenerationKey = ''
      this.activeGenerationSnapshot = null
      this.setData({ generating: false })
      wx.showToast({ title: '本次生成失败，预占次数已释放', icon: 'none' })
      return
    }
    if (status !== 'PROCESSING' || !taskId) {
      this.setData({ generating: false })
      wx.showToast({ title: response && response.message || '生成任务状态异常', icon: 'none' })
      return
    }
    if (attempt >= 150) {
      this.setData({ generating: false })
      wx.showModal({
        title: '生成仍在处理中',
        content: '服务端任务尚未确认完成，预占次数暂不结算。再次点击生成会先查询同一任务，不会重复创建或扣次。',
        showCancel: false
      })
      return
    }
    setTimeout(() => {
      this.apiRequest(`${PAYMENT_CONFIG.endpoints.tasks}/${encodeURIComponent(taskId)}`, { method: 'GET' }, token, (error, next) => {
        if (error) {
          this.setData({ generating: false })
          wx.showToast({ title: '生成状态暂无法确认，任务仍可安全查询', icon: 'none' })
          return
        }
        this.handlePatternTaskResponse(token, next, attempt + 1)
      })
    }, 1200)
  },

  acceptServerPattern(result) {
    if (this.data.editing) return
    const codes = result && result.gridCodes
    if (!Array.isArray(codes) || !codes.length || codes.length > 160 || !Array.isArray(codes[0]) || codes[0].length > 160) {
      this.setData({ generating: false })
      wx.showToast({ title: '服务端图纸数据无法读取', icon: 'none' })
      return
    }
    const colorMap = {}
    PALETTE.forEach((color) => { colorMap[color.code] = color })
    const sourceRgbByCode = result.sourceRgbByCode || {}
    let grid
    try {
      grid = codes.map((row) => row.map((code) => {
        if (!code) return EMPTY_COLOR
        const color = colorMap[code]
        if (!color) throw new Error('服务端返回未知色号')
        return this.makeMardColor(color, sourceRgbByCode[code] || color.rgb)
      }))
    } catch (error) {
      this.activeGenerationKey = ''
      this.activeGenerationSnapshot = null
      this.setData({ generating: false })
      wx.showToast({ title: '服务端返回了无法识别的图纸色号', icon: 'none' })
      return
    }
    const columns = grid[0].length
    const rows = grid.length
    this.patternGrid = grid
    this.setData({
      generating: false,
      patternReady: true,
      viewMode: 'sheet',
      gridSize: Math.max(columns, rows),
      gridWidth: columns,
      gridHeight: rows,
      customWidth: columns,
      customHeight: rows,
      totalBeads: this.countFilledBeads(grid),
      colorStats: this.buildColorStats(grid)
    }, () => {
      this.recordRecentWork(grid)
      this.initCanvas(() => this.drawGrid(grid))
    })
  },



  // 把原图完整放入工作画布；只有在背景足够单一、且不会吃掉白色主体时才去背景。
  // 前景只在量化阶段映射到 MARD；这里先保留原图 RGB，供后面的抖动算法还原明暗和细节。


  // 基于原图边缘做“保守型”连通背景分割。
  // 只处理四边高度一致的纯色/近纯色背景；一旦白色区域已侵入主体中心，便宁可保留背景，
  // 也绝不把白衣、白纱、羊毛、眼白等主体细节删成空白。




  // 根据原图色块建立一个自适应纯色调色板。调色板颜色源自照片本身，
  // 因此比直接把画面替换成 MARD 屏幕色更能保留原图的配色关系。

  // MARD 221 是可选色板，不等于一张图必须把 221 种颜色全部用上。
  // 先统计每个网格最可能对应的色号，再限制实际量化色数，避免相近色过多导致画面发灰。


  // 清理量化后孤立的强黄色格。它只作用于原始采样已经属于肤色、或被至少两个
  // 肤色格包围的区域，不会把衣服、头发和真实黄色物体强行改成肤色。

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

  // 用 OKLab 感知距离代替 RGB 欧氏距离，肤色、灰色和黄色的亮度/色相边界
  // 更稳定；仍保留少量亮度约束，避免相近色差异被过度压扁。
  mardColorDistance(first, second) {
    const perceptualDistance = this.oklabDistance(first, second) * 255
    const firstLuminance = first[0] * 0.299 + first[1] * 0.587 + first[2] * 0.114
    const secondLuminance = second[0] * 0.299 + second[1] * 0.587 + second[2] * 0.114
    const luminancePenalty = Math.abs(firstLuminance - secondLuminance) * 0.08
    return perceptualDistance + luminancePenalty
  },

  // 低色号调色板里，深绿色通常比纯黑更容易被“距离 + 抖动误差”选中。
  // 对近黑且低饱和的来源色保留黑色/中性深灰锚点，避免黑衣、黑发和黑色五官整体偏绿。
  // 真正的深绿、深蓝仍要求色彩浓度明显，才会继续走普通最近色匹配。
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

  // 兼容旧数据结构：手动点格时仍可从一组 RGB 找到最近 MARD 色。
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

  // 只删除与四条边相连的背景白格，保留主体内部的白色区域。

  // 人物中间的白色（羊毛、衣服、眼白等）必须是有色号的白色拼豆，
  // 不能随着外部白底一起被删掉。这里取主体在横向与纵向的交叉区域，
  // 将其中的白格从“背景”还原为实际白色豆。

  // 智能深色描边：只保护原图中已存在的深色线稿/五官，不再把所有主体边缘涂成黑色。
  // 对照片、白纱和浅色服装来说，这比“强行补黑边”更接近原图，也不会制造锯齿碎块。



  // 轻度卡通化：提亮对比、提高色彩浓度，但对近黑/近白保持克制。
  // 肤色格只做极轻的对比调整，不额外提高饱和度，避免脸部被推向黄色。
  // 最终仍由拼豆色板映射成一个固定色，因此不会产生渐变或半透明格子。

  // 用逐通道中位色压低抗锯齿边缘带来的灰雾，同时保留平均色对细节的贡献。
  // 小画板额外锚定格子中心：当一个格子横跨明显边界时，中心像素通常比整格平均
  // 更能代表这一颗豆实际应该落在哪一侧，能减少眼睛、嘴巴和外轮廓被冲成灰色。

  // 一个格子只落一个色号。优先使用中心/多数颜色，同时轻微保护深色轮廓，
  // 让眼睛、眉毛、嘴巴、发丝和外轮廓在低尺寸画布上不容易消失。



  countFilledBeads(grid) {
    return grid.reduce((total, row) => total + row.filter((color) => !color.empty).length, 0)
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
  },

  drawGrid(grid) {
    if (!this.ctx) {
      return
    }
    if (this.data.viewMode === 'sheet') {
      this.drawSheetGrid(grid)
      return
    }
    this.drawBeadGrid(grid)
  },

  drawSheetGrid(grid) {
    if (!this.ctx) {
      return
    }
    const rect = this.getPreviewRect(grid)
    this.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    this.drawSheetToContext(this.ctx, grid, rect.left, rect.top, rect.width, false, rect.height)
  },

  getPreviewRect(grid) {
    const rows = grid.length
    const columns = grid[0] ? grid[0].length : 1
    const maxSize = CANVAS_SIZE - 28
    const scale = Math.min(maxSize / columns, maxSize / rows)
    const width = columns * scale
    const height = rows * scale
    return {
      left: (CANVAS_SIZE - width) / 2,
      top: (CANVAS_SIZE - height) / 2,
      width,
      height
    }
  },

  drawSheetToContext(ctx, grid, left, top, gridPixelWidth, showAxes, gridPixelHeight) {
    const rows = grid.length
    const columns = grid[0] ? grid[0].length : 1
    const height = gridPixelHeight || gridPixelWidth
    const cellWidth = gridPixelWidth / columns
    const cellHeight = height / rows
    const smallestCell = Math.min(cellWidth, cellHeight)
    // 参考成品图：普通格线要细而清楚，十格辅助线单独用红色加粗。
    // 不把所有格线都画成粗黑线，否则缩小查看时会糊成一片。
    const lineWidth = showAxes
      ? Math.max(0.8, Math.min(1.35, smallestCell * 0.035))
      : Math.max(0.8, Math.min(1.2, smallestCell * 0.032))
    const fontSize = showAxes
      ? Math.max(8, Math.min(24, smallestCell * 0.38))
      : Math.max(4, Math.min(22, smallestCell * 0.36))

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(left, top, gridPixelWidth, height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `bold ${fontSize}px ${CANVAS_FONT_FAMILY}`
    if (typeof ctx.imageSmoothingEnabled === 'boolean') {
      ctx.imageSmoothingEnabled = false
    }

    grid.forEach((row, rowIndex) => {
      row.forEach((color, colIndex) => {
        const x = left + colIndex * cellWidth
        const y = top + rowIndex * cellHeight
        ctx.fillStyle = color.empty ? '#ffffff' : color.hex
        // 颜色块使用整像素铺满，避免每个格子单独描边造成半透明叠加和模糊。
        ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(cellWidth), Math.ceil(cellHeight))
        ctx.fillStyle = color.empty ? '#c6cdd4' : this.getReadableTextColor(color)
        // 空白背景用浅灰点标记；真正的白色 MARD 豆不是 empty，因此仍会显示白色色号。
        ctx.fillText(color.empty ? '·' : color.code, x + cellWidth / 2, y + cellHeight / 2 + 0.2)
      })
    })

    // 统一绘制网格线，线条落在整数像素上，放大查看时边缘更干净。
    ctx.strokeStyle = showAxes
      ? 'rgba(121, 134, 142, 0.52)'
      : 'rgba(54, 49, 46, 0.46)'
    ctx.lineWidth = lineWidth
    for (let i = 0; i <= columns; i += 1) {
      const position = Math.round(left + i * cellWidth) + 0.5
      ctx.beginPath()
      ctx.moveTo(position, top)
      ctx.lineTo(position, top + height)
      ctx.stroke()
    }
    for (let i = 0; i <= rows; i += 1) {
      const position = Math.round(top + i * cellHeight) + 0.5
      ctx.beginPath()
      ctx.moveTo(left, position)
      ctx.lineTo(left + gridPixelWidth, position)
      ctx.stroke()
    }

    // 每 10 格增加一条醒目的辅助线，方便按区域拼装大图。
    if (showAxes) {
      // 参考图中的红色分区线：每 10 格一条，便于按大格区域拼装。
      ctx.strokeStyle = 'rgba(191, 93, 99, 0.78)'
      ctx.lineWidth = Math.max(1.6, Math.min(3.4, smallestCell * 0.085))
      for (let i = 10; i < columns; i += 10) {
        const position = Math.round(left + i * cellWidth) + 0.5
        ctx.beginPath()
        ctx.moveTo(position, top)
        ctx.lineTo(position, top + height)
        ctx.stroke()
      }
      for (let i = 10; i < rows; i += 10) {
        const position = Math.round(top + i * cellHeight) + 0.5
        ctx.beginPath()
        ctx.moveTo(left, position)
        ctx.lineTo(left + gridPixelWidth, position)
        ctx.stroke()
      }

      const axisFontSize = Math.max(10, Math.min(18, smallestCell * 0.48))
      ctx.fillStyle = '#67747c'
      ctx.font = `${axisFontSize}px ${CANVAS_FONT_FAMILY}`
      for (let i = 0; i < columns; i += 1) {
        const label = String(i + 1)
        const position = i * cellWidth + cellWidth / 2
        ctx.fillText(label, left + position, top - 24)
        ctx.fillText(label, left + position, top + height + 25)
      }
      for (let i = 0; i < rows; i += 1) {
        const label = String(i + 1)
        const position = i * cellHeight + cellHeight / 2
        ctx.fillText(label, left - 34, top + position)
        ctx.fillText(label, left + gridPixelWidth + 34, top + position)
      }
    }

    ctx.strokeStyle = 'rgba(45, 40, 37, 0.82)'
    ctx.lineWidth = Math.max(1, lineWidth + 0.5)
    ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(gridPixelWidth) - 1, Math.round(height) - 1)
  },

  drawBeadGrid(grid) {
    if (!this.ctx) {
      return
    }
    const rows = grid.length
    const columns = grid[0] ? grid[0].length : 1
    const rect = this.getPreviewRect(grid)
    const cellWidth = rect.width / columns
    const cellHeight = rect.height / rows
    const ctx = this.ctx
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

    grid.forEach((row, rowIndex) => {
      row.forEach((color, colIndex) => {
        if (color.empty) {
          return
        }
        const centerX = rect.left + colIndex * cellWidth + cellWidth / 2
        const centerY = rect.top + rowIndex * cellHeight + cellHeight / 2
        // 颗粒尽量铺满单格，只保留很窄的间隙，避免画面中出现大片白缝。
        const radius = Math.max(2.8, Math.min(cellWidth, cellHeight) * 0.49)
        ctx.beginPath()
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
        ctx.fillStyle = color.hex
        ctx.fill()
        ctx.lineWidth = Math.max(0.6, Math.min(cellWidth, cellHeight) * 0.035)
        ctx.strokeStyle = 'rgba(75, 54, 42, 0.30)'
        ctx.stroke()
      })
    })

    ctx.strokeStyle = 'rgba(75, 54, 42, 0.18)'
    ctx.lineWidth = 1
    for (let i = 0; i <= columns; i += 1) {
      const position = rect.left + i * cellWidth
      ctx.beginPath()
      ctx.moveTo(position, rect.top)
      ctx.lineTo(position, rect.top + rect.height)
      ctx.stroke()
    }
    for (let i = 0; i <= rows; i += 1) {
      const position = rect.top + i * cellHeight
      ctx.beginPath()
      ctx.moveTo(rect.left, position)
      ctx.lineTo(rect.left + rect.width, position)
      ctx.stroke()
    }
  },

  // 高清颗粒导出：与图纸模式共用同一份颜色网格，但使用真实像素圆豆绘制，
  // 不把手机预览截图放大，避免颗粒边缘和颜色块被二次插值。
  drawBeadToContext(ctx, grid, left, top, gridPixelWidth, showAxes, gridPixelHeight) {
    const rows = grid.length
    const columns = grid[0] ? grid[0].length : 1
    const height = gridPixelHeight || gridPixelWidth
    const cellWidth = gridPixelWidth / columns
    const cellHeight = height / rows
    const smallestCell = Math.min(cellWidth, cellHeight)
    // 参考真实拼豆排布：圆豆接近满格，避免四周出现明显空白。
    const radius = Math.max(7, smallestCell * 0.49)

    ctx.fillStyle = '#fbfcfe'
    ctx.fillRect(left, top, gridPixelWidth, height)

    grid.forEach((row, rowIndex) => {
      row.forEach((color, colIndex) => {
        if (color.empty) {
          return
        }
        const centerX = left + colIndex * cellWidth + cellWidth / 2
        const centerY = top + rowIndex * cellHeight + cellHeight / 2
        ctx.beginPath()
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
        ctx.fillStyle = color.hex
        ctx.fill()
        ctx.strokeStyle = 'rgba(48, 56, 64, 0.42)'
        ctx.lineWidth = Math.max(1, Math.min(2, smallestCell * 0.035))
        ctx.stroke()

      })
    })

    ctx.strokeStyle = 'rgba(68, 76, 86, 0.22)'
    ctx.lineWidth = Math.max(1, Math.min(2, smallestCell * 0.035))
    for (let i = 0; i <= columns; i += 1) {
      const position = Math.round(left + i * cellWidth) + 0.5
      ctx.beginPath()
      ctx.moveTo(position, top)
      ctx.lineTo(position, top + height)
      ctx.stroke()
    }
    for (let i = 0; i <= rows; i += 1) {
      const position = Math.round(top + i * cellHeight) + 0.5
      ctx.beginPath()
      ctx.moveTo(left, position)
      ctx.lineTo(left + gridPixelWidth, position)
      ctx.stroke()
    }

    if (showAxes) {
      ctx.strokeStyle = 'rgba(49, 57, 69, 0.62)'
      ctx.lineWidth = Math.max(1.5, smallestCell * 0.08)
      for (let i = 10; i < columns; i += 10) {
        const position = Math.round(left + i * cellWidth) + 0.5
        ctx.beginPath()
        ctx.moveTo(position, top)
        ctx.lineTo(position, top + height)
        ctx.stroke()
      }
      for (let i = 10; i < rows; i += 10) {
        const position = Math.round(top + i * cellHeight) + 0.5
        ctx.beginPath()
        ctx.moveTo(left, position)
        ctx.lineTo(left + gridPixelWidth, position)
        ctx.stroke()
      }

      const axisFontSize = Math.max(10, Math.min(18, smallestCell * 0.52))
      ctx.fillStyle = '#45515a'
      ctx.font = `bold ${axisFontSize}px ${CANVAS_FONT_FAMILY}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let i = 0; i < columns; i += 1) {
        const label = String(i + 1)
        const position = i * cellWidth + cellWidth / 2
        ctx.fillText(label, left + position, top - 24)
        ctx.fillText(label, left + position, top + height + 25)
      }
      for (let i = 0; i < rows; i += 1) {
        const label = String(i + 1)
        const position = i * cellHeight + cellHeight / 2
        ctx.fillText(label, left - 34, top + position)
        ctx.fillText(label, left + gridPixelWidth + 34, top + position)
      }
    }

    ctx.strokeStyle = 'rgba(76, 84, 91, 0.72)'
    ctx.lineWidth = Math.max(1.2, Math.min(2.6, smallestCell * 0.065))
    ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(gridPixelWidth) - 1, Math.round(height) - 1)
  },

  getReadableTextColor(color) {
    const luminance = color.rgb[0] * 0.299 + color.rgb[1] * 0.587 + color.rgb[2] * 0.114
    return luminance < 145 ? '#ffffff' : '#26323b'
  },

  buildColorStats(grid) {
    const countMap = {}
    const colorMap = {}
    grid.forEach((row) => {
      row.forEach((color) => {
        if (color.empty) {
          return
        }
        const code = color.code || color.hex
        countMap[code] = (countMap[code] || 0) + 1
        if (!colorMap[code]) {
          const mard = color.mardHex ? color : this.findNearestColor(color.rgb)
          colorMap[code] = {
            name: color.name || mard.name,
            code: color.code || mard.code,
            // 用色清单必须展示实际要购买的 MARD 色，而不是仅用于还原预览的原图 RGB。
            hex: color.mardHex || mard.hex,
            rgb: color.mardRgb || mard.rgb,
            sourceHex: color.sourceRgb ? this.rgbToHex(color.sourceRgb) : color.hex,
            count: 0,
            backup: 0
          }
        }
        colorMap[code].count += 1
        colorMap[code].backup = Math.max(1, Math.ceil(colorMap[code].count * 1.05))
      })
    })
    return Object.keys(countMap)
      .map((code) => colorMap[code])
      .sort((a, b) => b.count - a.count)
  },

  startPatternEdit() {
    if (!this.patternGrid || this.data.generating || this.data.editing) return
    const codes = this.getRecentPatternCodes(this.patternGrid)
    const original = this.originalPatternCodes && this.originalPatternCodes.length === codes.length &&
      this.originalPatternCodes.every((row) => row.length === codes[0].length) ? this.originalPatternCodes : codes
    this.editorSession = createPatternEditor(codes, PALETTE.map((color) => color.code), original)
    this.editorGrid = this.patternGrid.map((row) => row.slice())
    this.editorColors = {}
    PALETTE.forEach((color) => { this.editorColors[color.code] = color })
    this.editorAvailableColors = this.getActivePalette()
    const firstColor = this.patternGrid.reduce((found, row) => found || row.find((color) => !color.empty), null)
    const selected = firstColor || this.editorColors.H2 || PALETTE[0]
    this.editorGesture = null
    this.setData({
      editing: true,
      viewMode: 'sheet',
      editorTool: 'brush',
      editorColorCode: selected.code,
      editorColorHex: selected.hex,
      editorScale: 1,
      editorOffsetX: 0,
      editorOffsetY: 0,
      editorCanUndo: false,
      editorCanRedo: false,
      editorPaletteVisible: false,
      editorPaletteSearch: '',
      editorPaletteOptions: this.editorAvailableColors.map((color) => ({ code: color.code, hex: color.hex }))
    }, () => this.drawGrid(this.editorGrid))
  },

  editorColor(code) {
    if (!code) return EMPTY_COLOR
    const color = this.editorColors && this.editorColors[code]
    return color ? this.makeMardColor(color) : EMPTY_COLOR
  },

  onEditorToolTap(e) {
    const tool = e.currentTarget.dataset.tool
    if (this.data.editing && ['brush', 'pan', 'pick', 'erase'].indexOf(tool) >= 0) this.setData({ editorTool: tool })
  },

  onEditorZoomTap(e) {
    if (!this.data.editing) return
    const action = e.currentTarget.dataset.action
    if (action === 'reset') {
      this.setData({ editorScale: 1, editorOffsetX: 0, editorOffsetY: 0 })
      return
    }
    const scale = Math.max(1, Math.min(8, this.data.editorScale * (action === 'in' ? 1.5 : 1 / 1.5)))
    const factor = scale / this.data.editorScale
    this.setData({ editorScale: scale, editorOffsetX: this.data.editorOffsetX * factor, editorOffsetY: this.data.editorOffsetY * factor })
  },

  openEditorPalette() {
    if (this.data.editing) this.setData({ editorPaletteVisible: true })
  },

  closeEditorPalette() {
    this.setData({ editorPaletteVisible: false }, () => this.initCanvas(() => {
      if (this.editorGrid) this.drawGrid(this.editorGrid)
    }))
  },

  onEditorPaletteSearch(e) {
    const search = String(e.detail.value || '').trim().toUpperCase()
    this.setData({
      editorPaletteSearch: search,
      editorPaletteOptions: this.editorAvailableColors.filter((color) => color.code.indexOf(search) >= 0).map((color) => ({ code: color.code, hex: color.hex }))
    })
  },

  onEditorColorTap(e) {
    const code = String(e.currentTarget.dataset.code || '')
    const color = this.editorColors && this.editorColors[code]
    if (color) this.setData({ editorColorCode: code, editorColorHex: color.hex, editorTool: 'brush', editorPaletteVisible: false }, () => {
      this.initCanvas(() => { if (this.editorGrid) this.drawGrid(this.editorGrid) })
    })
  },

  editorCellAt(x, y, viewport) {
    if (!this.editorGrid) return null
    return clientToCell(x, y, viewport, this.data.editorScale, this.data.editorOffsetX, this.data.editorOffsetY,
      this.getPreviewRect(this.editorGrid), this.editorGrid.length, this.editorGrid[0].length)
  },

  editorTouchStart(e) {
    if (!this.data.editing || this.data.editorPaletteVisible) return
    const touches = (e.touches || []).map((touch) => ({ x: touch.clientX, y: touch.clientY }))
    if (!touches.length) return
    const token = { lastPoint: touches[0], endPoint: null }
    this.editorPendingTouch = token
    wx.createSelectorQuery().select('#editorViewport').boundingClientRect().exec((rects) => {
      if (this.editorPendingTouch !== token || !this.data.editing || !rects || !rects[0]) return
      this.editorPendingTouch = null
      const viewport = rects[0]
      this.editorViewportRect = viewport
      if (touches.length >= 2) {
        this.editorSession.finishStroke()
        this.finishEditorStroke()
        const midpoint = { x: (touches[0].x + touches[1].x) / 2, y: (touches[0].y + touches[1].y) / 2 }
        const distance = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y)
        this.editorGesture = { type: 'pinch', midpoint, distance, scale: this.data.editorScale,
          offsetX: this.data.editorOffsetX, offsetY: this.data.editorOffsetY, viewport }
        return
      }
      const point = touches[0]
      const latestPoint = token.endPoint || token.lastPoint
      if (this.data.editorTool === 'pan') {
        if (token.endPoint) {
          this.setData({ editorOffsetX: this.data.editorOffsetX + latestPoint.x - point.x,
            editorOffsetY: this.data.editorOffsetY + latestPoint.y - point.y })
          return
        }
        this.editorGesture = { type: 'pan', x: point.x, y: point.y, offsetX: this.data.editorOffsetX, offsetY: this.data.editorOffsetY }
        return
      }
      const cell = this.editorCellAt(latestPoint.x, latestPoint.y, viewport)
      if (!cell) return
      if (this.data.editorTool === 'pick') {
        const code = this.editorSession.draft[cell.row][cell.col]
        const color = this.editorColors[code]
        this.setData(code ? { editorColorCode: code, editorColorHex: color.hex, editorTool: 'brush' } : { editorTool: 'erase' })
        this.editorLastTouch = { x: latestPoint.x, y: latestPoint.y, at: Date.now() }
        return
      }
      const firstCell = this.editorCellAt(point.x, point.y, viewport)
      this.editorSession.startStroke()
      this.paintEditorCells(firstCell ? lineCells(firstCell, cell) : [cell])
      if (token.endPoint) {
        this.editorLastTouch = { x: latestPoint.x, y: latestPoint.y, at: Date.now() }
        this.editorSession.finishStroke()
        this.finishEditorStroke()
      } else {
        this.editorGesture = { type: 'paint', last: cell }
      }
    })
  },

  editorTouchMove(e) {
    const gesture = this.editorGesture
    const touches = e.touches || []
    if (!this.data.editing || !touches.length) return
    if (!gesture) {
      if (this.editorPendingTouch && touches.length === 1) {
        this.editorPendingTouch.lastPoint = { x: touches[0].clientX, y: touches[0].clientY }
      }
      return
    }
    if (gesture.type === 'pan') {
      if (touches.length !== 1) return
      this.setData({ editorOffsetX: gesture.offsetX + touches[0].clientX - gesture.x,
        editorOffsetY: gesture.offsetY + touches[0].clientY - gesture.y })
      return
    }
    if (gesture.type === 'pinch') {
      if (touches.length < 2) return
      const midpoint = { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 }
      const distance = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
      const scale = Math.max(1, Math.min(8, gesture.scale * distance / Math.max(1, gesture.distance)))
      const v = gesture.viewport
      const anchorX = (gesture.midpoint.x - v.left - v.width / 2 - gesture.offsetX) / gesture.scale
      const anchorY = (gesture.midpoint.y - v.top - v.height / 2 - gesture.offsetY) / gesture.scale
      this.setData({ editorScale: scale, editorOffsetX: midpoint.x - v.left - v.width / 2 - anchorX * scale,
        editorOffsetY: midpoint.y - v.top - v.height / 2 - anchorY * scale })
      return
    }
    if (touches.length !== 1) return
    const cell = this.editorCellAt(touches[0].clientX, touches[0].clientY, this.editorViewportRect)
    if (!cell) return
    this.paintEditorCells(lineCells(gesture.last, cell))
    gesture.last = cell
  },

  editorTouchEnd(e) {
    if (this.editorPendingTouch && !this.editorGesture) {
      const touch = e.changedTouches && e.changedTouches[0]
      if (e.type === 'touchcancel' || !touch) this.editorPendingTouch = null
      else this.editorPendingTouch.endPoint = { x: touch.clientX, y: touch.clientY }
      return
    }
    this.editorPendingTouch = null
    if (!this.editorGesture) {
      return
    }
    if (this.editorGesture.type === 'paint' && e.changedTouches && e.changedTouches[0]) {
      const touch = e.changedTouches[0]
      this.editorLastTouch = { x: touch.clientX, y: touch.clientY, at: Date.now() }
      const cell = this.editorCellAt(touch.clientX, touch.clientY, this.editorViewportRect)
      if (cell) this.paintEditorCells(lineCells(this.editorGesture.last, cell))
      this.editorSession.finishStroke()
      this.finishEditorStroke()
    }
    this.editorGesture = null
  },

  // 兼容开发者工具的鼠标单击，以及真机在视口查询结束前完成的快速点按。
  editorCanvasTap(e) {
    if (!this.data.editing || this.data.editorPaletteVisible || this.data.editorTool === 'pan') return
    const touch = e.changedTouches && e.changedTouches[0]
    const detail = e.detail || {}
    if (!touch && (!Number.isFinite(detail.x) || !Number.isFinite(detail.y))) return
    const query = wx.createSelectorQuery()
    query.select('#editorViewport').boundingClientRect()
    query.selectViewport().scrollOffset()
    query.exec((results) => {
      if (!this.data.editing || !results || !results[0]) return
      const viewport = results[0]
      const raw = touch ? { x: touch.clientX, y: touch.clientY } : { x: detail.x, y: detail.y }
      const scroll = results[1] || {}
      const point = !touch && (raw.x < viewport.left || raw.x >= viewport.right || raw.y < viewport.top || raw.y >= viewport.bottom)
        ? { x: raw.x - (scroll.scrollLeft || 0), y: raw.y - (scroll.scrollTop || 0) } : raw
      const last = this.editorLastTouch
      if (last && Date.now() - last.at < 500 && Math.hypot(point.x - last.x, point.y - last.y) < 8) return
      const cell = this.editorCellAt(point.x, point.y, viewport)
      if (!cell) return
      this.editorLastTouch = { x: point.x, y: point.y, at: Date.now() }
      if (this.data.editorTool === 'pick') {
        const code = this.editorSession.draft[cell.row][cell.col]
        const color = this.editorColors[code]
        this.setData(code ? { editorColorCode: code, editorColorHex: color.hex, editorTool: 'brush' } : { editorTool: 'erase' })
        return
      }
      this.editorSession.startStroke()
      this.paintEditorCells([cell])
      this.editorSession.finishStroke()
      this.finishEditorStroke()
    })
  },

  paintEditorCells(cells) {
    const code = this.data.editorTool === 'erase' ? '' : this.data.editorColorCode
    cells.forEach((cell) => {
      if (!this.editorSession.paint(cell.row, cell.col, code)) return
      this.editorGrid[cell.row][cell.col] = this.editorColor(code)
      this.drawEditorCell(cell.row, cell.col)
    })
  },

  drawEditorCell(row, col) {
    if (!this.ctx || !this.editorGrid) return
    const grid = this.editorGrid
    const rect = this.getPreviewRect(grid)
    const width = rect.width / grid[0].length
    const height = rect.height / grid.length
    const x = rect.left + col * width
    const y = rect.top + row * height
    const color = grid[row][col]
    const ctx = this.ctx
    ctx.fillStyle = color.empty ? '#ffffff' : color.hex
    ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(width), Math.ceil(height))
    ctx.fillStyle = color.empty ? '#c6cdd4' : this.getReadableTextColor(color)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `bold ${Math.max(4, Math.min(22, Math.min(width, height) * 0.36))}px ${CANVAS_FONT_FAMILY}`
    ctx.fillText(color.empty ? '·' : color.code, x + width / 2, y + height / 2 + 0.2)
    ctx.strokeStyle = 'rgba(54, 49, 46, 0.46)'
    ctx.lineWidth = Math.max(0.8, Math.min(1.2, Math.min(width, height) * 0.032))
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(width), Math.round(height))
  },

  finishEditorStroke() {
    if (!this.editorSession) return
    this.drawGrid(this.editorGrid)
    this.setData({ totalBeads: this.countFilledBeads(this.editorGrid), colorStats: this.buildColorStats(this.editorGrid),
      editorCanUndo: this.editorSession.canUndo(), editorCanRedo: this.editorSession.canRedo() })
  },

  syncEditorGrid() {
    this.editorGrid = this.editorSession.draft.map((row) => row.map((code) => this.editorColor(code)))
    this.finishEditorStroke()
  },

  undoPatternEdit() { if (this.editorSession && this.editorSession.undo()) this.syncEditorGrid() },
  redoPatternEdit() { if (this.editorSession && this.editorSession.redo()) this.syncEditorGrid() },
  restoreOriginalPattern() { if (this.editorSession && this.editorSession.restoreOriginal()) this.syncEditorGrid() },

  cancelPatternEdit() {
    if (!this.data.editing) return
    this.editorSession = null
    this.editorGrid = null
    this.editorGesture = null
    this.setData({ editing: false, editorPaletteVisible: false, totalBeads: this.countFilledBeads(this.patternGrid),
      colorStats: this.buildColorStats(this.patternGrid), editorScale: 1, editorOffsetX: 0, editorOffsetY: 0 }, () => this.drawGrid(this.patternGrid))
  },

  savePatternEdit() {
    if (!this.data.editing || !this.editorSession) return
    this.editorSession.finishStroke()
    const savedGrid = this.editorSession.copyDraft().map((row) => row.map((code) => this.editorColor(code)))
    this.patternGrid = savedGrid
    const stored = this.updateRecentWork(savedGrid)
    this.editorSession = null
    this.editorGrid = null
    this.editorGesture = null
    this.setData({ editing: false, editorPaletteVisible: false, totalBeads: this.countFilledBeads(savedGrid),
      colorStats: this.buildColorStats(savedGrid), editorScale: 1, editorOffsetX: 0, editorOffsetY: 0 }, () => this.drawGrid(savedGrid))
    wx.showToast(stored
      ? { title: '修改已保存，可直接导出', icon: 'success' }
      : { title: '当前可导出，历史保存失败', icon: 'none' })
  },

  savePattern() {
    if (this.data.editing) return
    if (!this.canvas || !this.patternGrid) {
      return
    }
    const colorStats = this.buildColorStats(this.patternGrid)
    const metrics = this.getExportMetrics(colorStats)
    const exportMode = this.data.viewMode === 'bead' ? 'bead' : 'sheet'
    wx.showLoading({ title: exportMode === 'bead' ? '正在生成高清颗粒图' : '正在生成高清图纸' })
    if (this.exportCanvas) {
      this.saveCanvasAsPattern(this.exportCanvas, colorStats, metrics, false, exportMode)
      return
    }

    // 页面内的主画布始终可用，作为旧基础库或节点查询失败时的备用方案。
    this.saveComposedWithVisibleCanvas(colorStats, metrics, exportMode)
  },

  getExportMetrics(colorStats) {
    const rows = this.patternGrid.length
    const columns = this.patternGrid[0] ? this.patternGrid[0].length : 1
    const maxDimension = Math.max(rows, columns)
    // 以每格的实际像素数为核心计算高清图，而不是先缩放到手机预览尺寸。
    // 4096 是微信和常见图片查看器更稳妥的单边上限；在上限内尽可能放大格子。
    const preferredCellSize = maxDimension <= 64
      ? 44
      : maxDimension <= 78
        ? 36
        : maxDimension <= 104
          ? 30
          : 25
    // 颜色少时尽量像参考成品一样横向排满一行；颜色多时自动换行。
    // 128 格以上的图纸经常有 60–80 个实际色号，16 列比 18 列给数量文字
    // 留出更宽的单元格，也能避免导出图缩小后“只有色块、看不见数量”。
    const legendColumns = colorStats.length <= 15
      ? Math.max(1, colorStats.length)
      : maxDimension >= 128 ? 16 : maxDimension >= 96 ? 14 : 12
    // 旧布局在 128 格以上使用 62px 行高，但数量文字的基线已经落到下一行，
    // 导出后会与下一个色块重叠或被裁掉。行高必须覆盖“色块 + 数量 + 间距”。
    const legendItemHeight = maxDimension >= 128 ? 84 : maxDimension >= 96 ? 76 : 78
    const legendRows = Math.ceil(colorStats.length / legendColumns)
    const legendTopOffset = 84
    const legendBottom = 52 + legendRows * legendItemHeight + 54
    const maxCellByHeight = Math.floor((EXPORT_MAX_EDGE - EXPORT_GRID_TOP - legendTopOffset - legendBottom) / rows)
    const maxCellByWidth = Math.floor((EXPORT_MAX_EDGE - EXPORT_MARGIN_X * 2) / columns)
    const cellSize = Math.max(16, Math.min(preferredCellSize, maxCellByHeight, maxCellByWidth))
    const gridWidth = columns * cellSize
    const gridHeight = rows * cellSize
    const marginX = Math.max(EXPORT_MARGIN_X, Math.ceil(cellSize * 5))
    const width = Math.max(EXPORT_MIN_WIDTH, gridWidth + marginX * 2)
    const legendTop = EXPORT_GRID_TOP + gridHeight + 84
    const height = legendTop + 52 + legendRows * legendItemHeight + 54
    return {
      width,
      height,
      gridWidth,
      gridHeight,
      marginX,
      gridTop: EXPORT_GRID_TOP,
      legendTop,
      legendColumns,
      legendItemHeight,
      cellSize
    }
  },

  saveComposedWithVisibleCanvas(colorStats, metrics, exportMode) {
    if (!this.canvas) {
      wx.hideLoading()
      wx.showToast({ title: '导出失败，请重试', icon: 'none' })
      return
    }

    this.saveCanvasAsPattern(this.canvas, colorStats, metrics, true, exportMode)
  },

  saveCanvasAsPattern(exportCanvas, colorStats, metrics, restorePreview, exportMode) {
    try {
      exportCanvas.width = metrics.width
      exportCanvas.height = metrics.height
      const ctx = exportCanvas.getContext('2d')
      if (typeof ctx.imageSmoothingEnabled === 'boolean') {
        ctx.imageSmoothingEnabled = false
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, metrics.width, metrics.height)
      const isBeadExport = exportMode === 'bead'
      ctx.fillStyle = '#232a31'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `bold 34px ${CANVAS_FONT_FAMILY}`
      const exportTitle = isBeadExport
        ? '拼豆颗粒效果图'
        : `${this.data.paletteStandard} ${this.data.paletteSpec} 拼豆图纸`
      ctx.fillText(exportTitle, metrics.width / 2, 58)
      ctx.fillStyle = '#7d8a92'
      ctx.font = `20px ${CANVAS_FONT_FAMILY}`
      ctx.fillText(`【${this.patternGrid[0].length}×${this.patternGrid.length}/${colorStats.length}色/共${this.data.totalBeads}颗】`, metrics.width / 2, 102)

      if (isBeadExport) {
        this.drawBeadToContext(ctx, this.patternGrid, metrics.marginX, metrics.gridTop, metrics.gridWidth, true, metrics.gridHeight)
      } else {
        this.drawSheetToContext(ctx, this.patternGrid, metrics.marginX, metrics.gridTop, metrics.gridWidth, true, metrics.gridHeight)
      }
      this.drawExportLegend(ctx, colorStats, metrics)

      // Canvas 2D 在部分 iPhone/开发者工具环境里需要至少经过一帧渲染，
      // 直接调用 canvasToTempFilePath 会偶发返回“导出失败”。
      const exportNow = () => {
        this.exportCanvasToFile(exportCanvas, metrics.width, metrics.height, (error, filePath) => {
          if (!error && filePath) {
            if (restorePreview) {
              this.restorePreviewCanvas()
            }
            wx.hideLoading()
            this.saveToAlbum(filePath)
            return
          }

          // 专用导出画布失败时，再用页面内主画布重试一次，兼容部分基础库。
          if (!restorePreview && exportCanvas !== this.canvas) {
            this.saveComposedWithVisibleCanvas(colorStats, metrics, exportMode)
            return
          }
          if (restorePreview) {
            this.restorePreviewCanvas()
          }
          wx.hideLoading()
          this.showExportError(error)
        })
      }
      if (typeof exportCanvas.requestAnimationFrame === 'function') {
        exportCanvas.requestAnimationFrame(exportNow)
      } else if (wx.nextTick) {
        wx.nextTick(() => setTimeout(exportNow, 60))
      } else {
        setTimeout(exportNow, 60)
      }
    } catch (error) {
      if (!restorePreview && exportCanvas !== this.canvas) {
        this.saveComposedWithVisibleCanvas(colorStats, metrics, exportMode)
        return
      }
      if (restorePreview) {
        this.restorePreviewCanvas()
      }
      wx.hideLoading()
      this.showExportError(error)
    }
  },

  exportCanvasToFile(exportCanvas, exportWidth, exportHeight, callback) {
    const finish = (error, filePath) => {
      if (!error && filePath) {
        callback(null, filePath)
        return
      }

      // iOS/Mac 的部分基础库对 2D Canvas 的 canvasToTempFilePath 兼容性不稳定，
      // 这里用 Canvas.toDataURL 写入用户目录，绕过同一套导出接口。
      if (exportCanvas && typeof exportCanvas.toDataURL === 'function') {
        try {
          const dataUrl = exportCanvas.toDataURL('image/png')
          if (!dataUrl || dataUrl.indexOf('base64,') < 0) {
            callback(error || new Error('Canvas.toDataURL 返回内容为空'))
            return
          }
          const base64 = dataUrl.split('base64,')[1]
          const filePath = `${wx.env.USER_DATA_PATH}/bead-pattern-${Date.now()}.png`
          wx.getFileSystemManager().writeFile({
            filePath,
            data: base64,
            encoding: 'base64',
            success: () => callback(null, filePath),
            fail: (writeError) => callback(writeError || error)
          })
          return
        } catch (dataUrlError) {
          callback(dataUrlError || error)
          return
        }
      }

      callback(error || new Error('当前微信基础库不支持 Canvas 导出'))
    }

    try {
      wx.canvasToTempFilePath({
        canvas: exportCanvas,
        x: 0,
        y: 0,
        width: exportWidth,
        height: exportHeight,
        destWidth: exportWidth,
        destHeight: exportHeight,
        fileType: 'png',
        success: (res) => finish(null, res && res.tempFilePath),
        fail: finish
      })
    } catch (error) {
      finish(error)
    }
  },

  showExportError(error) {
    const message = (error && (error.errMsg || error.message)) || ''
    if (error) {
      console.error('[bead-pattern] export failed', error)
    }
    wx.showModal({
      title: '图纸导出失败',
      content: message ? `导出接口返回：${message}` : '请重新生成图纸后再试。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  restorePreviewCanvas() {
    if (!this.canvas) {
      return
    }
    this.canvas.width = CANVAS_SIZE
    this.canvas.height = CANVAS_SIZE
    this.ctx = this.canvas.getContext('2d')
    if (this.patternGrid) {
      this.drawGrid(this.patternGrid)
    }
  },

  drawExportLegend(ctx, colorStats, metrics) {
    const legendTop = metrics.legendTop
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#303942'
    ctx.font = `bold 25px ${CANVAS_FONT_FAMILY}`
    ctx.fillText(`用色清单（${colorStats.length}种）`, metrics.marginX, legendTop)

    const itemWidth = (metrics.width - metrics.marginX * 2) / metrics.legendColumns
    colorStats.forEach((color, index) => {
      const column = index % metrics.legendColumns
      const row = Math.floor(index / metrics.legendColumns)
      const x = metrics.marginX + column * itemWidth
      const y = legendTop + 38 + row * metrics.legendItemHeight
      const swatchWidth = itemWidth - 18
      const swatchHeight = Math.max(34, Math.min(46, metrics.cellSize * 1.7))

      ctx.fillStyle = color.hex
      ctx.fillRect(x, y, swatchWidth, swatchHeight)
      ctx.strokeStyle = 'rgba(40, 40, 40, 0.4)'
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 0.5, swatchWidth - 1, swatchHeight - 1)
      ctx.fillStyle = this.getReadableTextColor(color)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `bold ${Math.max(16, Math.min(22, metrics.cellSize * 0.76))}px ${CANVAS_FONT_FAMILY}`
      ctx.fillText(color.code, x + swatchWidth / 2, y + swatchHeight / 2)
      ctx.fillStyle = '#4b555d'
      ctx.textBaseline = 'top'
      ctx.font = `bold ${Math.max(16, Math.min(21, metrics.cellSize * 0.72))}px ${CANVAS_FONT_FAMILY}`
      ctx.fillText(`x ${color.count} · 备 ${color.backup || Math.max(1, Math.ceil(color.count * 1.05))}`, x + swatchWidth / 2, y + swatchHeight + 8)
    })
  },

  saveVisiblePattern() {
    if (!this.canvas) {
      wx.showToast({ title: '图纸画布未准备好', icon: 'none' })
      return
    }
    this.exportCanvasToFile(this.canvas, CANVAS_SIZE, CANVAS_SIZE, (error, filePath) => {
      if (error || !filePath) {
        this.showExportError(error)
        return
      }
      this.saveToAlbum(filePath)
    })
  },

  saveToAlbum(filePath) {
    const save = () => {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: () => {
          wx.showToast({ title: '已保存到相册', icon: 'success' })
        },
        fail: (error) => {
          const message = (error && error.errMsg) || ''
          if (/auth|permission|denied|authorize/i.test(message)) {
            wx.showModal({
              title: '需要相册权限',
              content: '请在设置中允许保存图片到相册。',
              confirmText: '去设置',
              success: (modalRes) => {
                if (modalRes.confirm) {
                  wx.openSetting()
                }
              }
            })
            return
          }

          wx.showModal({
            title: '开发者工具暂不支持直接存相册',
            content: '图纸已经生成。点击确定打开大图后，可在预览页长按图片保存；真机测试时会直接保存到相册。',
            confirmText: '打开大图',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.previewImage({ urls: [filePath] })
              }
            }
          })
        }
      })
    }

    wx.getSetting({
      success: (setting) => {
        const albumScope = setting.authSetting && setting.authSetting['scope.writePhotosAlbum']
        if (albumScope === false) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存图片到相册。',
            confirmText: '去设置',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting()
              }
            }
          })
          return
        }
        if (albumScope === true) {
          save()
          return
        }
        wx.authorize({
          scope: 'scope.writePhotosAlbum',
          success: save,
          fail: save
        })
      },
      fail: save
    })
  },

  clearAll() {
    if (this.data.editing) return
    if (this.activeGenerationKey) return this.showGenerationPendingHint()
    this.patternGrid = null
    if (this.ctx) {
      this.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    }
    this.setData({
      imagePath: '',
      patternReady: false,
      viewMode: 'sheet',
      colorStats: [],
      totalBeads: 0
    })
  }
})
