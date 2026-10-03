// Traditional, evidence-based region hypotheses. No semantic model is loaded.
// Confidence is heuristic confidence, not a calibrated recognition probability.
const TYPES = ['human', 'pet', 'anime', 'chibi', 'illustration', 'monochrome-comic',
  'logo', 'flat-design', 'landscape', 'ornate-illustration', 'low-saturation', 'high-saturation']

function connectedRegions(binary, width, height) {
  const seen = new Uint8Array(binary.length), regions = []
  for (let start = 0; start < binary.length; start++) {
    if (!binary[start] || seen[start]) continue
    const queue = [start]; seen[start] = 1
    let left = width, right = 0, top = height, bottom = 0
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], x = i % width, y = Math.floor(i / width)
      left = Math.min(left, x); right = Math.max(right, x)
      top = Math.min(top, y); bottom = Math.max(bottom, y)
      for (const j of [x ? i-1 : -1, x+1 < width ? i+1 : -1,
        y ? i-width : -1, y+1 < height ? i+width : -1]) {
        if (j >= 0 && binary[j] && !seen[j]) { seen[j] = 1; queue.push(j) }
      }
    }
    regions.push({ members: queue, left, right, top, bottom,
      width: right-left+1, height: bottom-top+1 })
  }
  return regions
}

