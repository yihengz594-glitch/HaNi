// 本地生成仅用于微信开发版验收；正式版始终需要服务端可信生成和扣次。
function canUseLocalGeneration(wxApi, apiBaseUrl) {
  if (apiBaseUrl || !wxApi || typeof wxApi.getAccountInfoSync !== 'function') {
    return false
  }
  try {
    const account = wxApi.getAccountInfoSync()
    return Boolean(account && account.miniProgram && account.miniProgram.envVersion === 'develop')
  } catch (error) {
    return false
  }
}

module.exports = { canUseLocalGeneration }
