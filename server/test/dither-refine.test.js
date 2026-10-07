import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url),palette=require('../../pages/index/palette.js')
const source=fs.readFileSync(new URL('../src/pattern-core.js',import.meta.url),'utf8')
const methods=vm.runInNewContext(`${source.slice(source.indexOf('const CANVAS_SIZE ='),source.indexOf('\nexport async function generatePattern('))};coreMethods`,{PALETTE:palette})
const runtime=()=>Object.assign(Object.create(methods),{data:{layoutMode:'compact'}})
const color=code=>({...palette.find(c=>c.code===code),empty:false})
const setup=()=>({grid:Array.from({length:3},()=>Array.from({length:3},()=>color('H1'))),info:Array.from({length:3},()=>Array.from({length:3},()=>({average:[250,250,250],skinLike:false,detailRgb:null,backgroundCandidate:false})))})
test('isolated F8 in 3x3 H1 becomes H1 without mutating input or source RGB',()=>{
 const r=runtime(),{grid,info}=setup();grid[1][1]=color('F8');grid[1][1].sourceRgb=[192,12,30]
 assert.ok(r.mardColorDistance(grid[1][1].rgb,grid[0][0].rgb)>=48)
 const out=r.removeIsolatedColors(grid,info);assert.equal(out[1][1].code,'H1');assert.equal(grid[1][1].code,'F8');assert.deepEqual(Array.from(out[1][1].sourceRgb),[192,12,30])
})
test('single-cell pupil detail, skin and background are exempt from isolated correction',()=>{
 for(const flag of ['detailRgb','skinLike','backgroundCandidate']){const {grid,info}=setup();grid[1][1]=color('F8');info[1][1][flag]=flag==='detailRgb'?[12,12,12]:true;assert.equal(runtime().removeIsolatedColors(grid,info)[1][1].code,'F8')}
 const {grid,info}=setup();grid[1][1]={empty:true,code:'',rgb:[255,255,255]};assert.equal(runtime().removeIsolatedColors(grid,info)[1][1].empty,true)
})
test('diagonal neighbor counts and near-color threshold excludes exactly 48',()=>{
 const r=runtime(),{grid,info}=setup();grid[1][1]=color('F8');grid[0][0]=color('F8');assert.equal(r.removeIsolatedColors(grid,info)[1][1].code,'F8')
 for(const distance of [47.999,48]){const s=setup();s.grid[1][1]=color('F8');r.mardColorDistance=(a,b)=>a===b?0:distance;assert.equal(r.removeIsolatedColors(s.grid,s.info)[1][1].code,distance<48?'F8':'H1')}
})
test('nearest foreground replacement is deterministic; singleton with no neighbor stays',()=>{
 const r=runtime(),{grid,info}=setup();grid[1][1]=color('F8');grid[0][0]=color('H7');info[0][0].detailRgb=[0,0,0]
 const initial=grid[1][1].rgb,candidates=[color('H1'),color('H7')].sort((a,b)=>r.mardColorDistance(initial,a.rgb)-r.mardColorDistance(initial,b.rgb));assert.equal(r.removeIsolatedColors(grid,info)[1][1].code,candidates[0].code)
 assert.equal(r.removeIsolatedColors([[color('F8')]],[[{average:[192,12,30]}]])[0][0].code,'F8')
})
test('live correction establishes support for adjacent opposite colors',()=>{
 const r=runtime(),out=r.removeIsolatedColors([[color('H1'),color('H7')]],[[{average:[255,255,255]},{average:[0,0,0]}]]);assert.equal(out[0][0].code,out[0][1].code)
})
test('flat dither halves only below both edge/chroma thresholds',()=>{
 const r=runtime(),scale=(edge,rgb)=>r.getLocalDitherScale({edgeStrength:edge,average:rgb},false,.42,10816)
 assert.equal(scale(24.99,[130,130,130]),.21);assert.equal(scale(25,[130,130,130]),.42);assert.equal(scale(10,[130,150,130]),.42)
})
test('texture cap respects strict 90 boundary and existing small-board attenuation',()=>{
 const r=runtime(),info={edgeStrength:91,average:[100,140,90]};assert.equal(r.getLocalDitherScale(info,false,.8,10816),.6);assert.equal(r.getLocalDitherScale(info,false,.24,10816),.24)
 assert.equal(r.getLocalDitherScale({...info,edgeStrength:90},false,.8,10816),.8);assert.equal(r.getLocalDitherScale({...info,edgeStrength:111},false,.42,4096),.42*.68)
})
test('skin and detail dither protection override flat and texture rules',()=>{
 const r=runtime();for(const edge of [0,120]){const info={average:[120,120,120],edgeStrength:edge,detailRgb:[10,10,10]};assert.equal(r.getLocalDitherScale(info,true,.42,10816),.08);assert.equal(r.getLocalDitherScale(info,false,.42,10816),.42*.42)}
})
test('explicit legacy rollback retains old dither scale',()=>{
 const r=runtime();r.data.layoutMode='legacy';assert.equal(r.getLocalDitherScale({average:[120,120,120],edgeStrength:0},false,.42,10816),.42)
})

test('refined photo generation keeps local/server matrices, dimensions, counts and palette identical',async()=>{
 const {generatePattern}=await import('../src/pattern-core.js')
 const {createCanvas,loadImage}=require('@napi-rs/canvas')
 const {generateLocalPattern}=require('../../pages/index/local-pattern-core.js')
 const buffer=fs.readFileSync(new URL('./fixtures/photo-astronaut.png',import.meta.url)),image=await loadImage(buffer)
 const saved=globalThis.wx
 try{globalThis.wx={createOffscreenCanvas:({width,height})=>createCanvas(width,height)}
 for(const [w,h]of [[53,53],[64,104],[104,104]]){
  const settings={sizeMode:'board',layoutMode:'compact',gridWidth:w,gridHeight:h,paletteSpec:'221',threshold:'none'}
  const server=await generatePattern(buffer,settings),local=generateLocalPattern(image,settings,createCanvas(1200,1200))
  assert.deepEqual(local,server);assert.equal(server.columns,w);assert.equal(server.rows,h)
  assert.equal(server.totalBeads,server.gridCodes.flat().filter(Boolean).length)
  assert.ok(server.gridCodes.flat().every(c=>!c||palette.some(p=>p.code===c)))
 }
 }finally{globalThis.wx=saved}
})