function detectStructure(source, mask, visual, toLab) {
  const { width: w, height: h, pixels: p } = source, n = w*h
  const skin = new Uint8Array(n), light = new Uint8Array(n), iris = new Uint8Array(n)
  const luminance = new Float32Array(n), foreground = new Uint8Array(n)
  const roles = new Uint8Array(n), featureMask = new Uint8Array(n)
  let foregroundCount = 0
  for (let i=0; i<n; i++) {
    if (!mask.isForeground(i)) continue
    foreground[i] = 1; foregroundCount++
    const rgb = [p[i*4], p[i*4+1], p[i*4+2]], lab = toLab(rgb)
    luminance[i] = lab[0]
    const [r,g,b] = rgb, c = Math.hypot(lab[1], lab[2])
    skin[i] = lab[0]>66 && r>155 && r-g>6 && r-g<65 &&
      g-b>-8 && g-b<55 && b>r*.55 && lab[1]>1.5 && lab[2]>-.5 ? 1 : 0
    light[i] = lab[0]>86 && c<4 ? 1 : 0
    // Warm/cool iris candidates must later prove a compact dark core. Fur and
    // jewelry do not become eyes merely because their hue is orange or green.
    iris[i] = lab[0]>40 && lab[0]<85 &&
      ((c>3.5 && g>r*.98 && g>b*1.05) ||
        (c>6 && r>g*1.22 && g>b*1.15)) ? 1 : 0
  }
  const expanded = (r, fx, fy) => ({
    left: Math.max(0,Math.floor(r.left-r.width*fx)),
    right: Math.min(w-1,Math.ceil(r.right+r.width*fx)),
    top: Math.max(0,Math.floor(r.top-r.height*fy)),
    bottom: Math.min(h-1,Math.ceil(r.bottom+r.height*fy))
  })
  const darkEvidence = (box, cutoff) => {
    let dark=0, bright=0
    for(let y=box.top; y<=box.bottom; y++)for(let x=box.left; x<=box.right; x++) {
      const i=y*w+x
      if (!foreground[i]) continue
      if(luminance[i]<cutoff)dark++
      if(luminance[i]>cutoff+20)bright++
    }
    return { dark, bright }
  }
  const faces = []
  for(const r of connectedRegions(skin,w,h)) {
    if(r.members.length<n*.002 || r.width<w*.045 || r.width>w*.48 ||
      r.height<h*.04 || r.height>h*.48 || r.width/r.height<.3 || r.width/r.height>3)continue
    const box=expanded(r,.30,.18), evidence=darkEvidence(box,60)
    if(evidence.dark<r.members.length*.025 || evidence.bright<r.members.length*.2)continue
    faces.push({ ...box, kind:'skin-face-candidate', confidence:.65, area:r.members.length })
  }
  // White faces in line art: closed light regions, not the sky or page border.
  if(visual.kind==='monochrome')for(const r of connectedRegions(light,w,h)) {
    if(r.left===0 || r.top===0 || r.right===w-1 || r.bottom===h-1 ||
      r.members.length<n*.003 || r.width<w*.05 || r.width>w*.35 ||
      r.height<h*.05 || r.height>h*.4 || r.width/r.height<.35 || r.width/r.height>2.2)continue
    const box=expanded(r,.20,.15), evidence=darkEvidence(box,45)
    if(evidence.dark<r.members.length*.08)continue
    faces.push({ ...box,kind:'line-art-face-candidate',confidence:.55,area:r.members.length })
  }
  faces.sort((a,b)=>b.area-a.area)
  const selectedFaces=[]
  for(const face of faces) {
    const cx=(face.left+face.right)/2,cy=(face.top+face.bottom)/2
    if(selectedFaces.some(v=>cx>=v.left&&cx<=v.right&&cy>=v.top&&cy<=v.bottom))continue
    selectedFaces.push(face)
    if(selectedFaces.length===4)break
  }
  const eyes=[]
  for(const r of connectedRegions(iris,w,h)) {
    if(r.members.length<Math.max(6,n*.00025) || r.width<w*.025 || r.width>w*.15 ||
      r.height<h*.012 || r.height>h*.16 || r.width/r.height<.65 || r.width/r.height>1.8)continue
    const evidence=darkEvidence(r,35)
    if(evidence.dark<r.width*r.height*.06)continue
    const core={left:Math.round(r.left+r.width*.3),right:Math.round(r.right-r.width*.3),
      top:Math.round(r.top+r.height*.3),bottom:Math.round(r.bottom-r.height*.3)}
    const coreArea=Math.max(1,(core.right-core.left+1)*(core.bottom-core.top+1))
    if(darkEvidence(core,45).dark/coreArea<.12)continue
    eyes.push({...r,confidence:.6,cx:(r.left+r.right)/2,cy:(r.top+r.bottom)/2})
  }
  const eyePairs=[]
  const dominantFace=selectedFaces.find(v=>v.kind==='skin-face-candidate'&&v.area>n*.02)
  for(let a=0;a<eyes.length;a++)for(let b=a+1;b<eyes.length;b++) {
    const x=eyes[a],y=eyes[b],dx=Math.abs(x.cx-y.cx),dy=Math.abs(x.cy-y.cy)
    const ratio=x.members.length/y.members.length
    if(dx<w*.12 || dx>w*.55 || dy>dx*.65 || ratio<.4 || ratio>2.5 ||
      x.width/y.width<.55 || x.width/y.width>1.8)continue
    if(dominantFace&&![x,y].every(v=>v.cx>=dominantFace.left&&v.cx<=dominantFace.right&&
      v.cy>=dominantFace.top&&v.cy<=dominantFace.bottom))continue
    eyePairs.push({ eyes:[x,y], confidence:.7, separation:dx/w, areaScore:Math.min(x.members.length,y.members.length) })
  }
  eyePairs.sort((a,b)=>b.areaScore-a.areaScore)
  const pair=eyePairs[0]
  const faceFeatures=[]
  const markFaceDarkFeatures=(face)=>{
    const candidate=new Uint8Array(n)
    for(let y=face.top;y<=face.bottom;y++)for(let x=face.left;x<=face.right;x++){
      const i=y*w+x
      if(!foreground[i]||luminance[i]>=62)continue
      let nearby=0,bright=0,dark=0
      for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
        if(!dx&&!dy)continue
        const xx=x+dx,yy=y+dy
        if(xx<face.left||xx>face.right||yy<face.top||yy>face.bottom)continue
        const j=yy*w+xx;if(!foreground[j])continue
        nearby++
        if(luminance[j]>78)bright++
        if(luminance[j]<62)dark++
      }
      // Hair boundaries are usually dark on one side only. A compact feature
      // has light evidence around it on multiple sides and does not fill the
      // local neighborhood.
      if(nearby>=8&&bright>=Math.max(4,nearby*.30)&&dark<=nearby*.68)candidate[i]=1
    }
    const faceWidth=face.right-face.left+1,faceHeight=face.bottom-face.top+1
    const regions=connectedRegions(candidate,w,h).filter(r=>
      r.members.length>=2&&r.members.length<=Math.max(80,faceWidth*faceHeight*.12)&&
      r.width<=faceWidth*.30&&r.height<=faceHeight*.32&&
      r.left>face.left+faceWidth*.05&&r.right<face.right-faceWidth*.05&&
      r.top>face.top+faceHeight*.16&&r.bottom<face.bottom-faceHeight*.12)
    const pairs=[]
    for(let a=0;a<regions.length;a++)for(let b=a+1;b<regions.length;b++){
      const x=regions[a],y=regions[b],ax=(x.left+x.right)/2,ay=(x.top+x.bottom)/2,
        bx=(y.left+y.right)/2,by=(y.top+y.bottom)/2,dx=Math.abs(ax-bx),dy=Math.abs(ay-by),
        ratio=x.members.length/y.members.length
      if(dx<faceWidth*.18||dx>faceWidth*.75||dy>faceHeight*.22||ratio<.25||ratio>4.5||
        x.width/y.width<.45||x.width/y.width>2.2)continue
      const score=Math.abs(dy)/(faceHeight*.22)+
        Math.abs(dx-faceWidth*.36)/(faceWidth*.36)+
        Math.abs((ay+by)/2-(face.top+faceHeight*.43))/(faceHeight*.43)
      pairs.push({x,y,score})
    }
    pairs.sort((a,b)=>a.score-b.score)
    const selected=pairs.length?[pairs[0].x,pairs[0].y]:regions.slice().sort((a,b)=>{
      const ac=Math.abs((a.top+a.bottom)/2-(face.top+faceHeight*.43)),
        bc=Math.abs((b.top+b.bottom)/2-(face.top+faceHeight*.43))
      return ac-bc||b.members.length-a.members.length
    }).slice(0,2)
    for(const r of selected){
      const box=expanded(r,.20,.26)
      faceFeatures.push({...box,kind:pairs.length?'dark-face-pair':'dark-face-feature',confidence:pairs.length?.64:.52,area:r.members.length})
      paintBox(box,5)
      for(const i of r.members)featureMask[i]=1
      for(let y=Math.max(0,box.top);y<=Math.min(h-1,box.bottom);y++)
        for(let x=Math.max(0,box.left);x<=Math.min(w-1,box.right);x++)featureMask[y*w+x]=1
    }
  }
  const paintBox = (box,role) => {
    for(let y=box.top;y<=box.bottom;y++)for(let x=box.left;x<=box.right;x++) {
      const i=y*w+x;if(foreground[i])roles[i]=Math.max(roles[i],role)
    }
  }
  if(!pair)for(const face of selectedFaces)if(face.kind==='skin-face-candidate')markFaceDarkFeatures(face)
  if(!pair || pair.separation<=.18 || dominantFace)for(const face of selectedFaces) {
    paintBox(face,4)
    if(face.kind!=='skin-face-candidate')continue
    // Local dark-on-light evidence inside a face hypothesis, not a fabricated
    // eye location. In particular, a one-sided hair boundary does not qualify.
    const radius=Math.max(2,Math.round((face.right-face.left)*.10))
    for(let y=face.top;y<=face.bottom;y++)for(let x=face.left;x<=face.right;x++) {
      const i=y*w+x
      if(!foreground[i]||luminance[i]>=60)continue
      const bright=(xx,yy)=>xx>=0&&yy>=0&&xx<w&&yy<h&&
        foreground[yy*w+xx]&&luminance[yy*w+xx]>luminance[i]+18
      if(!((bright(x-radius,y)&&bright(x+radius,y))||
        (bright(x,y-radius)&&bright(x,y+radius))))continue
      for(let yy=Math.max(0,y-2);yy<=Math.min(h-1,y+2);yy++)
        for(let xx=Math.max(0,x-2);xx<=Math.min(w-1,x+2);xx++)featureMask[yy*w+xx]=1
    }
  }
  if(pair)for(const eye of pair.eyes) {
    const box=expanded(eye,.25,.25);paintBox(box,5)
    for(let y=box.top;y<=box.bottom;y++)for(let x=box.left;x<=box.right;x++)featureMask[y*w+x]=1
  }
  // A role is only a protection / simplification budget. Never fill or redraw it.
  for(let i=0;i<n;i++)if(foreground[i]&&!roles[i])roles[i]=skin[i]?2:1
  const scores=Object.fromEntries(TYPES.map(t=>[t,0]))
  scores['monochrome-comic']=visual.kind==='monochrome'?.95:0
  scores['low-saturation']=visual.kind==='low-saturation'?.95:0
  scores['high-saturation']=visual.meanSaturation>.4?.85:0
  scores['flat-design']=visual.flatFraction>.9?.75:0
  scores.logo=visual.flatFraction>.97&&visual.complexity<.08?.55:0
  scores.illustration=['illustration','saturated-cartoon','pixel'].includes(visual.kind)?.7:.35
  scores.anime=selectedFaces.length&&visual.flatFraction>.55?.6:0
  scores.chibi=selectedFaces.some(v=>(v.right-v.left)/w>.22)&&visual.flatFraction>.55?.55:0
  scores.human=dominantFace?.65:selectedFaces.some(v=>v.kind==='skin-face-candidate')?.25:0
  scores.pet=pair&&pair.separation>.18&&!dominantFace?.7:0
  scores['ornate-illustration']=selectedFaces.length&&visual.complexity>.25&&visual.meanGradient>18?.6:0
  scores.landscape=!selectedFaces.length&&!pair&&visual.complexity>.3?.3:0
  const ranked=Object.entries(scores).sort((a,b)=>b[1]-a[1])
  const strategy=scores.pet>=.7?'pet':scores['ornate-illustration']>=.6?'ornate-illustration':
    scores['monochrome-comic']>.9?'monochrome-comic':selectedFaces.length?'face-illustration':visual.kind
  return { roles,featureMask,foreground,faces:selectedFaces,faceFeatures,
    eyePairs:pair?[{confidence:pair.confidence,separation:pair.separation,
      eyes:pair.eyes.map(({left,right,top,bottom})=>({left,right,top,bottom}))}]:[],
    types:scores,primaryType:ranked[0][1]>=.55?ranked[0][0]:'unknown',strategy,
    confidence:ranked[0][1],method:'traditional-region-hypotheses',
    subjectMethod:mask.removed?'border-connected-background':foregroundCount<n?'alpha':'unsegmented-opaque' }
}
function projectStructure(structure, fromWidth, fromHeight, width, height, mask) {
  if(fromWidth===width&&fromHeight===height)return structure
  const roles=new Uint8Array(width*height),featureMask=new Uint8Array(width*height),foreground=new Uint8Array(width*height)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x
    if(!mask.isForeground(i))continue
    const xx=Math.min(fromWidth-1,Math.floor((x+.5)*fromWidth/width))
    const yy=Math.min(fromHeight-1,Math.floor((y+.5)*fromHeight/height)),j=yy*fromWidth+xx
    foreground[i]=1;roles[i]=structure.roles[j]||1;featureMask[i]=structure.featureMask[j]
  }
  const box=v=>({...v,
    left:Math.max(0,Math.floor(v.left*width/fromWidth)),
    right:Math.min(width-1,Math.ceil((v.right+1)*width/fromWidth)-1),
    top:Math.max(0,Math.floor(v.top*height/fromHeight)),
    bottom:Math.min(height-1,Math.ceil((v.bottom+1)*height/fromHeight)-1)})
  return {...structure,roles,featureMask,foreground,faces:structure.faces.map(box),
    faceFeatures:(structure.faceFeatures||[]).map(box),
    eyePairs:structure.eyePairs.map(pair=>({...pair,eyes:pair.eyes.map(box)}))}
}
module.exports={detectStructure,projectStructure,connectedRegions,TYPES}
