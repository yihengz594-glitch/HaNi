// Small boards only. Work from native pixels, never from the legacy normalized canvas.
// Empty cells are represented by empty:true; an opaque white sample stays a real bead.
const { rgbToLab, deltaE, EMPTY_CELL } = require('./low-resolution-engine')
const MAX_EDGE = 52
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const distance = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2])
const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)]
const medianRgb = samples => [0,1,2].map(k=>median(samples.map(s=>s.rgb[k])))
function readPixels(image, createCanvas) {
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = createCanvas({ type:'2d', width, height })
  canvas.width=width; canvas.height=height
  const ctx=canvas.getContext('2d')
  ctx.clearRect(0,0,width,height)
  ctx.drawImage(image,0,0,width,height)
  return { width, height, pixels:ctx.getImageData(0,0,width,height).data }
}
function pixelAt(source,x,y) {
  if (x<0 || y<0 || x>=source.width || y>=source.height) return null
  const i=(y*source.width+x)*4, p=source.pixels
  return { rgb:[p[i],p[i+1],p[i+2]], alpha:p[i+3], index:y*source.width+x }
}
// Strong edge positions on a scaled sprite form a periodic lattice in BOTH axes.
// Use its phase and period, rather than JPEG block boundaries or a guessed cell size.
function axisLattice(source, vertical) {
  const length=vertical?source.height:source.width
  const cross=vertical?source.width:source.height
  const edges=new Float64Array(length)
  for (let a=1;a<length;a++) {
    for (let b=0;b<cross;b+=Math.max(1,Math.floor(cross/300))) {
      const p=pixelAt(source,vertical?b:a,vertical?a:b)
      const q=pixelAt(source,vertical?b:a-1,vertical?a-1:b)
      const d=distance(p.rgb,q.rgb)
      if (p.alpha>=28 && q.alpha>=28 && d>100) edges[a]+=d
    }
  }
  const total=edges.reduce((a,b)=>a+b,0)
  if (total<cross*300) return null
  let best=null
  for(let period=3;period<=Math.min(32,length/9);period+=0.05) {
    let cos=0,sin=0
    for(let a=1;a<length;a++) {
      const angle=2*Math.PI*a/period
      cos+=edges[a]*Math.cos(angle); sin+=edges[a]*Math.sin(angle)
    }
    const score=Math.hypot(cos,sin)/total
    if (!best || score>best.score) best={period,phase:((Math.atan2(sin,cos)/(2*Math.PI)*period)%period+period)%period,score}
  }
  return best && best.score>=0.68 ? best : null
}
function classify(source) {
  const x=axisLattice(source,false), y=axisLattice(source,true)
  const lattice=x&&y&&Math.abs(x.period-y.period)/Math.max(x.period,y.period)<0.08 ? {x,y} : null
  const bins=new Map(); let flat=0,total=0
  const step=Math.max(1,Math.floor(Math.max(source.width,source.height)/180))
  for(let y=0;y<source.height;y+=step) for(let x=1;x<source.width;x+=step) {
    const p=pixelAt(source,x,y), q=pixelAt(source,x-1,y)
    if(p.alpha<28) continue
    total++; if(distance(p.rgb,q.rgb)<16) flat++
    const key=p.rgb.map(v=>Math.round(v/32)).join(':')
    bins.set(key,(bins.get(key)||0)+1)
  }
  const major=[...bins.values()].sort((a,b)=>b-a).slice(0,16).reduce((a,b)=>a+b,0)/Math.max(1,total)
  const confirmedLattice=lattice&&flat/Math.max(1,total)>0.86&&major>0.78?lattice:null
  // Richly colored cartoons need more than sixteen bins. Keep the photographic
  // branch unless the image still has exceptionally flat native-pixel regions.
  const cartoon=flat/Math.max(1,total)>0.86&&major>0.78 || flat/Math.max(1,total)>0.90&&major>0.70
  return { kind:confirmedLattice?'pixel':cartoon?'cartoon':'photo', lattice:confirmedLattice }
}
function foreground(source, kind, reconstructedOpaque = false) {
  const n=source.width*source.height, outside=new Uint8Array(n)
  let transparent=0
  for(let i=0;i<n;i++) if(source.pixels[i*4+3]<28) transparent++
  // Real alpha is authoritative. Never erase an additional color from an alpha image.
  if ((transparent && !reconstructedOpaque) || kind==='photo') return { outside, isForeground:i=>source.pixels[i*4+3]>=28, removed:false }
  const border=[]
  for(let x=0;x<source.width;x++){border.push(pixelAt(source,x,0));border.push(pixelAt(source,x,source.height-1))}
  for(let y=1;y<source.height-1;y++){border.push(pixelAt(source,0,y));border.push(pixelAt(source,source.width-1,y))}
  const opaqueBorder=border.filter(p=>p.alpha>=28)
  if(!opaqueBorder.length)return {outside,isForeground:i=>source.pixels[i*4+3]>=28,removed:false}
  const rgb=medianRgb(opaqueBorder)
  if(opaqueBorder.filter(p=>distance(p.rgb,rgb)<20).length/opaqueBorder.length<0.8) return {outside,isForeground:i=>source.pixels[i*4+3]>=28,removed:false}
  const queue=new Int32Array(n);let size=0
  const add=i=>{
    if(i<0||i>=n||outside[i]) return
    const p=pixelAt(source,i%source.width,Math.floor(i/source.width))
    if(p.alpha>=28&&distance(p.rgb,rgb)>18) return
    outside[i]=1;queue[size++]=i
  }
  for(let x=0;x<source.width;x++){add(x);add((source.height-1)*source.width+x)}
  for(let y=1;y<source.height-1;y++){add(y*source.width);add(y*source.width+source.width-1)}
  for(let c=0;c<size;c++){
    const i=queue[c],x=i%source.width,y=Math.floor(i/source.width)
    if(x) add(i-1);if(x<source.width-1)add(i+1);if(y)add(i-source.width);if(y<source.height-1)add(i+source.width)
  }
  // A flat border is insufficient: require an actual contrasting enclosed outline.
  let boundary=0,contrast=0
  for(let i=0;i<n;i++) if(!outside[i]) {
    const x=i%source.width,y=Math.floor(i/source.width)
    if((x&&outside[i-1])||(x<source.width-1&&outside[i+1])||(y&&outside[i-source.width])||(y<source.height-1&&outside[i+source.width])){
      boundary++
      let hasOutline=false
      for(let dy=-3;dy<=3&&!hasOutline;dy++)for(let dx=-3;dx<=3&&!hasOutline;dx++){
        const p=pixelAt(source,x+dx,y+dy)
        if(p&&p.alpha>=28&&distance(p.rgb,rgb)>90)hasOutline=true
      }
      if(hasOutline)contrast++
    }
  }
  const removed=size/n>0.01&&size/n<0.97&&boundary>12&&contrast/boundary>0.35
  if(!removed) outside.fill(0)
  return {outside,isForeground:i=>source.pixels[i*4+3]>=28&&!outside[i],removed}
}
function boundsOf(source, mask) {
  let left=source.width,top=source.height,right=-1,bottom=-1
  for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++)if(mask.isForeground(y*source.width+x)){
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)
  }
  return right<left?null:{left,top,width:right-left+1,height:bottom-top+1}
}
function trimWhitePadding(source,bounds,mask,kind) {
  if(!bounds||mask.removed||kind!=='photo')return bounds
  // Crop only a demonstrably uniform, opaque near-white outer frame. This does
  // NOT remove white pixels from the subject, or infer a background in a photo.
  const border=[]
  for(let x=0;x<source.width;x++){border.push(pixelAt(source,x,0));border.push(pixelAt(source,x,source.height-1))}
  for(let y=1;y<source.height-1;y++){border.push(pixelAt(source,0,y));border.push(pixelAt(source,source.width-1,y))}
  if(border.some(p=>p.alpha<250))return bounds
  const color=medianRgb(border)
  if(color.some(v=>v<245)||border.filter(p=>distance(p.rgb,color)<=12).length/border.length<0.98)return bounds
  let left=source.width,top=source.height,right=-1,bottom=-1,content=0
  for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
    const p=pixelAt(source,x,y)
    if(p.alpha<250)return bounds
    if(distance(p.rgb,color)>18){content++;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}
  }
  if(content<source.width*source.height*0.01)return bounds
  // Leave two native pixels around visible marks to keep JPEG antialiasing.
  left=Math.max(0,left-2);top=Math.max(0,top-2)
  right=Math.min(source.width-1,right+2);bottom=Math.min(source.height-1,bottom+2)
  const tight={left,top,width:right-left+1,height:bottom-top+1}
  return tight.width*tight.height<bounds.width*bounds.height*0.95?tight:bounds
}
function rebuildPixelSource(source,lattice,mask) {
  const x0=Math.floor(-lattice.x.phase/lattice.x.period),y0=Math.floor(-lattice.y.phase/lattice.y.period)
  const width=Math.ceil((source.width-lattice.x.phase)/lattice.x.period)-x0
  const height=Math.ceil((source.height-lattice.y.phase)/lattice.y.period)-y0
  const pixels=new Uint8ClampedArray(width*height*4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const samples=[]
    for(let sy=0;sy<5;sy++)for(let sx=0;sx<5;sx++){
      const px=Math.floor(lattice.x.phase+(x+x0+0.2+sx*0.15)*lattice.x.period)
      const py=Math.floor(lattice.y.phase+(y+y0+0.2+sy*0.15)*lattice.y.period)
      const p=pixelAt(source,px,py)
      if(p&&p.alpha>=28&&mask.isForeground(p.index))samples.push(p)
    }
    if(samples.length<10)continue
    const rgb=medianRgb(samples),i=(y*width+x)*4
    pixels.set([...rgb,255],i)
  }
  return {width,height,pixels}
}
function family(rgb) {
  const lab=rgbToLab(rgb),c=Math.hypot(lab[1],lab[2])
  if(lab[0]>92&&c<8)return 'white'
  if(lab[0]<22&&c<15)return 'black'
  if(rgb[2]>rgb[0]+8&&rgb[2]>=rgb[1]+2)return 'cool'
  if(c<12)return 'neutral'
  const angle=Math.atan2(lab[2],lab[1])*180/Math.PI
  return `hue${Math.floor((angle+180)/30)}`
}
function sampleCells(source,mask,bounds,columns,rows,kind) {
  // Fit the entire visible bounds, not a cover crop. One dimension reaches the
  // canvas edge; any remaining letterbox space is required by the aspect ratio.
  const inset=0
  const scale=Math.min((columns-inset*2)/bounds.width,(rows-inset*2)/bounds.height)
  const left=bounds.left-(columns/scale-bounds.width)/2,top=bounds.top-(rows/scale-bounds.height)/2
  const grid=[]
  for(let y=0;y<rows;y++){
    const row=[]
    for(let x=0;x<columns;x++){
      const samples=[],groups=[];let center=null
      const steps=kind==='pixel'?1:kind==='cartoon'?11:7
      for(let sy=0;sy<steps;sy++)for(let sx=0;sx<steps;sx++){
        const px=Math.floor(left+(x+(sx+0.5)/steps)/scale),py=Math.floor(top+(y+(sy+0.5)/steps)/scale)
        const p=pixelAt(source,px,py)
        if(!p||p.alpha<28||!mask.isForeground(p.index))continue
        p.weight=1
        p.sx=sx; p.sy=sy
        if(sx===Math.floor(steps/2)&&sy===Math.floor(steps/2))center=p
        samples.push(p)
        let group=groups.find(g=>distance(g.anchor,p.rgb)<22)
        if(!group){group={anchor:p.rgb,samples:[]};groups.push(group)}
        group.samples.push(p)
      }
      if(!samples.length||samples.length/(steps*steps)<0.35){row.push(null);continue}
      groups.sort((a,b)=>b.samples.length-a.samples.length)
      let chosen=groups[0]
      // A minority line is selected only when it crosses the cell center and occupies
      // enough area. This keeps small central features without dilating every edge.
      if(center){
        const central=groups.find(g=>g.samples.includes(center))
        if(central&&central!==chosen&&central.samples.length/samples.length>=0.24&&distance(central.anchor,chosen.anchor)>75)chosen=central
      }
      if(kind==='cartoon'&&rgbToLab(chosen.anchor)[0]>65){
        // Preserve a real, thin stroke embedded in a light region (a mouth or
        // eyebrow), not an arbitrary darkest pixel or an outer silhouette edge.
        // Evidence must span the cell and have light samples on BOTH sides.
        const light=chosen,lightL=rgbToLab(light.anchor)[0]
        const bright=(sx,sy)=>{
          const p=pixelAt(source,Math.floor(left+(x+(sx+0.5)/steps)/scale),Math.floor(top+(y+(sy+0.5)/steps)/scale))
          return p&&p.alpha>=28&&mask.isForeground(p.index)&&rgbToLab(p.rgb)[0]>lightL-12
        }
        const strokes=groups.filter(g=>{
          const fraction=g.samples.length/samples.length
          if(g===light||fraction<0.04||fraction>0.32||rgbToLab(g.anchor)[0]>lightL-25)return false
          const xs=g.samples.map(p=>p.sx),ys=g.samples.map(p=>p.sy)
          if(Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))<steps*0.25)return false
          return g.samples.filter(p=>(bright(p.sx,p.sy-2)&&bright(p.sx,p.sy+2))||(bright(p.sx-2,p.sy)&&bright(p.sx+2,p.sy))).length>=2
        })
        if(strokes.length)chosen=strokes[0]
      }
      if(kind==='cartoon'&&rgbToLab(chosen.anchor)[0]<38){
        const accent=groups.find(g=>g.anchor[2]>g.anchor[0]+12&&g.anchor[2]>g.anchor[1]+4&&g.samples.length/samples.length>=0.14)
        if(accent)chosen=accent
      }
      const rgb=kind==='photo'?medianRgb(samples):medianRgb(chosen.samples)
      row.push({rgb,lab:rgbToLab(rgb),family:family(rgb),confidence:chosen.samples.length/samples.length})
    }
    grid.push(row)
  }
  return grid
}
// Weighted perceptual distance with a guard against moving near-neutral white into
// warm flesh colors. Actual selected MARD colors are never modified.
function colorDistance(cell, rgb, lab) {
  let d=deltaE(cell.lab,lab)
  if(cell.family==='white'&&family(rgb)!=='white')d+=30
  if(cell.family==='black'&&lab[0]>30)d+=30
  if(cell.family==='cool'&&family(rgb)!=='cool')d+=8
  const chroma=Math.hypot(cell.lab[1],cell.lab[2])
  if(chroma>14&&Math.hypot(lab[1],lab[2])>8){
    const cross=cell.lab[1]*lab[2]-cell.lab[2]*lab[1],dot=cell.lab[1]*lab[1]+cell.lab[2]*lab[2]
    d+=Math.abs(Math.atan2(cross,dot))*chroma*0.45
  }
  return d
}
function assignColors(cells,palette,kind,threshold) {
  const labs=palette.map(c=>rgbToLab(c.rgb)), clusters=[]
  const merge=kind==='photo'?4:6
  const result=cells.map(row=>row.map(cell=>{
    if(!cell)return null
    let cluster=clusters.find(c=>c.family===cell.family&&deltaE(c.lab,cell.lab)<=merge)
    if(!cluster){cluster={family:cell.family,lab:cell.lab,rgb:cell.rgb,count:0};clusters.push(cluster)}
    cluster.count++;return {cell,cluster}
  }))
  for(const cluster of clusters){
    let best=0,bestDistance=Infinity
    palette.forEach((color,i)=>{const d=colorDistance(cluster,color.rgb,labs[i]);if(d<bestDistance){best=i;bestDistance=d}})
    cluster.color=palette[best]
  }
  // Only collapse close source colors within the same meaningful family; no fixed
  // global color count and no spatial majority operation that erases a nose.
  const extra={none:0,light:3,medium:6,strong:9,veryStrong:12}[threshold]||0
  const sorted=clusters.slice().sort((a,b)=>b.count-a.count)
  for(let i=0;i<sorted.length;i++)for(let j=0;j<i;j++){
    const a=sorted[i],b=sorted[j]
    if(a.family===b.family&&deltaE(a.lab,b.lab)<=merge+extra){a.color=b.color;break}
  }
  return result.map(row=>row.map(entry=>entry?{color:entry.cluster.color,rgb:entry.cell.rgb}:null))
}
function analyze(image,createCanvas) {
  let source=readPixels(image,createCanvas)
  const classification=classify(source)
  let mask=foreground(source,classification.kind)
  if(classification.lattice){
    const opaqueOriginal=!source.pixels.some((v,i)=>i%4===3&&v<28)
    source=rebuildPixelSource(source,classification.lattice,mask)
    mask=foreground(source,'pixel',opaqueOriginal)
  }
  const bounds=trimWhitePadding(source,boundsOf(source,mask),mask,classification.kind)
  return {source,mask,bounds,inset:0,...classification}
}
function generate(runtime,image,size,createCanvas) {
  const columns=size.columns,rows=size.rows
  if(Math.max(columns,rows)>MAX_EDGE)throw new Error('Small pattern engine only supports max(W,H) <= 52')
  const {source,mask,bounds,kind}=analyze(image,createCanvas)
  if(!bounds)return Array.from({length:rows},()=>Array.from({length:columns},()=>({...EMPTY_CELL})))
  const cells=sampleCells(source,mask,bounds,columns,rows,kind)
  // Palette selection respects the user's specification. Similar-color merging is
  // applied here with family protection rather than the legacy RGB palette pruning.
  const originalThreshold=runtime.data.threshold
  let palette
  try{runtime.data.threshold='none';palette=runtime.getActivePalette()}finally{runtime.data.threshold=originalThreshold}
  const colors=assignColors(cells,palette,kind,originalThreshold)
  return colors.map(row=>row.map(entry=>entry?runtime.makeMardColor(entry.color,entry.rgb):({...EMPTY_CELL})))
}
module.exports={MAX_EDGE,generate,analyze,rgbToLab,deltaE}
