// Experimental all-resolution bead reconstruction. No model, randomness or dithering.
// Semantic labels are heuristic hypotheses, never a claim of face recognition.
const native = require('./small-pattern-engine')
const { detectStructure, projectStructure } = require('./target-analysis')
const { EMPTY_CELL } = require('./low-resolution-engine')
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const chroma = rgb => Math.max(...rgb) - Math.min(...rgb)
const rgbDistance = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2])
const labDistance = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2])
function oklab(rgb) {
  const v = rgb.map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x+.055)/1.055)**2.4 })
  const l = Math.cbrt(.4122214708*v[0]+.5363325363*v[1]+.0514459929*v[2])
  const m = Math.cbrt(.2119034982*v[0]+.6806995451*v[1]+.1073969566*v[2])
  const s = Math.cbrt(.0883024619*v[0]+.2817188376*v[1]+.6299787005*v[2])
  return [100*(.2104542553*l+.793617785*m-.0040720468*s),100*(1.9779984951*l-2.428592205*m+.4505937099*s),100*(.0259040371*l+.7827717662*m-.808675766*s)]
}
function family(rgb) {
  const lab=oklab(rgb), c=Math.hypot(lab[1],lab[2])
  if(lab[0]>92&&c<2.5&&chroma(rgb)<22)return 'white'
  if(c<1.2||chroma(rgb)<8) return 'neutral'
  return `h${Math.floor((Math.atan2(lab[2],lab[1])+Math.PI)/(Math.PI/6))}`
}
function analyzeImage(source, originalKind) {
  let count=0, neutral=0, saturation=0, flat=0, skin=0, gradient=0
  const bins=new Map(), p=source.pixels, step=Math.max(1,Math.floor(Math.max(source.width,source.height)/160))
  for(let y=0;y<source.height;y+=step)for(let x=0;x<source.width;x+=step){
    const i=(y*source.width+x)*4;if(p[i+3]<28)continue
    const rgb=[p[i],p[i+1],p[i+2]], c=chroma(rgb)
    count++;neutral+=c<12?1:0;saturation+=c/Math.max(1,...rgb)
    skin+=rgb[0]>rgb[1]+8&&rgb[1]>rgb[2]&&rgb[0]>100?1:0
    const key=rgb.map(v=>Math.round(v/24)).join(':');bins.set(key,(bins.get(key)||0)+1)
    if(x){const d=rgbDistance(rgb,[p[i-4],p[i-3],p[i-2]]);flat+=d<8?1:0;gradient+=d}
  }
  const n=Math.max(1,count), top=[...bins.values()].sort((a,b)=>b-a).slice(0,12).reduce((a,b)=>a+b,0)/n
  const meanSaturation=saturation/n, neutralFraction=neutral/n, flatFraction=flat/n
  let kind=originalKind==='pixel'?'pixel':originalKind==='cartoon'?'illustration':'photograph'
  if(neutralFraction>.94&&meanSaturation<.055)kind='monochrome'
  else if(meanSaturation<.10)kind='low-saturation'
  else if(flatFraction>.94&&top>.9)kind='flat-design'
  else if(originalKind==='cartoon'&&meanSaturation>.45)kind='saturated-cartoon'
  else if(flatFraction<.75&&gradient/n>8)kind='textured-image'
  return {kind,meanSaturation,neutralFraction,flatFraction,complexity:1-top,skinFraction:skin/n,meanGradient:gradient/n,semanticDetection:'heuristic-only'}
}
function boundedWorkingSource(analyzed,width,height,analysisLimit) {
  if(analyzed.kind==='pixel')return analyzed
  const original=analyzed.source,limit=analysisLimit||Math.max(256,Math.min(640,Math.max(width,height)*5))
  const scale=Math.min(1,limit/Math.max(original.width,original.height))
  if(scale===1)return analyzed
  const w=Math.max(1,Math.round(original.width*scale)),h=Math.max(1,Math.round(original.height*scale)),pixels=new Uint8ClampedArray(w*h*4),foreground=new Uint8Array(w*h)
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const left=x*original.width/w,right=(x+1)*original.width/w,top=y*original.height/h,bottom=(y+1)*original.height/h
    const sum=[0,0,0];let weight=0,coverage=0
    for(let yy=Math.floor(top);yy<Math.ceil(bottom);yy++)for(let xx=Math.floor(left);xx<Math.ceil(right);xx++){
      const j=yy*original.width+xx
      if(!analyzed.mask.isForeground(j))continue
      const area=(Math.min(right,xx+1)-Math.max(left,xx))*(Math.min(bottom,yy+1)-Math.max(top,yy))
      const alpha=original.pixels[j*4+3]/255,a=area*alpha
      coverage+=area;weight+=a
      for(let c=0;c<3;c++)sum[c]+=original.pixels[j*4+c]*a
    }
    const i=y*w+x,area=(right-left)*(bottom-top)
    if(!weight)continue
    for(let c=0;c<3;c++)pixels[i*4+c]=sum[c]/weight
    pixels[i*4+3]=255*weight/area
    foreground[i]=coverage/area>=.35?1:0
  }
  const bounds=analyzed.bounds?{left:analyzed.bounds.left*scale,top:analyzed.bounds.top*scale,width:analyzed.bounds.width*scale,height:analyzed.bounds.height*scale}:null
  return {...analyzed,source:{width:w,height:h,pixels},bounds,mask:{isForeground:i=>Boolean(foreground[i]),removed:analyzed.mask.removed}}
}
function resolutionParameters(width,height,analysis) {
  const resolutionFactor=Math.sqrt(width*height)
  const base=resolutionFactor<=32?14:resolutionFactor<=52?22:resolutionFactor<=80?30:resolutionFactor<=100?38:60
  const flat=['pixel','flat-design','monochrome'].includes(analysis.kind)
  return {resolutionFactor,colorBudget:Math.round(base*(.8+.5*analysis.complexity)),
    smoothRadius:flat?0:resolutionFactor<=52?2:1,rangeSigma:analysis.kind==='low-saturation'?22:18,
    smallRegionLimit:3,mergeDistance:resolutionFactor<=52?8:6,
    backgroundDetailFactor:.55,regionConsistencyPenalty:flat?.15:.7,paletteComplexityPenalty:2.5,
    isolatedPixelPenalty:1.5,dithering:false}
}
function buildImportanceMap(source,mask,structure) {
  const n=source.width*source.height,p=source.pixels,w=source.width,h=source.height
  const edge=new Float32Array(n), importance=new Float32Array(n), subject=new Uint8Array(n)
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;if(!mask.isForeground(i))continue
    const k=i*4, rgb=[p[k],p[k+1],p[k+2]]
    let d=0
    for(const j of [x?i-1:i,x+1<w?i+1:i,y?i-w:i,y+1<h?i+w:i]){
      if(p[j*4+3]>=28)d=Math.max(d,rgbDistance(rgb,[p[j*4],p[j*4+1],p[j*4+2]]))
    }
    edge[i]=Math.min(1,d/100)
    // Foreground alpha is certain; central weighting is only a saliency prior.
    const central=Math.exp(-((x/w-.5)**2+(y/h-.45)**2)*5)
    subject[i]=Math.round(255*central)
    const role=structure?.roles[i]||1
    importance[i]=role>=4?5:1+central+edge[i]*(structure?.strategy==='pet'?1:2)
  }
  return {edge,importance,subject,roles:structure?.roles,features:structure?.featureMask}
}
function adaptiveSmooth(source,mask,maps,params) {
  if(!params.smoothRadius)return source
  const w=source.width,h=source.height,p=source.pixels,out=new Uint8ClampedArray(p)
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x,k=i*4;if(!mask.isForeground(i)||maps.edge[i]>.65)continue
    const important=(maps.roles?.[i]||1)>=4
    const r=important?Math.min(1,params.smoothRadius):params.smoothRadius
    const sigma=important?Math.min(12,params.rangeSigma):params.rangeSigma
    const sum=[0,0,0];let weight=0
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
      const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue
      const j=yy*w+xx;if(!mask.isForeground(j))continue
      const q=j*4,d2=(p[k]-p[q])**2+(p[k+1]-p[q+1])**2+(p[k+2]-p[q+2])**2
      const a=Math.exp(-d2/(2*sigma**2)-(dx*dx+dy*dy)/(2*r*r))
      weight+=a;for(let c=0;c<3;c++)sum[c]+=a*p[q+c]
    }
    for(let c=0;c<3;c++)out[k+c]=sum[c]/Math.max(1e-9,weight)
  }
  return {...source,pixels:out}
}
function sampleCells(source,mask,bounds,width,height,maps,method='area',detailPass=false) {
  const scale=Math.min(width/bounds.width,height/bounds.height)
  const left=bounds.left-(width/scale-bounds.width)/2,top=bounds.top-(height/scale-bounds.height)/2
  const cells=new Array(width*height).fill(null),p=source.pixels
  if(['box','lanczos','bicubic'].includes(method))return sampleKernelCells(source,mask,width,height,maps,scale,left,top,method)
  const steps=method==='nearest'?1:clamp(Math.ceil(1/scale),3,detailPass?17:9)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const samples=[];let edge=0,importance=0,lineEvidence=false,featureEvidence=false,highlightEvidence=false,role=1
    for(let dy=0;dy<steps;dy++)for(let dx=0;dx<steps;dx++){
      const xx=Math.floor(left+(x+(dx+.5)/steps)/scale),yy=Math.floor(top+(y+(dy+.5)/steps)/scale)
      if(xx<0||yy<0||xx>=source.width||yy>=source.height)continue
      const j=yy*source.width+xx,k=j*4;if(p[k+3]<28||!mask.isForeground(j))continue
      const region=maps.roleAt?maps.roleAt(xx,yy):{role:maps.roles?.[j]||1,feature:maps.features?.[j]||0}
      role=Math.max(role,region.role)
      samples.push({rgb:[p[k],p[k+1],p[k+2]],dx,dy,feature:region.feature,central:Math.abs(dx-(steps-1)/2)<=1&&Math.abs(dy-(steps-1)/2)<=1})
      edge=Math.max(edge,maps.edge?.[j]||0);importance+=maps.importance?.[j]||1
    }
    if(samples.length<steps*steps*.3)continue
    let rgb
    if(method==='area')rgb=[0,1,2].map(c=>samples.reduce((s,v)=>s+v.rgb[c],0)/samples.length)
    else if(method==='median')rgb=[0,1,2].map(c=>samples.map(v=>v.rgb[c]).sort((a,b)=>a-b)[Math.floor(samples.length/2)])
    else {
      const groups=[]
      for(const sample of samples){let g=groups.find(v=>rgbDistance(v.anchor,sample.rgb)<24);if(!g){g={anchor:sample.rgb,items:[]};groups.push(g)}g.items.push(sample)}
      groups.sort((a,b)=>b.items.length-a.items.length);let selected=groups[0]
      const feature=groups.find(g=>g!==selected&&g.items.length/samples.length>=.10&&g.items.some(v=>v.central)&&oklab(g.anchor)[0]<oklab(selected.anchor)[0]-20)
      if(feature&&role>=4){selected=feature;featureEvidence=true}
      if(detailPass&&oklab(groups[0].anchor)[0]<65){
        const highlight=groups.find(g=>g.items.length/samples.length>=.015&&
          g.items.some(v=>v.feature)&&oklab(g.anchor)[0]>88&&chroma(g.anchor)<22&&
          Math.max(...g.items.map(v=>v.dx))-Math.min(...g.items.map(v=>v.dx))<=steps*.6&&
          Math.max(...g.items.map(v=>v.dy))-Math.min(...g.items.map(v=>v.dy))<=steps*.6)
        if(highlight){selected=highlight;featureEvidence=true;highlightEvidence=true}
      }
      if(oklab(groups[0].anchor)[0]>55){
        const light=oklab(groups[0].anchor)[0]
        const bright=(dx,dy)=>samples.some(v=>v.dx===dx&&v.dy===dy&&oklab(v.rgb)[0]>light-10)
        const stroke=groups.find(g=>{
          const fraction=g.items.length/samples.length
          if(fraction<.025||fraction>.35||oklab(g.anchor)[0]>light-18)return false
          const span=Math.max(Math.max(...g.items.map(v=>v.dx))-Math.min(...g.items.map(v=>v.dx)),Math.max(...g.items.map(v=>v.dy))-Math.min(...g.items.map(v=>v.dy)))
          return span>=steps*.4&&g.items.filter(v=>(bright(v.dx,v.dy-1)&&bright(v.dx,v.dy+1))||(bright(v.dx-1,v.dy)&&bright(v.dx+1,v.dy))).length>=2
        })
        if(stroke){selected=stroke;lineEvidence=true}
      }
      rgb=[0,1,2].map(c=>selected.items.reduce((s,v)=>s+v.rgb[c],0)/selected.items.length)
    }
    cells[y*width+x]={rgb,lab:oklab(rgb),family:family(rgb),edge,importance:importance/samples.length,role,protected:lineEvidence||featureEvidence,lineEvidence,featureEvidence,highlightEvidence}
  }
  return cells
}
function sampleKernelCells(source,mask,width,height,maps,scale,left,top,method) {
  const sinc=x=>Math.abs(x)<1e-9?1:Math.sin(Math.PI*x)/(Math.PI*x)
  const kernel=x=>{
    x=Math.abs(x)
    if(method==='box')return x<=.5?1:0
    if(method==='lanczos')return x<3?sinc(x)*sinc(x/3):0
    return x<=1?1.5*x*x*x-2.5*x*x+1:x<2?-.5*x*x*x+2.5*x*x-4*x+2:0
  }
  const effective=Math.min(1,scale),radius=(method==='box'?.5:method==='lanczos'?3:2)/effective
  const cells=new Array(width*height).fill(null),p=source.pixels,w=source.width,h=source.height
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const cx=left+(x+.5)/scale,cy=top+(y+.5)/scale,sum=[0,0,0]
    let weight=0,absolute=0,foreground=0,edge=0,importance=0
    for(let yy=Math.floor(cy-radius);yy<=Math.ceil(cy+radius);yy++)for(let xx=Math.floor(cx-radius);xx<=Math.ceil(cx+radius);xx++){
      const a=kernel((xx+.5-cx)*effective)*kernel((yy+.5-cy)*effective)
      if(!a)continue
      absolute+=Math.abs(a)
      if(xx<0||yy<0||xx>=w||yy>=h)continue
      const i=yy*w+xx,k=i*4;if(p[k+3]<28||!mask.isForeground(i))continue
      const alpha=p[k+3]/255,b=a*alpha
      foreground+=Math.abs(b);weight+=b
      for(let c=0;c<3;c++)sum[c]+=p[k+c]*b
      if(Math.abs(xx-cx)<.5/scale&&Math.abs(yy-cy)<.5/scale)edge=Math.max(edge,maps.edge[i])
      importance+=maps.importance[i]*Math.abs(b)
    }
    if(weight<=1e-6||foreground/Math.max(1e-9,absolute)<.3)continue
    const rgb=sum.map(v=>clamp(v/weight,0,255))
    cells[y*width+x]={rgb,lab:oklab(rgb),family:family(rgb),edge,importance:importance/foreground,protected:false}
  }
  return cells
}
function protectImportantDetails(cells,width,height) {
  // Only local high contrast / small accent evidence; no invented eyes or symmetry.
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x,c=cells[i];if(!c)continue
    const neighbors=[cells[i-1],cells[i+1],cells[i-width],cells[i+width]].filter(Boolean)
    if(neighbors.length<3)continue
    const mean=neighbors.reduce((s,v)=>s+v.lab[0],0)/neighbors.length
    const contrast=Math.abs(c.lab[0]-mean)
    const accent=Math.hypot(c.lab[1],c.lab[2])-neighbors.reduce((s,v)=>s+Math.hypot(v.lab[1],v.lab[2]),0)/neighbors.length
    c.protected=c.protected||(contrast>16&&(c.role||1)>=4)||accent>10
    if(c.protected)c.importance=Math.max(c.importance,5)
  }
}
function restoreImportantDetails(cells,source,mask,bounds,width,height,maps) {
  const reference=sampleCells(source,mask,bounds,width,height,maps,'dominant',true)
  for(let i=0;i<cells.length;i++){
    if(cells[i]&&reference[i]&&(reference[i].lineEvidence||reference[i].featureEvidence)){
      if(reference[i].highlightEvidence){
        const x=i%width,y=Math.floor(i/width);let darkNeighbors=0
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          if(!dx&&!dy||x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)continue
          const c=cells[(y+dy)*width+x+dx];if(c&&c.lab[0]<60)darkNeighbors++
        }
        if(darkNeighbors<2)continue
      }
      cells[i]={...reference[i],edge:Math.max(cells[i].edge,reference[i].edge),protected:true,importance:Math.max(5,reference[i].importance)}
    }
  }
  return cells
}
function regionalClusters(cells,params) {
  // Connected perceptual regions, not a global histogram mixing skin and background.
  const width=params.width,height=params.height,seen=new Uint8Array(cells.length),clusters=[]
  for(let start=0;start<cells.length;start++){
    const first=cells[start];if(!first||seen[start])continue
    const queue=[start],members=[];seen[start]=1;const sum=[0,0,0]
    for(let q=0;q<queue.length;q++){
      const i=queue[q],c=cells[i];members.push(i);for(let k=0;k<3;k++)sum[k]+=c.rgb[k]
      const x=i%width,y=Math.floor(i/width)
      for(const j of [x?i-1:-1,x+1<width?i+1:-1,y?i-width:-1,y+1<height?i+width:-1]){
        const v=cells[j];if(j<0||!v||seen[j]||v.protected||first.protected)continue
        if((v.role||1)===(first.role||1)&&v.family===first.family&&labDistance(v.lab,first.lab)<params.mergeDistance*.65){seen[j]=1;queue.push(j)}
      }
    }
    const rgb=sum.map(v=>v/members.length),cluster={members,rgb,lab:oklab(rgb),family:first.family,protected:members.some(i=>cells[i].protected)}
    clusters.push(cluster)
  }
  return clusters
}
function simplifyRegionalColors(clusters,cells,params,analysis) {
  // Quantize regional source colors BEFORE choosing bead codes. Large coherent
  // areas dominate the budget; protected evidence is weighted, not discarded.
  if(!clusters.length)return clusters
  const points=clusters.map(cluster=>{
    const [r,g,b]=cluster.rgb
    const skinRegion=cluster.members.some(i=>(cells[i].role||1)>=4)&&cluster.lab[0]>68&&
      cluster.lab[1]>1.5&&cluster.lab[2]>-.5&&r-g>6&&g-b>-8&&g-b<45
    // Material kinds retain a fixed cross-kind cost while allowing a nearby
    // warm center to compete for weakly chromatic regional colors.
    // Achromatic material must not borrow the center of a neighboring brown
    // mass. Otherwise dark gray clothing and brown hair become the same red.
    const materialFamily=family(cluster.rgb)
    const neutralRegion=materialFamily==='neutral'||materialFamily==='white'
    return {cluster,rgb:cluster.rgb,lab:cluster.lab,kind:skinRegion?'skin':neutralRegion?'neutral':'general',
      weight:cluster.members.length*(cluster.protected?2:skinRegion?1.5:1),
      importance:cluster.members.reduce((s,i)=>s+cells[i].importance,0)/cluster.members.length}
  })
  const limit=Math.max(2,Math.min(points.length,analysis.kind==='monochrome'?
    Math.min(params.colorBudget,Math.max(5,Math.round(params.resolutionFactor/12))):params.colorBudget))
  const ranked=points.slice().sort((a,b)=>b.weight-a.weight)
  const centers=[{rgb:ranked[0].rgb.slice(),lab:ranked[0].lab.slice(),kind:ranked[0].kind}]
  for(const kind of ['skin','neutral','general']){
    const seed=ranked.find(p=>p.kind===kind)
    if(seed&&centers.every(c=>c.kind!==kind))centers.push({rgb:seed.rgb.slice(),lab:seed.lab.slice(),kind})
  }
  for(const extreme of [points.filter(p=>p.lab[0]>94),points.filter(p=>p.lab[0]<22)]){
    if(!extreme.length)continue
    const representative=extreme.slice().sort((a,b)=>b.weight-a.weight)[0]
    if(centers.every(c=>labDistance(c.lab,representative.lab)>2.5))centers.push({rgb:representative.rgb.slice(),lab:representative.lab.slice(),kind:representative.kind})
  }
  while(centers.length<limit){
    let best=null,bestScore=0
    for(const point of points){
      const d=Math.min(...centers.map(center=>labDistance(point.lab,center.lab)))
      if(d<2.5)continue
      const score=d*d*Math.sqrt(point.weight)*Math.max(1,point.importance/2)
      if(score>bestScore){best=point;bestScore=score}
    }
    if(!best)break
    centers.push({rgb:best.rgb.slice(),lab:best.lab.slice(),kind:best.kind})
  }
  const closest=point=>{
    let index=0,cost=Infinity
    centers.forEach((center,i)=>{
      const kindPenalty=point.kind!==center.kind?8:0
      const d=colorDistance(point.rgb,point.lab,center.lab,center.rgb,analysis.kind==='monochrome')
      const protection=point.cluster.protected?Math.abs(point.lab[0]-center.lab[0])*.5:0
      const toneProtection=(point.lab[0]>94&&center.lab[0]<92 || point.lab[0]<22&&center.lab[0]>26)?25:0
      if(d+protection+toneProtection+kindPenalty<cost){cost=d+protection+toneProtection+kindPenalty;index=i}
    })
    return index
  }
  for(let pass=0;pass<6;pass++){
    const sums=centers.map(()=>({rgb:[0,0,0],weight:0}))
    for(const point of points){
      const sum=sums[closest(point)];sum.weight+=point.weight
      for(let c=0;c<3;c++)sum.rgb[c]+=point.rgb[c]*point.weight
    }
    sums.forEach((sum,i)=>{if(sum.weight){centers[i].rgb=sum.rgb.map(v=>v/sum.weight);centers[i].lab=oklab(centers[i].rgb)}})
  }
  return points.map(point=>{
    const center=centers[closest(point)]
    // A budget is guidance, not permission to delete a distinctive small detail.
    if(point.cluster.protected&&labDistance(point.lab,center.lab)>5)return point.cluster
    // Large coherent regions carry form (hair mass, clothing, fur shadow).
    // Do not spend their tone separation merely to meet a global color budget.
    // Tiny texture fragments still follow the shared regional center.
    const coherentMinimum=Math.max(6,Math.ceil(cells.length*.003))
    if(point.cluster.members.length>=coherentMinimum&&labDistance(point.lab,center.lab)>4)return point.cluster
    return {...point.cluster,originalRgb:point.rgb,rgb:center.rgb.slice(),lab:center.lab.slice(),family:family(center.rgb)}
  })
}
function colorDistance(rgb,lab,colorLab,colorRgb,monochrome) {
  let d=labDistance(lab,colorLab)
  const sourceChroma=Math.hypot(lab[1],lab[2]),targetChroma=Math.hypot(colorLab[1],colorLab[2])
  if(sourceChroma<1.2)d+=Math.max(0,targetChroma-sourceChroma-.5)*3
  if(monochrome&&chroma(colorRgb)>18)d+=100
  if(sourceChroma>1.2&&targetChroma>.6){
    const angle=Math.abs(Math.atan2(lab[1]*colorLab[2]-lab[2]*colorLab[1],lab[1]*colorLab[1]+lab[2]*colorLab[2]))
    d+=angle*Math.min(sourceChroma,12)*1.7
  }
  return d
}
function mapToMardPalette(clusters,cells,palette,params,analysis) {
  if(analysis.kind==='monochrome'){
    const grayCodes=new Set(['H2','H3','H4','H5','H6','H7','H9','H11','H22'])
    const grayPalette=palette.filter(p=>grayCodes.has(p.code))
    if(grayPalette.length>=2)palette=grayPalette
  }
  const neutralCodes=new Set(['H1','H2','H3','H4','H5','H6','H7','H9','H10','H11','H17','H18','H19'])
  const mono=analysis.kind==='monochrome',used=new Map(),grid=new Array(cells.length).fill(null)
  clusters.sort((a,b)=>Number(b.protected)-Number(a.protected)||b.members.length-a.members.length)
  for(const cluster of clusters){
    let best=null,bestCost=Infinity
    // Muted brown hair / warm fur is not grayscale. Lock only genuinely neutral
    // source regions, not every low-saturation color in a low-saturation image.
    const neutralLock=analysis.kind==='low-saturation'&&Math.hypot(cluster.lab[1],cluster.lab[2])<1.2&&chroma(cluster.rgb)<9
    const neutralSource=analysis.kind==='low-saturation'&&Math.hypot(cluster.lab[1],cluster.lab[2])<3.5&&chroma(cluster.rgb)<8
    const candidatePalette=(neutralSource||neutralLock)&&palette.filter(p=>neutralCodes.has(p.code)).length>=3
      ?palette.filter(p=>neutralCodes.has(p.code)):palette
    const labs=candidatePalette.map(p=>oklab(p.rgb))
    const hasNeutral=neutralLock&&candidatePalette.some(p=>chroma(p.rgb)<=10)
    candidatePalette.forEach((p,i)=>{
      if(hasNeutral&&chroma(p.rgb)>10)return
      const error=colorDistance(cluster.rgb,cluster.lab,labs[i],p.rgb,mono)
      const newColor=used.has(p.code)?0:params.paletteComplexityPenalty*(used.size>=params.colorBudget?3:1)/Math.sqrt(cluster.members.length)
      const backgroundWeight=cluster.members.reduce((s,j)=>s+Math.min(1,(cells[j].importance-1)/2),0)/cluster.members.length
      const budgetFactor=params.backgroundDetailFactor+(1-params.backgroundDetailFactor)*backgroundWeight
      let neighborPenalty=0
      if(!cluster.protected){
        const i=cluster.members[0],x=i%params.width,y=Math.floor(i/params.width)
        const neighbors=[x?i-1:-1,x+1<params.width?i+1:-1,y?i-params.width:-1,y+1<params.height?i+params.width:-1].filter(j=>j>=0&&grid[j])
        neighborPenalty=neighbors.reduce((s,j)=>s+(grid[j].code===p.code?0:params.regionConsistencyPenalty),0)/Math.max(1,neighbors.length)
      }
      const cost=error+(cluster.protected?0:newColor/budgetFactor+neighborPenalty)
      if(cost<bestCost){bestCost=cost;best=p}
    })
    used.set(best.code,(used.get(best.code)||0)+cluster.members.length)
    for(const i of cluster.members)grid[i]=best
  }
  return grid
}
function components(grid,width,height) {
  const seen=new Uint8Array(grid.length),result=[]
  for(let start=0;start<grid.length;start++){
    if(!grid[start]||seen[start])continue
    const code=grid[start].code,queue=[start],border=new Map();seen[start]=1
    for(let q=0;q<queue.length;q++){
      const i=queue[q],x=i%width,y=Math.floor(i/width)
      for(const j of [x?i-1:-1,x+1<width?i+1:-1,y?i-width:-1,y+1<height?i+width:-1]){
        if(j<0||!grid[j])continue
        if(grid[j].code!==code){const b=border.get(grid[j].code)||{color:grid[j],count:0};b.count++;border.set(grid[j].code,b)}
        else if(!seen[j]){seen[j]=1;queue.push(j)}
      }
    }
    result.push({members:queue,border,color:grid[start]})
  }
  return result
}
function mergeSmallRegions(grid,cells,width,height,params) {
  const out=grid.slice(),regions=components(grid,width,height)
  for(const region of regions){
    if(region.members.length>params.smallRegionLimit||region.members.some(i=>cells[i].protected))continue
    const total=[...region.border.values()].reduce((s,v)=>s+v.count,0)
    const dominant=[...region.border.values()].sort((a,b)=>b.count-a.count)[0]
    if(!dominant||dominant.count<total*.65)continue
    const oldLab=oklab(region.color.rgb),newLab=oklab(dominant.color.rgb),d=labDistance(oldLab,newLab)
    // A palette boundary can turn nearly identical source shades into a
    // conspicuous speck. Check the source region as well as bead-to-bead delta.
    // This exception requires surrounding source agreement and bounded loss;
    // it cannot erase a real contrasting mark or a protected feature.
    let flatSource=false
    if(d>params.mergeDistance){
      const adjacent=[]
      for(const i of region.members){
        const x=i%width,y=Math.floor(i/width)
        for(const j of [x?i-1:-1,x+1<width?i+1:-1,y?i-width:-1,y+1<height?i+width:-1]){
          if(j>=0&&grid[j]?.code===dominant.color.code&&cells[j]?.lab?.length===3)adjacent.push(cells[j])
        }
      }
      if(adjacent.length&&region.members.every(i=>cells[i]?.lab?.length===3&&(cells[i].edge||0)<.65)){
        const mean=[0,1,2].map(c=>adjacent.reduce((s,v)=>s+v.lab[c],0)/adjacent.length)
        flatSource=region.members.every(i=>labDistance(cells[i].lab,mean)<2.5&&
          labDistance(cells[i].lab,newLab)<=labDistance(cells[i].lab,oldLab)+2.5)
      }
    }
    if((!flatSource&&d>params.mergeDistance+(region.members.length===1?params.isolatedPixelPenalty||0:0))||
      (chroma(region.color.rgb)<12&&chroma(dominant.color.rgb)>18)||
      (params.neutralLock&&chroma(region.color.rgb)<=10&&chroma(dominant.color.rgb)>10))continue
    for(const i of region.members)out[i]=dominant.color
  }
  return out
}
function optimizeNeighborhood(grid,cells,width,height,params) {
  const out=grid.slice()
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x,c=cells[i];if(!c||c.protected||c.edge>.8)continue
    const counts=new Map()
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy){const v=grid[i+dy*width+dx];if(v){const g=counts.get(v.code)||{color:v,count:0};g.count++;counts.set(v.code,g)}}
    const v=[...counts.values()].sort((a,b)=>b.count-a.count)[0]
    if(v&&v.count>=6&&v.color.code!==grid[i].code&&!(params.neutralLock&&chroma(grid[i].rgb)<=10&&chroma(v.color.rgb)>10)&&labDistance(oklab(v.color.rgb),oklab(grid[i].rgb))<params.mergeDistance){out[i]=v.color}
  }
  return out
}
function optimizePalette(grid,cells,params,analysis) {
  const out=grid.slice(),groups=new Map(),mono=analysis.kind==='monochrome'
  out.forEach((color,i)=>{if(color){let group=groups.get(color.code);if(!group){group={color,members:[]};groups.set(color.code,group)}group.members.push(i)}})
  const sorted=[...groups.values()].sort((a,b)=>a.members.length-b.members.length)
  for(const group of sorted){
    if(!groups.has(group.color.code))continue
    let best=null,bestIncrease=Infinity
    for(const candidate of groups.values()){
      if(candidate===group||candidate.members.length<group.members.length)continue
      if(labDistance(oklab(group.color.rgb),oklab(candidate.color.rgb))>=params.mergeDistance*.7)continue
      if(analysis.kind==='low-saturation'&&chroma(group.color.rgb)<=10&&chroma(candidate.color.rgb)>10)continue
      let increase=0
      const oldLab=oklab(group.color.rgb),newLab=oklab(candidate.color.rgb)
      // A single protected highlight must not lock an entire redundant shade.
      // Reject a merge if it worsens any protected source feature noticeably.
      if(group.members.some(i=>cells[i].protected&&(
        labDistance(cells[i].lab,newLab)>labDistance(cells[i].lab,oldLab)+1 ||
        Math.abs(newLab[0]-oldLab[0])>3 ||
        labDistance(newLab,oldLab)>4
      )))continue
      for(const i of group.members){const c=cells[i];increase+=Math.max(.5,c.importance/2)*(colorDistance(c.rgb,c.lab,newLab,candidate.color.rgb,mono)-colorDistance(c.rgb,c.lab,oldLab,group.color.rgb,mono))}
      if(increase<bestIncrease){bestIncrease=increase;best=candidate}
    }
    const savedCost=params.paletteComplexityPenalty*(groups.size>params.colorBudget?8:3)
    if(best&&bestIncrease<savedCost){
      for(const i of group.members)out[i]=best.color
      best.members.push(...group.members);groups.delete(group.color.code)
    }
  }
  return out
}
function qualityMetrics(grid,cells,width,height) {
  const regions=components(grid,width,height),counts=new Map();let beads=0,edgeTotal=0,edgeKept=0
  grid.forEach((v,i)=>{if(v){beads++;counts.set(v.code,(counts.get(v.code)||0)+1);if(cells[i].protected){edgeTotal++;if(labDistance(cells[i].lab,oklab(v.rgb))<15)edgeKept++}}})
  let entropy=0;for(const count of counts.values()){const p=count/Math.max(1,beads);entropy-=p*Math.log2(p)}
  let expected=0,observed=0,matched=0
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;if(!cells[i]||!grid[i])continue
    for(const j of [x+1<width?i+1:-1,y+1<height?i+width:-1]){
      if(j<0||!cells[j]||!grid[j])continue
      const a=labDistance(cells[i].lab,cells[j].lab)>10,b=labDistance(oklab(grid[i].rgb),oklab(grid[j].rgb))>10
      expected+=a?1:0;observed+=b?1:0;matched+=a&&b?1:0
    }
  }
  return {colorCount:counts.size,isolatedPixelCount:regions.filter(r=>r.members.length===1).length,tinyRegionCount:regions.filter(r=>r.members.length<=3).length,averageRegionSize:beads/Math.max(1,regions.length),edgePreservation:expected+observed?2*matched/(expected+observed):1,protectedDetailColorRetention:edgeTotal?edgeKept/edgeTotal:1,paletteEntropy:entropy,fragmentationScore:regions.length/Math.max(1,beads)}
}
function generate(runtime,image,size,createCanvas,options={}) {
  const width=size.columns,height=size.rows
  const originalAnalysis=native.analyze(image,createCanvas)
  const analyzed=boundedWorkingSource(originalAnalysis,width,height),{source,mask,bounds}=analyzed
  if(!bounds)return {grid:Array.from({length:height},()=>Array.from({length:width},()=>({...EMPTY_CELL}))),diagnostics:{empty:true}}
  // Type and structure evidence must depend on the input, not the requested
  // board resolution. Otherwise the same ornate image changed strategy at 80.
  // Rendering still uses resolution-dependent work/detail budgets.
  const reference=boundedWorkingSource(originalAnalysis,width,height,256)
  const analysis=analyzeImage(reference.source,reference.kind)
  analysis.referenceSize=[reference.source.width,reference.source.height]
  const detected=detectStructure(reference.source,reference.mask,analysis,oklab)
  const structure=projectStructure(detected,reference.source.width,reference.source.height,source.width,source.height,mask)
  const params={...resolutionParameters(width,height,analysis),width,height}
  params.strategy=structure.strategy
  if(structure.strategy==='pet'){
    params.smoothRadius=params.resolutionFactor<=52?3:2
    params.rangeSigma=24
    params.mergeDistance=10
  }else if(structure.strategy==='ornate-illustration'){
    params.smoothRadius=params.resolutionFactor<=52?3:2
    params.backgroundDetailFactor=.45
  }
  params.neutralLock=analysis.kind==='low-saturation'
  const extra={none:0,light:1,medium:2,strong:3,veryStrong:4}[runtime.data.threshold]||0
  params.mergeDistance+=extra
  const maps=buildImportanceMap(source,mask,structure),smoothed=adaptiveSmooth(source,mask,maps,params)
  const flat=['pixel','flat-design','saturated-cartoon','illustration','monochrome'].includes(analysis.kind)
  const method=options.sampling||(analysis.kind==='pixel'?'nearest':flat?'dominant':'median')
  const cells=sampleCells(smoothed,mask,bounds,width,height,maps,method)
  if(method!=='nearest')restoreImportantDetails(cells,originalAnalysis.source,originalAnalysis.mask,originalAnalysis.bounds,width,height,{
    roleAt:(x,y)=>{
      const xx=Math.min(source.width-1,Math.floor(x*source.width/originalAnalysis.source.width))
      const yy=Math.min(source.height-1,Math.floor(y*source.height/originalAnalysis.source.height)),i=yy*source.width+xx
      return {role:structure.roles[i],feature:structure.featureMask[i]}
    }
  })
  protectImportantDetails(cells,width,height)
  const original=runtime.data.threshold;let palette
  try{runtime.data.threshold='none';palette=runtime.getActivePalette()}finally{runtime.data.threshold=original}
  const regions=regionalClusters(cells,params),clusters=simplifyRegionalColors(regions,cells,params,analysis)
  const mapped=mapToMardPalette(clusters,cells,palette,params,analysis)
  const optimized=optimizePalette(mapped,cells,params,analysis)
  const cleaned=mergeSmallRegions(optimizeNeighborhood(optimized,cells,width,height,params),cells,width,height,params)
  // Counterfactual local QA: cleanup cannot erase a protected source feature.
  for(let i=0;i<cleaned.length;i++){
    if(cells[i]?.protected&&mapped[i]&&cleaned[i]&&
      labDistance(cells[i].lab,oklab(cleaned[i].rgb))>labDistance(cells[i].lab,oklab(mapped[i].rgb))+1)cleaned[i]=mapped[i]
  }
  const grid=Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>{const i=y*width+x;return cleaned[i]?runtime.makeMardColor(cleaned[i],cells[i].rgb):({...EMPTY_CELL})}))
  const {roles,featureMask,foreground,...regionAnalysis}=structure
  const diagnostics={analysis:{...analysis,regions:regionAnalysis},parameters:params,sampling:method,before:qualityMetrics(mapped,cells,width,height),after:qualityMetrics(cleaned,cells,width,height),semanticMasksAvailable:false}
  if(options.debug)diagnostics.stages={source,smoothed,maps,cells,mapped,cleaned,structure}
  return {grid,diagnostics}
}
module.exports={generate,oklab,analyzeImage,resolutionParameters,buildImportanceMap,adaptiveSmooth,sampleCells,protectImportantDetails,restoreImportantDetails,regionalClusters,simplifyRegionalColors,mapToMardPalette,mergeSmallRegions,optimizeNeighborhood,optimizePalette,qualityMetrics}
