const { PAYMENT_CONFIG } = require('../../pages/index/membership-config')
const TOKEN_KEY = 'pinbead.sessionToken.v1'

function baseUrl() {
  const url = String(PAYMENT_CONFIG.apiBaseUrl || '').replace(/\/$/, '')
  if (!url) throw new Error('人工服务尚未连接服务端')
  return url
}

function requestRaw(path, method, data, token, key) {
  return new Promise((resolve, reject) => wx.request({
    url: `${baseUrl()}${path}`, method: method || 'GET', data,
    header: Object.assign({ 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      key ? { 'Idempotency-Key': key } : {}),
    success(response) {
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data || {})
      else {
        const error = new Error(response.data?.message || `请求失败 (${response.statusCode})`)
        error.statusCode = response.statusCode
        reject(error)
      }
    }, fail(error) { reject(new Error(error.errMsg || '网络请求失败')) }
  }))
}

function login() {
  let url
  try { url = `${baseUrl()}${PAYMENT_CONFIG.endpoints.login}` } catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => wx.login({
    success(result) {
      if (!result.code) return reject(new Error('微信登录失败'))
      wx.request({ url, method: 'POST',
        header: { 'content-type': 'application/json' }, data: { code: result.code },
        success(response) {
          if (response.statusCode !== 200 || !response.data?.token) return reject(new Error(response.data?.message || '登录服务不可用'))
          wx.setStorageSync(TOKEN_KEY, response.data.token)
          resolve(response.data.token)
        }, fail(error) { reject(new Error(error.errMsg || '登录失败')) }
      })
    }, fail(error) { reject(new Error(error.errMsg || '微信登录失败')) }
  }))
}

function token() {
  const cached = wx.getStorageSync(TOKEN_KEY)
  return cached ? Promise.resolve(cached) : login()
}

async function request(path, method, data, key) {
  let session = await token()
  try { return await requestRaw(path, method, data, session, key) } catch (error) {
    if (error.statusCode !== 401) throw error
    wx.removeStorageSync(TOKEN_KEY)
    session = await login()
    return requestRaw(path, method, data, session, key)
  }
}

function upload(filePath, kind, orderId) {
  return token().then((session) => new Promise((resolve, reject) => {
    const query = `kind=${encodeURIComponent(kind)}${orderId ? `&orderId=${encodeURIComponent(orderId)}` : ''}`
    wx.uploadFile({
      url: `${baseUrl()}/api/custom/files?${query}`, filePath, name: 'file',
      header: { Authorization: `Bearer ${session}` },
      success(response) {
        let payload = {}
        try { payload = JSON.parse(response.data || '{}') } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300 && payload.file?.id) resolve(payload.file)
        else reject(new Error(payload.message || `上传失败 (${response.statusCode})`))
      }, fail(error) { reject(new Error(error.errMsg || '图片上传失败')) }
    })
  }))
}

function download(fileId) {
  return token().then((session) => new Promise((resolve, reject) => {
    wx.downloadFile({ url: `${baseUrl()}/api/custom/files/${encodeURIComponent(fileId)}`,
      header: { Authorization: `Bearer ${session}` },
      success(response) {
        if (response.statusCode === 200 && response.tempFilePath) resolve(response.tempFilePath)
        else reject(new Error(`文件下载失败 (${response.statusCode})`))
      }, fail(error) { reject(new Error(error.errMsg || '文件下载失败')) }
    })
  }))
}

function newKey(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function toastError(error) {
  wx.showToast({ title: error.message || '操作失败', icon: 'none', duration: 3000 })
}

module.exports = { request, upload, download, newKey, toastError }
