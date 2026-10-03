import {spawnSync} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {createCanvas,loadImage} from '@napi-rs/canvas'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
const [baseline,input,out]=process.argv.slice(2)
if(!baseline||!input||!out)throw new Error('Usage: compare-compact-layout.mjs BASELINE INPUT OUTPUT')
const run=spawnSync(process.execPath,[fileURLToPath(new URL('./compare-small-patterns.mjs',import.meta.url)),baseline,input,out,'layout'],{encoding:'utf8'})
if(run.status!==0)throw new Error(run.stderr)
const rows=JSON.parse(await readFile(path.join(out,'report.json'),'utf8'))
const extent=mask=>{
  let left=Infinity,top=Infinity,right=-1,bottom=-1
  mask.forEach((row,y)=>row.forEach((present,x)=>{if(present){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}}))
  return {width:right-left+1,height:bottom-top+1}
}
const occupancy=rows.map(r=>({size:r.label,before:extent(r.oldStats.mask),after:extent(r.newStats.mask)}))
await writeFile(path.join(out,'occupancy.json'),JSON.stringify(occupancy,null,2))
const c=createCanvas(1040,560),ctx=c.getContext('2d')
ctx.fillStyle='#f5f5f5';ctx.fillRect(0,0,1040,560)
ctx.fillStyle='#222';ctx.font='24px sans-serif'
ctx.fillText('64 x 64 before',15,32);ctx.fillText('64 x 64 compact fit',535,32)
ctx.imageSmoothingEnabled=false
ctx.drawImage(await loadImage(path.join(out,'64x64-old.png')),15,48,500,500)
ctx.drawImage(await loadImage(path.join(out,'64x64-new.png')),535,48,500,500)
await writeFile(path.join(out,'comparison-64.png'),c.toBuffer('image/png'))
console.log(JSON.stringify(occupancy,null,2))
