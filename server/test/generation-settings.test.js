import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import settingsModule from '../../shared/generation-settings.js'
const { normalizeGenerationSettings: normalize, TARGET_VERSION } = settingsModule
const require = createRequire(import.meta.url)
test('legacy serialization is unchanged and target identity cannot be spoofed', () => {
  const legacy = { sizeMode: 'board', gridWidth: 64, gridHeight: 64, paletteSpec: '221', threshold: 'none' }
  assert.equal(JSON.stringify(normalize({})), JSON.stringify(legacy))
  assert.deepEqual(normalize({ generationMode: 'unknown', algorithm: 'reconstruction', debug: true }), legacy)
  const target = normalize({ ...legacy, generationMode: 'target', targetVersion: 'spoof', sampling: 'nearest' })
  assert.equal(target.targetVersion, TARGET_VERSION)
  assert.equal(target.sampling, undefined)
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.notEqual(hash(target), hash(legacy))
})
test('mode selection freezes during pending tasks, avoids regeneration and rejects legacy replies to target requests', () => {
  const previousPage=globalThis.Page,previousWx=globalThis.wx
  let definition,toast='',uploads=0
  try {
    globalThis.Page=value=>{definition=value}
    globalThis.wx={showToast:({title})=>{toast=title},uploadFile:()=>uploads++}
    require('../../pages/index/index.js')
    const page=Object.assign({},definition,{
      data:{...definition.data,imagePath:'/tmp/source.jpg',patternReady:true},
      setData(change,callback){Object.assign(this.data,change);if(callback)callback()},
      generatePattern(){throw new Error('mode selection must not automatically create or bill a task')}
    })
    page.onGenerationModeChange({detail:{value:'1'}})
    assert.equal(page.getGenerationSnapshot().settings.generationMode,'target')
    assert.equal(page.data.patternReady,false)
    page.activeGenerationKey='pending'
    page.onGenerationModeChange({detail:{value:'0'}})
    assert.equal(page.data.generationMode,'target')
    assert.match(toast,/当前生成任务/)
    page.activeGenerationSnapshot=page.getGenerationSnapshot()
    page.acceptServerPattern({gridCodes:[['H2']]})
    assert.match(toast,/版本不匹配/)
    assert.equal(page.patternGrid,undefined)
    assert.equal(uploads,0)
  } finally {globalThis.Page=previousPage;globalThis.wx=previousWx}
})
test('target mode retains rectangular dimensions and selected palette and ratio rule', () => {
  for (const [w,h] of [[29,29],[52,52],[80,80],[100,100],[104,104],[38,53],[53,38]]) {
    const s = normalize({ generationMode: 'target', gridWidth: w, gridHeight: h, sizeMode: 'image', paletteSpec: '72' })
    assert.equal(s.gridWidth,w); assert.equal(s.gridHeight,h)
    assert.equal(s.sizeMode,'image'); assert.equal(s.paletteSpec,'72')
  }
})
