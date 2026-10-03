import test from 'node:test'
import assert from 'node:assert/strict'
import {createCanvas,loadImage} from '@napi-rs/canvas'
import {createRequire} from 'node:module'
import {generatePattern} from '../src/pattern-core.js'
import {readFile} from 'node:fs/promises'
const require=createRequire(import.meta.url)
const pipeline=require('../../shared/bead-reconstruction.js')
const palette=require('../../pages/index/palette.js')
const {generateLocalPattern}=require('../../pages/index/local-pattern-core.js')
const settings=(w,h=w)=>({gridWidth:w,gridHeight:h,sizeMode:'board',paletteSpec:'221',threshold:'none',algorithm:'reconstruction'})
test('formal target selector reaches the shared engine at every size', async()=>{
  for(const size of [29,32,40,48,52,64,80,100,104,128]){
    const s=settings(size),target={...s,generationMode:'target'};delete target.algorithm
    const result=await generatePattern(fixture(),target)
    assert.equal(result.generationMode,'target');assert.equal(result.targetVersion,'target-v1')
    const {generationMode,targetVersion,...gridResult}=result
    assert.deepEqual(gridResult,await generatePattern(fixture(),s))
  }
})
function fixture(){
  const c=createCanvas(240,280),g=c.getContext('2d')
  g.fillStyle='#282828';g.fillRect(24,20,190,235)
  g.fillStyle='#ffffff';g.fillRect(38,48,160,140)
  g.fillStyle='#111111';g.fillRect(75,87,8,15);g.fillRect(155,87,8,15);g.fillRect(100,140,35,3)
  return c.toBuffer('image/png')
}
test('experimental pipeline preserves requested sizes and exact bead/code invariants',async()=>{
  const input=fixture(),codes=new Set(palette.map(v=>v.code))
  for(const [w,h] of [[29,29],[32,32],[40,40],[48,48],[52,52],[64,64],[80,80],[100,100],[104,104],[128,128],[160,160],[38,52],[38,53],[53,38]]){
    const r=await generatePattern(input,settings(w,h))
    assert.equal(r.columns,w);assert.equal(r.rows,h)
    assert.equal(r.gridCodes.flat().filter(Boolean).length,r.totalBeads)
    assert.ok(r.gridCodes.flat().every(v=>v===''||codes.has(v)))
  }
})
test('black and white input never acquires saturated palette pollution',async()=>{
  const result=await generatePattern(fixture(),settings(80)),byCode=new Map(palette.map(v=>[v.code,v]))
  for(const code of result.gridCodes.flat().filter(Boolean)){
    const rgb=byCode.get(code).rgb
    assert.ok(Math.max(...rgb)-Math.min(...rgb)<=18,code)
  }
})
test('connected cleanup merges close isolated colors but protects real small features',()=>{
  const gray={code:'gray',rgb:[150,150,150]},near={code:'near',rgb:[154,154,154]},black={code:'black',rgb:[0,0,0]}
  const cells=Array.from({length:25},()=>({protected:false})),params={smallRegionLimit:3,mergeDistance:8}
  const grid=Array(25).fill(gray);grid[12]=near
  assert.equal(pipeline.mergeSmallRegions(grid,cells,5,5,params)[12].code,'gray')
  cells[12].protected=true
  assert.equal(pipeline.mergeSmallRegions(grid,cells,5,5,params)[12].code,'near')
  cells[12].protected=false;grid[12]=black
  assert.equal(pipeline.mergeSmallRegions(grid,cells,5,5,params)[12].code,'black')
})
test('experimental local and server grids are identical, without changing default legacy path',async()=>{
  const input=fixture(),image=await loadImage(input),previous=globalThis.wx
  try{
    globalThis.wx={createOffscreenCanvas:({width,height})=>createCanvas(width,height)}
    const s=settings(53,38)
    assert.deepEqual(generateLocalPattern(image,s,createCanvas(1200,1200)),await generatePattern(input,s))
    const legacy={...s,algorithm:'legacy'},implicit={...legacy};delete implicit.algorithm
    assert.deepEqual(await generatePattern(input,legacy),await generatePattern(input,implicit))
  }finally{globalThis.wx=previous}
})
test('formal target mode is identical in the development local generator and server core',async()=>{
  const input=fixture(),image=await loadImage(input),previous=globalThis.wx
  try{
    globalThis.wx={createOffscreenCanvas:({width,height})=>createCanvas(width,height)}
    for(const [w,h] of [[52,52],[80,52],[53,38]]){
      const s={gridWidth:w,gridHeight:h,sizeMode:'board',paletteSpec:'221',threshold:'none',generationMode:'target'}
      const local=generateLocalPattern(image,s,createCanvas(1200,1200))
      const server=await generatePattern(input,s)
      assert.deepEqual(local,server,`${w}x${h} local/server target mismatch`)
    }
  }finally{globalThis.wx=previous}
})
test('transparent and white foreground remain distinct and deterministic',async()=>{
  const c=createCanvas(60,60),g=c.getContext('2d');g.fillStyle='#ffffff';g.fillRect(10,10,40,40);g.fillStyle='#000000';g.fillRect(25,25,5,5)
  const buffer=c.toBuffer('image/png'),s=settings(52,38),a=await generatePattern(buffer,s),b=await generatePattern(buffer,s)
  assert.deepEqual(a,b);assert.ok(a.gridCodes.flat().includes(''));assert.ok(a.gridCodes.flat().includes('H2'))
})
test('three real regression inputs reduce fragmentation at 104 without invalid color codes',async()=>{
  for(const name of ['gray-cat','silver-cat','ornate-girl']){
    const input=await readFile(new URL(`./fixtures/reconstruction-regression/${name}.jpg`,import.meta.url))
    const s=settings(104),legacy=await generatePattern(input,{...s,algorithm:'legacy'}),fresh=await generatePattern(input,{...s,debug:true})
    const measure=result=>{
      const map=new Map(palette.map(c=>[c.code,c])),grid=result.gridCodes.flat().map(code=>map.get(code)||null)
      const cells=grid.map(v=>v?{lab:pipeline.oklab(v.rgb),protected:false}:null)
      return pipeline.qualityMetrics(grid,cells,104,104)
    }
    const a=measure(legacy),b=measure(fresh)
    assert.ok(b.fragmentationScore<a.fragmentationScore*.75,name)
    assert.ok(b.isolatedPixelCount<a.isolatedPixelCount*.75,name)
    assert.equal(fresh.diagnostics.parameters.dithering,false)
    assert.ok(fresh.gridCodes.flat().every(code=>code===''||palette.some(c=>c.code===code)))
  }
})
test('all tested resampling kernels preserve dimensions, codes and finite diagnostics',async()=>{
  for(const sampling of ['area','box','lanczos','bicubic','median','dominant','nearest']){
    const r=await generatePattern(fixture(),{...settings(40),sampling,debug:true})
    assert.equal(r.columns,40);assert.equal(r.totalBeads,r.gridCodes.flat().filter(Boolean).length)
    assert.ok(Number.isFinite(r.diagnostics.after.edgePreservation))
  }
})
test('selected 72-color specification is not replaced by the full 221-color palette',async()=>{
  const r=await generatePattern(fixture(),{...settings(64),paletteSpec:'72'})
  assert.ok(new Set(r.gridCodes.flat().filter(Boolean)).size<=72)
})
