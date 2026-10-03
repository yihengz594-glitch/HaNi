import { createCanvas } from '@napi-rs/canvas'
export function transparentCartoon() {
  const c=createCanvas(180,240),ctx=c.getContext('2d')
  ctx.fillStyle='#000';ctx.fillRect(20,20,140,200)
  ctx.fillStyle='#ffe2ea';ctx.fillRect(28,28,124,80)
  ctx.fillStyle='#feffff';ctx.fillRect(28,116,124,96)
  ctx.fillStyle='#000';ctx.fillRect(52,144,8,16);ctx.fillRect(120,144,8,16)
  ctx.fillStyle='#ffe000';ctx.fillRect(84,166,8,8)
  ctx.clearRect(40,194,16,10) // intentional interior transparent hole
  return c.toBuffer('image/png')
}
export function opaqueWhite() {
  const c=createCanvas(80,100),ctx=c.getContext('2d')
  ctx.fillStyle='#fff';ctx.fillRect(0,0,80,100)
  return c.toBuffer('image/png')
}
export function checkerboard() {
  const c=createCanvas(96,96),ctx=c.getContext('2d')
  for(let y=0;y<12;y++)for(let x=0;x<12;x++){
    ctx.fillStyle=(x+y)%2?'#ddd':'#fff';ctx.fillRect(x*8,y*8,8,8)
  }
  return c.toBuffer('image/png')
}
