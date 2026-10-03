import assert from 'node:assert/strict'
import test from 'node:test'
import {createCanvas,loadImage} from '@napi-rs/canvas'
import {createRequire} from 'node:module'
import {generatePattern} from '../src/pattern-core.js'
const require=createRequire(import.meta.url)
const {generateLocalPattern}=require('../../pages/index/local-pattern-core.js')
function bounds(grid){
  const cells=grid.flatMap((row,y)=>row.flatMap((c,x)=>c?[[x,y]]:[]))
  const left=Math.min(...cells.map(c=>c[0])),right=Math.max(...cells.map(c=>c[0]))
  const top=Math.min(...cells.map(c=>c[1])),bottom=Math.max(...cells.map(c=>c[1]))
  return {left,right,top,bottom,width:right-left+1,height:bottom-top+1}
}
function portrait(){
  const c=createCanvas(600,600),ctx=c.getContext('2d')
  ctx.fillStyle='#222';ctx.fillRect(220,140,160,320)
  ctx.fillStyle='#fff';ctx.fillRect(240,170,120,240)
  return c.toBuffer('image/png')
}
test('all board sizes compact-fit the whole subject, centered, without stretching or enlarging the board',async()=>{
  for(const [w,h]of [[29,29],[38,38],[48,48],[52,52],[53,53],[64,64],[80,80],[128,128],[160,160],[38,52],[38,53],[53,38],[64,80],[80,64]]){
    const result=await generatePattern(portrait(),{sizeMode:'board',gridWidth:w,gridHeight:h,paletteSpec:'221',threshold:'none'})
    const b=bounds(result.gridCodes)
    assert.equal(result.columns,w);assert.equal(result.rows,h)
    assert.ok(Math.max(b.width/w,b.height/h)>=0.96,`${w}x${h}: fit at least one axis`)
    assert.ok(Math.abs(b.width/b.height-0.5)<=2/Math.min(w,h),`${w}x${h}: preserve original 1:2 shape`)
    assert.ok(Math.abs(b.left-(w-1-b.right))<=1)
    assert.ok(Math.abs(b.top-(h-1-b.bottom))<=1)
    assert.ok(result.gridCodes[Math.floor(h/2)][Math.floor(w/2)],'opaque white subject remains a bead')
    assert.equal(result.gridCodes[0][0],'','required aspect-ratio whitespace is not filled with invented pixels')
    assert.equal(result.totalBeads,result.gridCodes.flat().filter(Boolean).length)
  }
})
test('compact image-aspect mode and local/server grids agree at small and large sizes',async()=>{
  const input=portrait(),im=await loadImage(input),previous=globalThis.wx
  globalThis.wx={createOffscreenCanvas:({width,height})=>createCanvas(width,height)}
  try{
    for(const config of [
      {sizeMode:'board',gridWidth:52,gridHeight:52},
      {sizeMode:'board',gridWidth:38,gridHeight:53},
      {sizeMode:'board',gridWidth:80,gridHeight:64},
      {sizeMode:'image',gridWidth:64,gridHeight:64}
    ]){
      const settings={...config,paletteSpec:'221',threshold:'none'}
      const remote=await generatePattern(input,settings)
      assert.deepEqual(generateLocalPattern(im,settings,createCanvas(1200,1200)),remote)
      if(config.sizeMode==='image'){
        const b=bounds(remote.gridCodes)
        assert.ok(Math.abs(remote.columns/remote.rows-0.5)<0.02)
        assert.ok(Math.min(b.width/remote.columns,b.height/remote.rows)>0.94)
      }
    }
  }finally{globalThis.wx=previous}
})
