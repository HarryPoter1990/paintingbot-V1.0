// Read-only source image validation. Output projections live only in an OS temp directory.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const sharp = require('sharp')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
const { COLOURS, createProjections } = require('./studio_generator')

const imagePath = process.argv[2]
if (!imagePath) {
  console.error('用法：node studio_image_sandbox.js "原图绝对路径"')
  process.exitCode = 2
} else {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}

async function main() {
  const absoluteImage = path.resolve(imagePath)
  const image = await fs.readFile(absoluteImage)
  const beforeHash = crypto.createHash('sha256').update(image).digest('hex')
  const metadata = await sharp(image).metadata()
  assert.equal(metadata.width, 128, '此脚本验证一张 128×128 原图')
  assert.equal(metadata.height, 128, '此脚本验证一张 128×128 原图')
  const tempParent = path.resolve(os.tmpdir())
  const root = await fs.mkdtemp(path.join(tempParent, 'wolfx-studio-image-check-'))
  const expectedNames = new Set(COLOURS.map(item => item[0]))
  const nameByRgb = new Map(COLOURS.map(([name, rgb]) => [rgb.join(','), name]))
  const reports = []
  const resizeReports = []
  try {
    for (const mode of ['rgb+', 'lab94', 'lab00', 'xyz']) {
      const result = await createProjections({ root, image, options: {
        name: 'sandbox-' + mode.replace('+', '-plus'), targetWidth: 128, targetHeight: 128,
        fit: 'fill', interpolation: 'smooth', mode
      } })
      assert.equal(result.files.length, 1)
      assert.equal(result.columns, 1)
      assert.equal(result.rows, 1)
      const item = result.files[0]
      const schematic = await Schematic.read(await fs.readFile(path.join(root, 'schem', item.schematic)))
      assert.deepEqual(schematic.size, new Vec3(130, 1, 130))
      const preview = await sharp(Buffer.from(result.preview.slice('data:image/png;base64,'.length), 'base64'))
        .raw().toBuffer({ resolveWithObject: true })
      assert.equal(preview.info.width, 128)
      assert.equal(preview.info.height, 128)
      assert.equal(preview.info.channels, 3)
      const countByName = {}
      let previewMismatches = 0
      let firstMismatch = null
      for (let x = 0; x < 130; x++) {
        const top = schematic.getBlock(new Vec3(x, 0, 0)).name
        const bottom = schematic.getBlock(new Vec3(x, 0, 129)).name
        assert.equal(top, x >= 1 && x <= 128 ? 'smooth_stone' : 'air')
        assert.equal(bottom, 'air')
      }
      for (let z = 1; z <= 128; z++) {
        assert.equal(schematic.getBlock(new Vec3(0, 0, z)).name, 'air')
        assert.equal(schematic.getBlock(new Vec3(129, 0, z)).name, 'air')
        for (let x = 1; x <= 128; x++) {
          const name = schematic.getBlock(new Vec3(x, 0, z)).name
          assert.ok(expectedNames.has(name), `非16色地毯: ${name} @ ${x},${z}`)
          countByName[name] = (countByName[name] || 0) + 1
          const offset = ((z - 1) * 128 + x - 1) * 3
          const previewName = nameByRgb.get([...preview.data.subarray(offset, offset + 3)].join(','))
          if (previewName !== name) {
            previewMismatches++
            firstMismatch ||= { x, z, projection: name, preview: previewName || '未知颜色' }
          }
        }
      }
      assert.equal(Object.values(countByName).reduce((a, b) => a + b, 0), 128 * 128)
      assert.equal(previewMismatches, 0, `预览与投影不一致: ${JSON.stringify(firstMismatch)}`)
      const materials = JSON.parse(await fs.readFile(path.join(root, 'schem', item.schematic.replace(/\.schem$/, '.materials.json')), 'utf8'))
      assert.equal(materials.materials.smooth_stone, 128)
      for (const [name, count] of Object.entries(countByName)) assert.equal(materials.materials[name], count)
      reports.push({ mode, carpets: countByName, previewMismatches, carpetTotal: 16384, smoothStone: 128 })
    }
    for (const fit of ['fill', 'inside', 'outside']) for (const interpolation of ['fast', 'smooth']) {
      const result = await createProjections({ root, image, options: {
        name: `resize-${fit}-${interpolation}`, targetWidth: 129, targetHeight: 100,
        fit, interpolation, mode: 'rgb+'
      } })
      const expected = fit === 'fill' ? [129, 100, 2, 1] :
        fit === 'inside' ? [100, 100, 1, 1] : [129, 129, 2, 2]
      assert.deepEqual([result.imageWidth, result.imageHeight, result.columns, result.rows], expected)
      assert.equal(result.files.length, expected[2] * expected[3])
      for (const file of result.files) {
        const schem = await Schematic.read(await fs.readFile(path.join(root, 'schem', file.schematic)))
        assert.deepEqual(schem.size, new Vec3(130, 1, 130))
      }
      resizeReports.push({ fit, interpolation, actualPixels: expected.slice(0, 2), tiles: result.files.length })
    }
    const afterHash = crypto.createHash('sha256').update(await fs.readFile(absoluteImage)).digest('hex')
    assert.equal(afterHash, beforeHash, '原图内容被改动')
    console.log(JSON.stringify({ source: absoluteImage, sourceSha256: beforeHash,
      sourceUnchanged: true, modes: reports, resizeChecks: resizeReports,
      note: '生成文件只在系统临时目录，脚本结束会删除；不与 SlopeCraft GUI 输出逐像素比较' }, null, 2))
  } finally {
    const absoluteRoot = path.resolve(root)
    assert.equal(path.dirname(absoluteRoot), tempParent)
    assert.ok(path.basename(absoluteRoot).startsWith('wolfx-studio-image-check-'))
    await fs.rm(absoluteRoot, { recursive: true, force: true })
  }
}
