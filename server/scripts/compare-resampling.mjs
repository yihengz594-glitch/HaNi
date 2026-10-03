import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createCanvas} from '@napi-rs/canvas'
import {createRequire} from 'node:module'
import path from 'node:path'
import {generatePattern} from '../src/pattern-core.js'
const require=createRequire(import.meta.url),palette=new Map(require('../../pages/index/palette.js').map(c=>[c.code,c]))
const [out,...inputs]=process.argv.slice(2);await mkdir(out,{recursive:true})
const report=[]
for(let i=0;i<inputs.length;i++)for(const size of [52,104])for(const method of ['area','box','lanczos','bicubic','median','dominant']){
  const begin=performance.now(),r=await generatePattern(await readFile(inputs[i]),{sizeMode:'board',gridWidth:size,gridHeight:size,paletteSpec:'221',algorithm:'reconstruction',sampling:method,debug:true})
  report.push({input:inputs[i],size,method,ms:Math.round(performance.now()-begin),metrics:r.diagnostics.after})
  const canvas=createCanvas(size*8,size*8),g=canvas.getContext('2d');g.fillStyle='#ededed';g.fillRect(0,0,canvas.width,canvas.height)
  r.gridCodes.forEach((row,y)=>row.forEach((code,x)=>{if(code){g.fillStyle=palette.get(code).hex;g.fillRect(x*8,y*8,8,8)}}))
  await writeFile(path.join(out,`${i}-${size}-${method}.png`),canvas.toBuffer('image/png'))
}
await writeFile(path.join(out,'resampling.json'),JSON.stringify(report,null,2))
await writeFile(path.join(out,'index.html'),`<meta charset="utf-8"><title>采样比较</title><style>body{font-family:system-ui}.row{display:flex;flex-wrap:wrap}figure{width:30%;margin:10px}img{width:100%;image-rendering:pixelated}</style><h1>AREA采样、BOX、Lanczos3、Bicubic、Median、Dominant</h1><p>所有方法在同一预平滑、色板匹配和清理流程下比较。AREA为均匀积分近似，BOX为矩形核；不宣称等同第三方库实现。</p><div class="row">${report.map((r,j)=>`<figure><figcaption>图${Math.floor(j/12)+1} ${r.size}格 ${r.method} ${r.metrics.colorCount}色</figcaption><img src="${Math.floor(j/12)}-${r.size}-${r.method}.png"></figure>`).join('')}</div>`)
