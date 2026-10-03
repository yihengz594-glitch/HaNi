// 体验版免费模式下，所有环境都先使用本机生成；关闭该开关后保留原来的
// “仅微信开发版、且没有服务端地址”兜底逻辑，方便后续恢复服务端生成和扣次。
function canUseLocalGeneration(wxApi, apiBaseUrl, policy) {
  if (policy && policy.allowLocalForAll === true) {
    return Boolean(wxApi)
  }
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
