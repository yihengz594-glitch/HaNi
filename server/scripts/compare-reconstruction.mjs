import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {createCanvas,loadImage} from '@napi-rs/canvas'
import {createRequire} from 'node:module'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {generatePattern} from '../src/pattern-core.js'
const require=createRequire(import.meta.url),palette=require('../../pages/index/palette.js'),engine=require('../../shared/bead-reconstruction.js')
const [out,...inputs]=process.argv.slice(2)
if(!out||!inputs.length)throw new Error('Usage: compare-reconstruction.mjs OUTPUT_DIRECTORY INPUT...')
await mkdir(out,{recursive:true})
const colors=new Map(palette.map(p=>[p.code,p]))
const reviewSizes=process.env.TARGET_REVIEW_SIZES
  ? process.env.TARGET_REVIEW_SIZES.split(',').map(value=>{const size=Number(value);if(!Number.isInteger(size)||size<8||size>160)throw new Error('Invalid review size');return [size,size]})
  : [[29,29],[32,32],[40,40],[48,48],[52,52],[64,64],[80,80],[100,100],[104,104],[128,128],[160,160],[38,52],[38,53],[53,38]]
function render(result,file){
  const c=createCanvas(result.columns*8,result.rows*8),g=c.getContext('2d');g.fillStyle='#ededed';g.fillRect(0,0,c.width,c.height)
  result.gridCodes.forEach((row,y)=>row.forEach((code,x)=>{if(code){g.fillStyle=colors.get(code).hex;g.fillRect(x*8,y*8,8,8)}}))
  return writeFile(file,c.toBuffer('image/png'))
}
function metrics(result){
  const grid=result.gridCodes.flat().map(code=>colors.get(code)||null),cells=grid.map(v=>v?{lab:engine.oklab(v.rgb),protected:false}:null)
  const m=engine.qualityMetrics(grid,cells,result.columns,result.rows);delete m.edgePreservation;delete m.protectedDetailColorRetention;return m
}
const report=[],sections=[]
for(let id=0;id<inputs.length;id++){
  const buffer=await readFile(inputs[id]),image=await loadImage(buffer)
  const c=createCanvas(image.width,image.height);c.getContext('2d').drawImage(image,0,0);await writeFile(path.join(out,`${id}-original.png`),c.toBuffer('image/png'))
  const panels=[]
  for(const [w,h] of reviewSizes){
    const settings={gridWidth:w,gridHeight:h,sizeMode:'board',paletteSpec:'221',threshold:'none'}
    const t0=performance.now(),old=await generatePattern(buffer,settings),t1=performance.now()
    const fresh=await generatePattern(buffer,{...settings,generationMode:'target',debug:true}),t2=performance.now()
    const diagnostics=fresh.diagnostics;delete fresh.diagnostics
    const label=`${id}-${w}x${h}`
    let colorAudit=''
    if(w===100){
      const cells=diagnostics.stages.cells
      const regions=engine.regionalClusters(cells,diagnostics.parameters)
      const simplified=engine.simplifyRegionalColors(regions,cells,diagnostics.parameters,diagnostics.analysis)
      const canvas=createCanvas(w*8,h*8),ctx=canvas.getContext('2d')
      ctx.fillStyle='#ededed';ctx.fillRect(0,0,canvas.width,canvas.height)
      for(const region of simplified){
        ctx.fillStyle=`rgb(${region.rgb.map(Math.round).join(',')})`
        for(const i of region.members)ctx.fillRect(i%w*8,Math.floor(i/w)*8,8,8)
      }
      await writeFile(path.join(out,`${label}-before-mard.png`),canvas.toBuffer('image/png'))
      colorAudit=`<details><summary>查看豆色匹配前的区域颜色（诊断图，不可作为实际豆色图纸）</summary><img src="${label}-before-mard.png"><p>用于区分区域简化与真实色板匹配产生的色差，最终制作以右侧 Target 色号矩阵为准。</p></details>`
    }
    await render(old,path.join(out,`${label}-old.png`));await render(fresh,path.join(out,`${label}-new.png`))
    await writeFile(path.join(out,`${label}-grid.json`),JSON.stringify({old,new:fresh}))
    const row={input:inputs[id],size:[w,h],before:metrics(old),after:metrics(fresh),oldMs:Math.round(t1-t0),newMs:Math.round(t2-t1),analysis:diagnostics.analysis,parameters:diagnostics.parameters,sourceEdgeF1:diagnostics.after.edgePreservation,protectedDetailColorRetention:diagnostics.after.protectedDetailColorRetention}
    report.push(row);console.log(JSON.stringify(row))
    panels.push(`<section><h3>${w}×${h}</h3><div class="pair"><figure><figcaption>Legacy · ${row.before.colorCount}色 · 单格色块${row.before.isolatedPixelCount}</figcaption><img src="${label}-old.png" alt="旧版 ${w}格"></figure><figure><figcaption>Target · ${row.after.colorCount}色 · 单格色块${row.after.isolatedPixelCount}</figcaption><img src="${label}-new.png" alt="目标模式 ${w}格"></figure></div><p><a href="${label}-grid.json">下载两份最终色号矩阵</a></p>${colorAudit}</section>`)
    if(w===104){
      const comparison=createCanvas(864,470),ctx=comparison.getContext('2d')
      ctx.fillStyle='#faf8f5';ctx.fillRect(0,0,864,470);ctx.font='22px sans-serif';ctx.fillStyle='#222'
      ctx.fillText(`Before: ${row.before.colorCount} colors`,12,30);ctx.fillText(`Experimental: ${row.after.colorCount} colors`,444,30)
      for(const [k,result] of [old,fresh].entries()){
        ctx.fillStyle='#ededed';ctx.fillRect(12+k*432,45,416,416)
        result.gridCodes.forEach((rr,y)=>rr.forEach((code,x)=>{if(code){ctx.fillStyle=colors.get(code).hex;ctx.fillRect(12+k*432+x*4,45+y*4,4,4)}}))
      }
      await writeFile(path.join(out,`${id}-comparison-104.png`),comparison.toBuffer('image/png'))
      const stages=diagnostics.stages
      const saveSource=async(name,source)=>{const canvas=createCanvas(source.width,source.height),g=canvas.getContext('2d'),data=g.createImageData(source.width,source.height);data.data.set(source.pixels);g.putImageData(data,0,0);await writeFile(path.join(out,`${id}-${name}.png`),canvas.toBuffer('image/png'))}
      await saveSource('pre-smooth',stages.source);await saveSource('smooth',stages.smoothed)
      await render({...fresh,gridCodes:Array.from({length:h},(_,y)=>stages.mapped.slice(y*w,(y+1)*w).map(c=>c?c.code:''))},path.join(out,`${id}-mapped-before-cleanup.png`))
      for(const name of ['edge','importance','subject']){
        const src=stages.source,canvas=createCanvas(src.width,src.height),g=canvas.getContext('2d'),data=g.createImageData(src.width,src.height)
        for(let i=0;i<src.width*src.height;i++){const value=name==='subject'?stages.maps[name][i]:Math.min(255,stages.maps[name][i]*(name==='edge'?255:45));data.data.set([value,value,value,255],i*4)}
        g.putImageData(data,0,0);await writeFile(path.join(out,`${id}-${name}.png`),canvas.toBuffer('image/png'))
      }
    }
  }
  sections.push(`<h2>输入 ${id+1}：${path.basename(inputs[id])}</h2><img class="original" src="${id}-original.png">${panels.join('')}`)
}
await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2))
await writeFile(path.join(out,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Target Mode 实图验收</title><style>body{font-family:system-ui;max-width:1300px;margin:auto;padding:24px;background:#faf8f5}.pair{display:flex;gap:12px}figure{margin:0;flex:1;min-width:0}img{width:100%;image-rendering:pixelated}.original{max-width:320px}section{margin:24px 0;padding:16px;background:white}figcaption{padding:12px}h1{font-size:26px}</style><h1>Legacy vs Target：同图、同尺寸、MARD 221</h1><p>目标模式试用版，旧版仍保留。灰色表示透明格，不带网格线。所有图片从最终色号矩阵绘制。单格色块包含必要五官和高光，不等同于无意义杂色。</p><p>区域保护使用传统图像分析，尚不能保证十二种图片类型的语义识别。请重点检查五官、轮廓、主要配色；颜色少并不自动代表效果更好。</p>${sections.join('')}</html>`)
