(() => {
  const $ = (selector) => document.querySelector(selector)
  const csrfHeader = 'X-CSRF-Token'
  let csrfToken = ''
  let latestBatch = null
  let toastTimer = null
  const escapeDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

  function notify(message, isError = true) {
    const node = $('#toast')
    node.textContent = message || ''
    node.classList.toggle('danger', Boolean(isError))
    clearTimeout(toastTimer)
    if (message) toastTimer = setTimeout(() => { node.textContent = '' }, 5200)
  }

  async function api(path, options = {}) {
    const method = options.method || 'GET'
    const headers = Object.assign({}, options.headers || {})
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (!['GET', 'HEAD'].includes(method)) headers[csrfHeader] = csrfToken
    const response = await fetch(`/api/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.message || payload.error || `请求失败 (${response.status})`)
    return payload
  }

  function toggleLoggedIn(isLoggedIn) {
    $('#loginPanel').hidden = isLoggedIn
    $('#dashboard').hidden = !isLoggedIn
  }

  function appendCell(row, value) {
    const cell = document.createElement('td')
    cell.textContent = value === null || value === undefined || value === '' ? '—' : String(value)
    row.appendChild(cell)
    return cell
  }

  function appendButton(parent, text, onClick, danger = false) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = danger ? 'secondary danger' : 'secondary'
    button.textContent = text
    button.addEventListener('click', onClick)
    parent.appendChild(button)
    return button
  }

  async function loadProducts() {
    const response = await fetch('/api/products', { credentials: 'same-origin' })
    const payload = await response.json()
    if (!response.ok || !Array.isArray(payload.products)) throw new Error(payload.message || '商品列表加载失败')
    const select = $('#productId')
    select.replaceChildren()
    payload.products.forEach((product) => {
      const option = document.createElement('option')
      option.value = product.id
      option.textContent = `${product.name} · ${product.priceLabel}`
      select.appendChild(option)
    })
  }

  async function loadBatches() {
    const [batchData, overview] = await Promise.all([api('/batches'), api('/overview')])
    const rows = $('#batchesRows')
    rows.replaceChildren()
    const filter = $('#batchFilter')
    const selected = filter.value
    filter.replaceChildren(new Option('全部批次', ''))
    batchData.batches.forEach((batch) => {
      const row = document.createElement('tr')
      appendCell(row, `${batch.product_name} · ${batch.note || '无备注'}`)
      appendCell(row, batch.existing_count ?? batch.code_count)
      appendCell(row, batch.unused_count)
      appendCell(row, batch.redeemed_count)
      appendCell(row, `${batch.disabled_count} / ${batch.expired_count}`)
      appendCell(row, escapeDate(batch.created_at))
      const actionCell = document.createElement('td')
      appendButton(actionCell, '查看本批', async () => {
        $('#batchFilter').value = batch.id
        await loadCodes()
      })
      if (Number(batch.unused_count) > 0) appendButton(actionCell, '停用未兑换码', () => disableBatch(batch.id), true)
      row.appendChild(actionCell)
      rows.appendChild(row)
      const option = new Option(`${batch.product_name} · ${batch.note || batch.id.slice(0, 8)}`, batch.id)
      filter.appendChild(option)
    })
    if ([...filter.options].some((option) => option.value === selected)) filter.value = selected
    $('#batchCount').textContent = String(batchData.batches.length)
    $('#userCount').textContent = String(overview.userCount ?? '—')
  }

  async function loadCodes() {
    const query = new URLSearchParams()
    if ($('#batchFilter').value) query.set('batchId', $('#batchFilter').value)
    if ($('#statusFilter').value) query.set('status', $('#statusFilter').value)
    const data = await api(`/codes${query.size ? `?${query}` : ''}`)
    const rows = $('#codesRows')
    rows.replaceChildren()
    data.codes.forEach((code) => {
      const row = document.createElement('tr')
      appendCell(row, code.product_name)
      appendCell(row, code.effective_status)
      appendCell(row, code.redeemed_by || '—')
      appendCell(row, escapeDate(code.redeemed_at))
      appendCell(row, escapeDate(code.expires_at))
      const actionCell = document.createElement('td')
      if (code.effective_status === 'UNREDEEMED') appendButton(actionCell, '停用', () => disableCode(code.id), true)
      row.appendChild(actionCell)
      rows.appendChild(row)
    })
  }

  async function disableCode(id) {
    if (!window.confirm('确定停用这一个尚未兑换的码？已发放权益不会被撤销。')) return
    try {
      await api(`/codes/${encodeURIComponent(id)}/disable`, { method: 'POST', body: {} })
      notify('兑换码已停用', false)
      await Promise.all([loadCodes(), loadBatches()])
    } catch (error) { notify(error.message) }
  }

  async function disableBatch(id) {
    if (!window.confirm('确定停用该批次所有未兑换码？已兑换权益不会被撤销。')) return
    try {
      const result = await api(`/batches/${encodeURIComponent(id)}/disable`, { method: 'POST', body: {} })
      notify(`已停用 ${result.disabledCount} 个未兑换码`, false)
      await Promise.all([loadCodes(), loadBatches()])
    } catch (error) { notify(error.message) }
  }

  async function loadUsers(query = '') {
    const data = await api(`/users${query ? `?q=${encodeURIComponent(query)}` : ''}`)
    const rows = $('#usersRows')
    rows.replaceChildren()
    data.users.forEach((user) => {
      const row = document.createElement('tr')
      appendCell(row, user.id)
      appendCell(row, user.openidSuffix)
      appendCell(row, user.creditsRemaining)
      appendCell(row, user.creditsReserved)
      appendCell(row, user.permanentEntitlement ? '已开通' : '否')
      appendCell(row, escapeDate(user.createdAt))
      const actionCell = document.createElement('td')
      appendButton(actionCell, '详情', () => loadUserDetail(user.id))
      row.appendChild(actionCell)
      rows.appendChild(row)
    })
  }

  async function loadUserDetail(id) {
    try {
      const [data, access] = await Promise.all([
        api(`/users/${encodeURIComponent(id)}`),
        api(`/users/${encodeURIComponent(id)}/custom-access`)
      ])
      const panel = $('#userDetail')
      const pre = document.createElement('pre')
      pre.textContent = JSON.stringify(data, null, 2)
      panel.replaceChildren()
      const title = document.createElement('strong')
      title.textContent = '用户权益与流水详情'
      panel.append(title, pre)
      const roleTitle = document.createElement('h3')
      roleTitle.textContent = '人工服务权限（服务端校验）'
      panel.append(roleTitle)
      appendButton(panel, `商家权限：${access.merchant ? '已授权 · 点击撤销' : '未授权 · 点击授予'}`, async () => {
        if (!window.confirm(`确定${access.merchant ? '撤销' : '授予'}此用户商家权限？`)) return
        try {
          await api(`/users/${encodeURIComponent(id)}/custom-access`, {
            method: 'POST', body: { merchant: !access.merchant, tester: access.tester }
          })
          notify('商家权限已更新并记入审计', false)
          await loadUserDetail(id)
        } catch (error) { notify(error.message) }
      }, access.merchant)
      appendButton(panel, `测试账号：${access.tester ? '已授权 · 点击撤销' : '未授权 · 点击授予'}`, async () => {
        if (!window.confirm(`确定${access.tester ? '撤销' : '授予'}此用户人工服务测试资格？`)) return
        try {
          await api(`/users/${encodeURIComponent(id)}/custom-access`, {
            method: 'POST', body: { merchant: access.merchant, tester: !access.tester }
          })
          notify('测试账号权限已更新并记入审计', false)
          await loadUserDetail(id)
        } catch (error) { notify(error.message) }
      }, access.tester)
      panel.hidden = false
    } catch (error) { notify(error.message) }
  }

  function renderRecordRows(target, records, primary, secondary) {
    const root = $(target)
    root.replaceChildren()
    records.forEach((record) => {
      const row = document.createElement('div')
      row.className = 'record-row'
      const main = document.createElement('div')
      main.className = 'record-main'
      const headline = document.createElement('strong')
      headline.textContent = primary(record)
      const detail = document.createElement('span')
      detail.textContent = secondary(record)
      main.append(headline, detail)
      const time = document.createElement('span')
      time.className = 'record-time'
      time.textContent = escapeDate(record.created_at)
      row.append(main, time)
      root.appendChild(row)
    })
    if (!records.length) root.textContent = '暂无记录'
  }

  async function loadLogs() {
    const [transactions, audit] = await Promise.all([api('/transactions'), api('/audit')])
    renderRecordRows('#transactionsList', transactions.transactions || [], (item) => `${item.event_type || item.eventType || '记录'} · ${item.title || item.out_trade_no || item.target_id || ''}`, (item) => item.detail || item.message || item.status || item.username || '')
    renderRecordRows('#auditList', audit.audit || [], (item) => `${item.event_type} · ${item.target_id || ''}`, (item) => `${item.username || '系统'} · ${JSON.stringify(item.detail_json || {})}`)
  }

  async function refreshDashboard() {
    await Promise.all([loadProducts(), loadBatches(), loadCodes(), loadUsers(), loadLogs()])
  }

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.message || '登录失败')
      csrfToken = result.csrfToken
      $('#adminName').textContent = result.username
      toggleLoggedIn(true)
      await refreshDashboard()
    } catch (error) { notify(error.message) }
  })

  $('#logoutButton').addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST', body: {} }) } catch {}
    csrfToken = ''
    latestBatch = null
    $('#plainCodes').value = ''
    $('#newBatchResult').hidden = true
    toggleLoggedIn(false)
  })

  $('#batchForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const expiration = form.get('expiresAt')
    try {
      const result = await api('/batches', { method: 'POST', body: {
        productId: form.get('productId'), count: Number(form.get('count')), note: form.get('note'),
        expiresAt: expiration ? new Date(expiration).toISOString() : ''
      } })
      latestBatch = result
      $('#newBatchTitle').textContent = `${result.planName} · ${result.count} 个兑换码`
      $('#plainCodes').value = result.codes.join('\n')
      $('#newBatchResult').hidden = false
      notify('兑换码已生成；请立即导出并安全保存。明文不会在数据库保存。', false)
      await loadBatches()
      $('#batchFilter').value = result.batchId
      await loadCodes()
    } catch (error) { notify(error.message) }
  })

  $('#exportCodes').addEventListener('click', async () => {
    if (!latestBatch || !Array.isArray(latestBatch.codes)) return
    try {
      await api(`/batches/${encodeURIComponent(latestBatch.batchId)}/exported`, { method: 'POST', body: { count: latestBatch.codes.length } })
      const csv = ['兑换码', ...latestBatch.codes].map((value) => `"${String(value).replaceAll('"', '""')}"`).join('\r\n')
      const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `pinbead-codes-${latestBatch.batchId}.csv`
      link.click()
      URL.revokeObjectURL(url)
      notify('兑换码已导出，导出操作已审计。', false)
    } catch (error) { notify(error.message) }
  })

  $('#refreshBatches').addEventListener('click', () => loadBatches().catch((error) => notify(error.message)))
  $('#refreshCodes').addEventListener('click', () => loadCodes().catch((error) => notify(error.message)))
  $('#batchFilter').addEventListener('change', () => loadCodes().catch((error) => notify(error.message)))
  $('#statusFilter').addEventListener('change', () => loadCodes().catch((error) => notify(error.message)))
  $('#userSearchForm').addEventListener('submit', (event) => {
    event.preventDefault()
    loadUsers($('#userQuery').value.trim()).catch((error) => notify(error.message))
  })
  $('#customRefundForm').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const orderId = String(form.get('orderId') || '').trim()
    const reason = String(form.get('reason') || '').trim()
    if (!window.confirm(`确认对工单 ${orderId} 特殊退次？该操作会记入审计。`)) return
    try {
      const result = await api(`/custom-orders/${encodeURIComponent(orderId)}/refund`, {
        method: 'POST', body: { reason }
      })
      notify(`已退回 ${result.refundedCredits} 次`, false)
      event.currentTarget.reset()
      await loadLogs()
    } catch (error) { notify(error.message) }
  })
  $('#refreshLogs').addEventListener('click', () => loadLogs().catch((error) => notify(error.message)))
  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === button))
    document.querySelectorAll('.panel').forEach((panel) => { panel.hidden = panel.id !== button.dataset.panel })
  }))

  ;(async () => {
    try {
      const session = await api('/session')
      csrfToken = session.csrfToken
      $('#adminName').textContent = session.username
      toggleLoggedIn(true)
      await refreshDashboard()
    } catch {
      toggleLoggedIn(false)
    }
  })()
})()
