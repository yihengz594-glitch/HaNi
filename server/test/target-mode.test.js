import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {generatePattern} from '../src/pattern-core.js'
import {runPatternJob} from '../src/pattern-runner.js'
const require=createRequire(import.meta.url),palette=require('../../pages/index/palette.js')
const settings=size=>({generationMode:'target',gridWidth:size,gridHeight:size,sizeMode:'board',paletteSpec:'221',threshold:'none'})
const input=name=>readFile(new URL(`./fixtures/reconstruction-regression/${name}.jpg`,import.meta.url))
const engine=require('../../shared/bead-reconstruction.js')

test('dark neutral clothing does not borrow a brown regional center',()=>{
  const rgbs=[[77,70,70],[86,72,72]]
  const cells=Array.from({length:200},()=>({role:1,importance:1}))
  const clusters=rgbs.map((rgb,i)=>({rgb,lab:engine.oklab(rgb),members:Array.from({length:100},(_,j)=>i*100+j),protected:false}))
  const result=engine.simplifyRegionalColors(clusters,cells,{colorBudget:2,resolutionFactor:52},{kind:'textured-image'})
  assert.ok(result[0].rgb[0]-result[0].rgb[1]<=8)
  assert.ok(result[1].rgb[0]-result[1].rgb[1]>=12)
})

test('low-saturation neutral fur avoids visibly green or purple neutral candidates',async()=>{
  const result=await generatePattern(await input('silver-cat'),settings(100))
  const codes=new Set(result.gridCodes.flat())
  assert.equal(codes.has('H14'),false)
  assert.equal(codes.has('H22'),false)
  assert.ok(codes.has('H11')||codes.has('H10')||codes.has('H17'))
})

test('face-local dark evidence survives when a person has no detectable colored iris pair',async()=>{
  const result=await generatePattern(await input('pillow-girl'),{...settings(52),debug:true})
  const regions=result.diagnostics.analysis.regions
  assert.ok(regions.faces.length>0)
  assert.ok(regions.faceFeatures.length>0)
  assert.ok(result.diagnostics.stages.structure.roles.some(role=>role===5))
})

test('cleanup removes palette-boundary specks only with flat source evidence',()=>{
  const base={code:'base',rgb:[120,120,120]},speck={code:'speck',rgb:[150,150,150]}
  const grid=Array(25).fill(base);grid[12]=speck
  const cells=Array.from({length:25},()=>({lab:engine.oklab([134,134,134]),edge:0,protected:false}))
  cells[12]={lab:engine.oklab([136,136,136]),edge:0,protected:false}
  const params={smallRegionLimit:3,mergeDistance:6,isolatedPixelPenalty:1.5}
  assert.equal(engine.mergeSmallRegions(grid,cells,5,5,params)[12].code,'base')
  cells[12].protected=true
  assert.equal(engine.mergeSmallRegions(grid,cells,5,5,params)[12].code,'speck')
  cells[12]={lab:engine.oklab([175,175,175]),edge:0,protected:false}
  assert.equal(engine.mergeSmallRegions(grid,cells,5,5,params)[12].code,'speck')
  cells[12]={lab:engine.oklab([136,136,136]),edge:.9,protected:false}
  assert.equal(engine.mergeSmallRegions(grid,cells,5,5,params)[12].code,'speck')
})

test('input type and region strategy do not change with the selected board size',async()=>{
  for(const name of ['pillow-girl','monochrome-comic','gray-cat','silver-cat','ornate-girl']){
    const buffer=await input(name)
    let expected
    for(const size of [32,52,80,100]){
      const result=await generatePattern(buffer,{...settings(size),debug:true})
      const {regions,...visual}=result.diagnostics.analysis
      const identity={visual,types:regions.types,primaryType:regions.primaryType,strategy:regions.strategy}
      if(expected)assert.deepEqual(identity,expected,`${name}: ${size} grid changes input classification`)
      else expected=identity
      for(const box of [...regions.faces,...regions.eyePairs.flatMap(pair=>pair.eyes)]){
        const source=result.diagnostics.stages.source
        assert.ok(box.left>=0&&box.top>=0&&box.right<source.width&&box.bottom<source.height)
      }
    }
    if(name==='ornate-girl')assert.equal(expected.strategy,'ornate-illustration')
  }
})

test('regional color reduction keeps evidenced pale skin separate from a dominant white pillow',()=>{
  const rgbs=[[255,230,218],[247,244,242],[112,85,84]]
  const cells=rgbs.map((rgb,i)=>({rgb,lab:engine.oklab(rgb),role:i===0?4:1,importance:i===0?5:1}))
  const clusters=rgbs.map((rgb,i)=>({rgb,lab:engine.oklab(rgb),members:Array(i===1?100:1).fill(i),protected:false}))
  const result=engine.simplifyRegionalColors(clusters,cells,{colorBudget:2,resolutionFactor:52},{kind:'textured-image'})
  assert.ok(result[0].rgb[0]-result[0].rgb[1]>15,'skin must retain its warm source hue')
  assert.notDeepEqual(result[0].rgb,result[1].rgb,'skin and white cannot share a source-color center')
})
test('a tight global budget cannot flatten a substantial coherent source tone',()=>{
  const rgbs=[[110,85,83],[58,52,55],[245,242,241]]
  const cells=Array.from({length:1000},()=>({role:1,importance:1}))
  const clusters=rgbs.map((rgb,i)=>({rgb,lab:engine.oklab(rgb),members:Array.from({length:100},(_,j)=>i*100+j),protected:false}))
  const result=engine.simplifyRegionalColors(clusters,cells,{colorBudget:2,resolutionFactor:52},{kind:'textured-image'})
  for(let i=0;i<result.length;i++)assert.ok(Math.hypot(...result[i].lab.map((v,c)=>v-clusters[i].lab[c]))<=4)
})

test('real cats obtain region budgets without treating gold jewelry as pet eyes',async()=>{
  for(const name of ['gray-cat','silver-cat','ornate-girl']){
    const result=await generatePattern(await input(name),{...settings(52),debug:true})
    const regions=result.diagnostics.analysis.regions
    assert.equal(regions.method,'traditional-region-hypotheses')
    assert.equal(result.diagnostics.parameters.dithering,false)
    if(name==='ornate-girl')assert.notEqual(regions.strategy,'pet')
    else {assert.equal(regions.strategy,'pet');assert.ok(regions.eyePairs.length)}
  }
})
test('actual monochrome comic uses only selected grayscale bead codes at 52,80,100',async()=>{
  const buffer=await input('monochrome-comic')
  const gray=new Set(['H2','H3','H4','H5','H6','H7','H9','H11','H22'])
  for(const size of [52,80,100]){
    const result=await generatePattern(buffer,settings(size))
    assert.ok(result.gridCodes.flat().every(code=>!code||gray.has(code)))
    assert.ok(result.gridCodes.flat().includes('H2'),'white foreground must survive')
  }
})
test('muted brown hair is not forced into gray in the real pillow-girl input',async()=>{
  const result=await generatePattern(await input('pillow-girl'),settings(52))
  const map=new Map(palette.map(p=>[p.code,p])),filled=result.gridCodes.flat().filter(Boolean)
  const brown=filled.filter(code=>{const [r,g,b]=map.get(code).rgb;return r>g+12&&r>b+12&&r<170}).length
  assert.ok(brown>filled.length*.25)
})
test('production worker preserves target mode identity and the exact final matrix',async()=>{
  const buffer=await input('gray-cat'),s={...settings(52),gridHeight:38}
  assert.deepEqual(await runPatternJob(buffer,s),await generatePattern(buffer,s))
})
