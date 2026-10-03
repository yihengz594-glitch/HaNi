// Copy existing website artwork, not user uploads or generated pattern data.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const web = '/Users/apple/Documents/ChatGPT/新想法'
const requireWeb = createRequire(path.join(web, 'package.json'))
const sharp = requireWeb(requireWeb.resolve('sharp', { paths: [path.dirname(requireWeb.resolve('next/package.json'))] }))
const destination = path.resolve(__dirname, '../assets/website-covers')
async function main() {
  fs.mkdirSync(destination, { recursive: true })
  for (const id of [2, 3, 5, 6, 7, 8, 9, 10]) {
    const source = path.join(web, `public/mini/hani-20261001/thumbs/attachment-${id}.webp`)
    await sharp(source).resize({ width: id < 5 ? 1000 : 640, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(destination, `cover-${id}.jpg`))
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
