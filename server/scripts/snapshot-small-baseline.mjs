import {readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {transparentCartoon} from '../test/fixtures/small-inputs.mjs'
const [baselineRoot]=process.argv.slice(2)
if(!baselineRoot)throw new Error('Pass the pre-change backup directory')
const {generatePattern}=await import(pathToFileURL(path.join(baselineRoot,'server/src/pattern-core.js')))
const root=path.resolve(fileURLToPath(new URL('../..',import.meta.url)))
const sources={pink:await readFile(path.join(root,'server/test/fixtures/pink-character.jpg')),cat:await readFile(path.join(root,'assets/pinbead-cat/cat-closeup.jpg')),photo:await readFile(path.join(root,'server/test/fixtures/photo-astronaut.png')),transparent:transparentCartoon()}
const entries=[]
for(const [sample,input]of Object.entries(sources)){
  for(const [gridWidth,gridHeight]of [[53,53],[64,64],[80,80],[38,53],[53,38]]){
    const settings={sizeMode:'board',gridWidth,gridHeight,paletteSpec:'221',threshold:'none'}
    const result=await generatePattern(input,settings)
    entries.push({sample,settings,hash:createHash('sha256').update(JSON.stringify(result)).digest('hex')})
  }
  for(const settings of [{sizeMode:'image',gridWidth:64,gridHeight:64,paletteSpec:'221',threshold:'none'},{sizeMode:'board',gridWidth:64,gridHeight:80,paletteSpec:'72',threshold:'medium'}]){
    const result=await generatePattern(input,settings)
    entries.push({sample,settings,hash:createHash('sha256').update(JSON.stringify(result)).digest('hex')})
  }
}
await writeFile(path.join(root,'server/test/fixtures/large-pattern-baseline.json'),JSON.stringify({description:'Pre-change full result hashes: codes, source RGB, dimensions, total count. Derived from saved original generator.',entries},null,2))
console.log(`Saved ${entries.length} legacy result baselines`)
