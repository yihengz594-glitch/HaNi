// Diagnostic rendering only: all pattern pixels come from the final color-code grid.
// Usage: node compare-facial-details.mjs BASELINE_ROOT INPUT_IMAGE OUTPUT_DIR
import {spawnSync} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {createCanvas,loadImage} from '@napi-rs/canvas'
import {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const require=createRequire(import.meta.url)
const engine=require('../../shared/small-pattern-engine.js')
const palette=require('../../pages/index/palette.js')
const [baseline,input,out]=process.argv.slice(2)
if(!baseline||!input||!out)throw new Error('Specify baseline, input image and output directory')
const comparison=spawnSync(process.execPath,[fileURLToPath(new URL('./compare-small-patterns.mjs',import.meta.url)),baseline,input,out],{encoding:'utf8'})
if(comparison.status!==0)throw new Error(comparison.stderr)
const im=await loadImage(await readFile(input))
const oldEngine=require(path.join(baseline,'shared/small-pattern-engine.js'))
const analyses=[oldEngine.analyze(im,o=>createCanvas(o.width,o.height)),engine.analyze(im,o=>createCanvas(o.width,o.height))]
const colors=new Map(palette.map(p=>[p.code,p]))
// This ROI describes this regression image, never supplies coordinates to the algorithm.
const roi={left:0.42*im.width,top:0.24*im.height,width:0.26*im.width,height:0.17*im.height}
const face=createCanvas(900,340),ctx=face.getContext('2d')
ctx.fillStyle='#f4f4f4';ctx.fillRect(0,0,900,340)
ctx.fillStyle='#222';ctx.font='20px sans-serif'
ctx.fillText('Original',12,26);ctx.fillText('Before 52 x 52',310,26);ctx.fillText('After 52 x 52',610,26)
ctx.drawImage(im,roi.left,roi.top,roi.width,roi.height,12,45,270,270)
for(let k=0;k<2;k++){
  const a=analyses[k],inset=a.inset??(a.mask.removed||a.kind==='pixel'?1:0)
  const scale=Math.min((52-2*inset)/a.bounds.width,(52-2*inset)/a.bounds.height)
  const left=a.bounds.left-(52/scale-a.bounds.width)/2,top=a.bounds.top-(52/scale-a.bounds.height)/2
  const result=JSON.parse(await readFile(path.join(out,`52x52-${k?'new':'old'}.json`),'utf8'))
  const grid=createCanvas(832,832),g=grid.getContext('2d')
  g.fillStyle='#ededed';g.fillRect(0,0,832,832)
  result.gridCodes.forEach((row,y)=>row.forEach((code,x)=>{if(code){g.fillStyle=colors.get(code).hex;g.fillRect(x*16,y*16,16,16)}}))
  ctx.imageSmoothingEnabled=false
  ctx.drawImage(grid,(roi.left-left)*scale*16,(roi.top-top)*scale*16,roi.width*scale*16,roi.height*scale*16,310+300*k,45,270,270)
}
await writeFile(path.join(out,'face-comparison.png'),face.toBuffer('image/png'))
let html=await readFile(path.join(out,'index.html'),'utf8')
html=html.replace('粉色角色：同图、同格数、MARD 221、不合并','毕业女孩：同图、同格数、MARD 221、不合并')
html=html.replace('</header>','</header><section><h2>原图 / 修改前52格 / 修改后52格：相同原图面部区域</h2><img style="width:900px" src="face-comparison.png"></section>')
await writeFile(path.join(out,'index.html'),html)
const report=JSON.parse(await readFile(path.join(out,'report.json'),'utf8'))
console.log(JSON.stringify({beforeKind:analyses[0].kind,afterKind:analyses[1].kind,large:report.filter(r=>Math.max(r.settings.gridWidth,r.settings.gridHeight)>52).map(r=>({size:r.label,equal:r.equal}))},null,2))
