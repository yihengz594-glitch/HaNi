import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { generatePattern } from '../src/pattern-core.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { canUseLocalGeneration } = require('../../pages/index/local-generation-policy.js')
const { generateLocalPattern } = require('../../pages/index/local-pattern-core.js')

test('local fallback only runs in the development build with no backend URL', () => {
  const version = (envVersion) => ({ getAccountInfoSync: () => ({ miniProgram: { envVersion } }) })
  assert.equal(canUseLocalGeneration(version('develop'), ''), true)
  for (const envVersion of ['trial', 'release', '', undefined]) {
    assert.equal(canUseLocalGeneration(version(envVersion), ''), false)
  }
  assert.equal(canUseLocalGeneration(version('develop'), 'https://example.test'), false)
  assert.equal(canUseLocalGeneration({ getAccountInfoSync: () => { throw new Error('unavailable') } }, ''), false)
  assert.equal(canUseLocalGeneration({}, ''), false)
})

test('mini-program development generator retains the exact server pixel algorithm', async () => {
  const serverSource = await readFile(path.join(projectRoot, 'server/src/pattern-core.js'), 'utf8')
  const localSource = await readFile(path.join(projectRoot, 'pages/index/local-pattern-core.js'), 'utf8')
  const sharedStart = serverSource.indexOf('const CANVAS_SIZE =')
  const sharedEnd = serverSource.indexOf('\nexport async function generatePattern(')
  assert.ok(sharedStart >= 0 && sharedEnd > sharedStart)
  assert.ok(localSource.includes(serverSource.slice(sharedStart, sharedEnd).trimEnd()))

  const imageBuffer = await readFile(path.join(projectRoot, 'assets/pinbead-cat/cat-closeup.jpg'))
  const settings = { sizeMode: 'board', gridWidth: 26, gridHeight: 26, paletteSpec: '221', threshold: 'none' }
  const serverResult = await generatePattern(imageBuffer, settings)
  const image = await loadImage(imageBuffer)
  const previousWx = globalThis.wx
  try {
    globalThis.wx = { createOffscreenCanvas: ({ width, height }) => createCanvas(width, height) }
    const localResult = generateLocalPattern(image, settings, createCanvas(1200, 1200))
    assert.deepEqual(localResult, serverResult)
  } finally {
    globalThis.wx = previousWx
  }
})

test('home page routes only development/no-backend attempts to local generation', () => {
  const previousPage = globalThis.Page
  const previousWx = globalThis.wx
  let definition
  try {
    globalThis.Page = (page) => { definition = page }
    globalThis.wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
      showModal: ({ success }) => { if (success) success({ confirm: true }) }
    }
    require('../../pages/index/index.js')
    const page = Object.assign({}, definition, {
      data: { ...definition.data, imagePath: '/tmp/test-image.jpg', generating: false }
    })
    let localCalls = 0
    page.generateLocalTestPattern = () => { localCalls += 1 }
    page.ensureSession = () => { throw new Error('development path must not call backend') }
    page.generatePattern()
    assert.equal(localCalls, 1)

    globalThis.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'release' } })
    page.localGenerationNoticeShown = false
    page.generatePattern()
    assert.equal(localCalls, 1)
  } finally {
    globalThis.Page = previousPage
    globalThis.wx = previousWx
  }
})
