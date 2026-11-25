// Builds every icon file from the four sources in resources/src:
//   icon-light.png  -> resources/icon.png (1024), resources/icon.ico (16…256)
//   icon-dark.png   -> resources/icon-dark.png (1024)
//   glyph-black.png -> resources/trayTemplate.png (16) + trayTemplate@2x.png (32), glyph-black.png (512)
//   glyph-white.png -> resources/glyph-white.png (512)
// Sources are trimmed to their visible bounds, cleaned of near-transparent
// noise, padded to a square and resized. Runs under Electron for nativeImage:
//   pnpm exec electron scripts/build-icons.cjs
const { app, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const res = join(__dirname, '..', 'resources')
const src = join(res, 'src')

app.whenReady().then(() => {
  const light = prepare('icon-light.png', { fill: 0.86 })
  save('icon.png', light.resize({ width: 1024, height: 1024, quality: 'best' }))
  writeFileSync(join(res, 'icon.ico'), ico(light, [16, 24, 32, 48, 64, 128, 256]))

  const dark = prepare('icon-dark.png', { fill: 0.86 })
  save('icon-dark.png', dark.resize({ width: 1024, height: 1024, quality: 'best' }))

  const black = prepare('glyph-black.png', { fill: 0.8, force: 'black' })
  save('glyph-black.png', black.resize({ width: 512, height: 512, quality: 'best' }))
  save('trayTemplate.png', black.resize({ width: 16, height: 16, quality: 'best' }))
  save('trayTemplate@2x.png', black.resize({ width: 32, height: 32, quality: 'best' }))

  const white = prepare('glyph-white.png', { fill: 0.8, force: 'white' })
  save('glyph-white.png', white.resize({ width: 512, height: 512, quality: 'best' }))

  console.log('icons written to resources/')
  app.quit()
})

/**
 * Loads a source, drops faint alpha noise, optionally forces every pixel to
 * one colour (keeping alpha), trims to the visible bounds and pads to a
 * square in which the artwork takes `fill` of the side.
 */
function prepare(name, { fill, force }) {
  const img = nativeImage.createFromBuffer(readFileSync(join(src, name)))
  const { width, height } = img.getSize()
  const px = Buffer.from(img.toBitmap()) // BGRA, premultiplied
  const cut = force ? 24 : 12
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const a = px[i + 3]
      if (a < cut) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0
        continue
      }
      if (force === 'black') px[i] = px[i + 1] = px[i + 2] = 0
      if (force === 'white') px[i] = px[i + 1] = px[i + 2] = a
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const side = Math.round(Math.max(bw, bh) / fill)
  const out = Buffer.alloc(side * side * 4)
  const ox = Math.round((side - bw) / 2)
  const oy = Math.round((side - bh) / 2)
  for (let y = 0; y < bh; y++) {
    const from = ((minY + y) * width + minX) * 4
    px.copy(out, ((oy + y) * side + ox) * 4, from, from + bw * 4)
  }
  return nativeImage.createFromBitmap(out, { width: side, height: side })
}

function save(name, image) {
  writeFileSync(join(res, name), image.toPNG())
}

/**
 * An ICO with one entry per size. Sizes up to 64 go in as plain 32-bit DIBs,
 * which every part of the Windows shell renders; PNG-compressed entries are
 * only dependable at 128 and 256.
 */
function ico(image, sizes) {
  const blobs = sizes.map((s) => {
    const scaled = image.resize({ width: s, height: s, quality: 'best' })
    return s >= 128 ? scaled.toPNG() : dib(scaled)
  })
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  const entries = []
  let offset = 6 + 16 * sizes.length
  sizes.forEach((s, i) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(s === 256 ? 0 : s, 0)
    e.writeUInt8(s === 256 ? 0 : s, 1)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(blobs[i].length, 8)
    e.writeUInt32LE(offset, 12)
    offset += blobs[i].length
    entries.push(e)
  })
  return Buffer.concat([header, ...entries, ...blobs])
}

/** A BITMAPINFOHEADER + bottom-up BGRA rows (straight alpha) + empty AND mask. */
function dib(image) {
  const { width, height } = image.getSize()
  const px = image.toBitmap() // BGRA, premultiplied
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(width, 4)
  head.writeInt32LE(height * 2, 8)
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  head.writeUInt32LE(0, 16)
  head.writeUInt32LE(width * height * 4, 20)
  const rows = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4
      const d = (y * width + x) * 4
      const a = px[s + 3]
      // Un-premultiply so the shell's own blending does not darken edges.
      rows[d] = a ? Math.min(255, Math.round((px[s] * 255) / a)) : 0
      rows[d + 1] = a ? Math.min(255, Math.round((px[s + 1] * 255) / a)) : 0
      rows[d + 2] = a ? Math.min(255, Math.round((px[s + 2] * 255) / a)) : 0
      rows[d + 3] = a
    }
  }
  const maskRow = Math.ceil(width / 32) * 4
  const mask = Buffer.alloc(maskRow * height)
  return Buffer.concat([head, rows, mask])
}
