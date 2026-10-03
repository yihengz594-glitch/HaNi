import {createCanvas,loadImage} from '@napi-rs/canvas'
import {writeFile} from 'node:fs/promises'
const root='/private/tmp/pinbead-small-preview'
const c=createCanvas(1600,680),ctx=c.getContext('2d')
ctx.fillStyle='#ffffff';ctx.fillRect(0,0,c.width,c.height)
ctx.fillStyle='#222';ctx.font='24px sans-serif'
const images=[['Input',root+'/original.png'],['Old 38x38',root+'/38x38-old.png'],['New 38x38',root+'/38x38-new.png'],['Reference (user screenshot)','/tmp/codex-remote-attachments/01a06aed-6053-7f71-9aa8-99f85219259d/0207B175-BCE9-42A0-A2C2-B92D07A484E4/3-照片-3.jpg']]
for(let i=0;i<images.length;i++){
  ctx.fillText(images[i][0],i*400+12,38)
  const im=await loadImage(images[i][1]);ctx.imageSmoothingEnabled=false
  if(i===3)ctx.drawImage(im,19,251,550,585,i*400+12,80,376,400)
  else {const scale=Math.min(376/im.width,400/im.height);ctx.drawImage(im,i*400+12,80,im.width*scale,im.height*scale)}
}
ctx.font='20px sans-serif';ctx.fillText('Same input / MARD 221 / no merge. Gray = empty, white = real beads. Reference is not generated.',12,560)
await writeFile(root+'/comparison.png',c.toBuffer('image/png'))
