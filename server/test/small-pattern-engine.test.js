import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {createCanvas,loadImage} from '@napi-rs/canvas'
import {generatePattern} from '../src/pattern-core.js'
import {transparentCartoon,opaqueWhite,checkerboard} from './fixtures/small-inputs.mjs'
const require=createRequire(import.meta.url)
const engine=require('../../shared/small-pattern-engine.js')
const {generateLocalPattern}=require('../../pages/index/local-pattern-core.js')
const palette=require('../../pages/index/palette.js')
const source=()=>readFile(new URL('./fixtures/pink-character.jpg',import.meta.url))
const settings=(w,h=w)=>({sizeMode:'board',gridWidth:w,gridHeight:h,paletteSpec:'221',threshold:'none'})
const histogram=r=>r.gridCodes.flat().reduce((a,c)=>{if(c)a[c]=(a[c]||0)+1;return a},{})
test('fine brown facial strokes survive different sub-cell phases without replacing skin with dark beads',async()=>{
  for(const phase of [0,3,7,11]){
    const c=createCanvas(1040,1040),ctx=c.getContext('2d')
    ctx.fillStyle='#ffdccb';ctx.fillRect(0,0,1040,1040)
    ctx.fillStyle='#272727'
    for(const x of [410,630]){ctx.beginPath();ctx.ellipse(x,380,28,42,0,0,Math.PI*2);ctx.fill()}
    ctx.fillStyle='#ffffff';ctx.fillRect(406,352,14,14);ctx.fillRect(626,352,14,14)
    ctx.strokeStyle='#704434';ctx.lineWidth=4
    ctx.beginPath();ctx.moveTo(450,530+phase);ctx.quadraticCurveTo(520,565+phase,590,530+phase);ctx.stroke()
    const input=c.toBuffer('image/png'),im=await loadImage(input)
    assert.equal(engine.analyze(im,o=>createCanvas(o.width,o.height)).kind,'cartoon')
    const result=await generatePattern(input,settings(52))
    const colors=new Map(palette.map(p=>[p.code,engine.rgbToLab(p.rgb)]))
    const mouth=result.gridCodes.slice(26,29).flatMap(row=>row.slice(22,30))
    assert.ok(mouth.filter(code=>colors.get(code)?.[0]<55).length>=3,`thin smile phase ${phase}`)
    const counts=histogram(result)
    assert.ok(result.gridCodes.flat().filter(code=>colors.get(code)?.[0]>70).length>2500,'no global outline dilation')
    assert.equal(result.totalBeads,Object.values(counts).reduce((a,b)=>a+b,0))
  }
})
test('scaled JPEG pixel lattice is recovered; white face, two pink regions and red bow survive at 29,38,48,52',async()=>{
  const input=await source(),im=await loadImage(input)
  const analysis=engine.analyze(im,o=>createCanvas(o.width,o.height))
  assert.equal(analysis.kind,'pixel')
  assert.ok(Math.abs(analysis.lattice.x.period-9.45)<0.1)
  for(const size of [29,38,48,52]){
    const r=await generatePattern(input,settings(size)),counts=histogram(r)
    assert.equal(r.columns,size);assert.equal(r.rows,size)
    assert.ok(counts.H2>60,'white face cannot be mapped to skin or pink')
    assert.ok(counts.E17>40,'main pink must survive')
    assert.ok(counts.F24>15,'dark pink must remain distinct')
    assert.ok(counts.F8>0,'small red bow must survive')
    assert.ok(counts.H7<r.totalBeads*0.4,'no forced dilation of the black contour')
    assert.equal(r.gridCodes[0][0],'')
    assert.equal(r.totalBeads,Object.values(counts).reduce((a,b)=>a+b,0))
  }
})
test('legacy framing still matches original large baselines; compact default intentionally enlarges the subject',async()=>{
  const golden=JSON.parse(await readFile(new URL('./fixtures/large-pattern-baseline.json',import.meta.url),'utf8'))
  const inputs={pink:await source(),cat:await readFile(new URL('../../assets/pinbead-cat/cat-closeup.jpg',import.meta.url)),photo:await readFile(new URL('./fixtures/photo-astronaut.png',import.meta.url)),transparent:transparentCartoon()}
  for(const {sample,settings:config,hash} of golden.entries){
    const r=await generatePattern(inputs[sample],{...config,layoutMode:'legacy'})
    assert.ok(Math.max(r.columns,r.rows)>52)
    assert.equal(createHash('sha256').update(JSON.stringify(r)).digest('hex'),hash,`${sample} ${JSON.stringify(config)}`)
  }
})
test('new preprocessing is never entered above 52; both axes determine the route',async()=>{
  const input=await source(),original=engine.generate
  const calls=[]
  engine.generate=(runtime,image,size,...rest)=>{calls.push([size.columns,size.rows]);return original(runtime,image,size,...rest)}
  try{
    for(const [w,h]of [[38,52],[52,38],[52,52],[38,53],[53,38],[53,53],[64,64],[80,80]])await generatePattern(input,settings(w,h))
    assert.deepEqual(calls,[[38,52],[52,38],[52,52]])
  }finally{engine.generate=original}
})
test('transparent holes, opaque white, and an actual opaque checkerboard are distinct',async()=>{
  const white=await generatePattern(opaqueWhite(),settings(38,52))
  assert.ok(histogram(white).H2>1200)
  const transparent=await generatePattern(transparentCartoon(),settings(38,52))
  assert.equal(transparent.gridCodes[0][0],'')
  assert.ok(histogram(transparent).H2>150)
  assert.equal(transparent.gridCodes[46][8],'','the original transparent interior hole is kept at its scaled coordinate')
  const check=await generatePattern(checkerboard(),settings(48))
  assert.equal(check.gridCodes[24][24].length>0,true)
  assert.ok(check.totalBeads>1600,'opaque checkerboard pixels are not assumed to be alpha')
})
test('small local/server results, per-color quantities and dimensions agree for all image types',async()=>{
  const previous=globalThis.wx
  globalThis.wx={createOffscreenCanvas:({width,height})=>createCanvas(width,height)}
  try{
    const samples=[await source(),await readFile(new URL('../../assets/pinbead-cat/cat-closeup.jpg',import.meta.url)),transparentCartoon(),await readFile(new URL('./fixtures/photo-astronaut.png',import.meta.url))]
    for(const input of samples){
      const im=await loadImage(input)
      for(const [w,h]of [[29,29],[38,38],[48,48],[52,52],[38,52]]){
        const config=settings(w,h),remote=await generatePattern(input,config),local=generateLocalPattern(im,config,createCanvas(1200,1200))
        assert.deepEqual(local,remote)
        assert.equal(local.totalBeads,Object.values(histogram(local)).reduce((a,b)=>a+b,0))
        assert.ok(local.gridCodes.flat().filter(Boolean).every(c=>palette.some(p=>p.code===c)))
      }
    }
  }finally{globalThis.wx=previous}
})
