const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const sharp = require('sharp')
const { createStudioJobs } = require('./studio_jobs')
const { createProjections } = require('./studio_generator')

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wolfx-studio-jobs-test-'))
  t.after(async () => {
    const absolute = path.resolve(root)
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
    assert.ok(path.basename(absolute).startsWith('wolfx-studio-jobs-test-'))
    await fs.rm(absolute, { recursive: true, force: true })
  })
  return root
}

test('worker preview completes without writing output and frees the slot', async t => {
  const root = await temporaryRoot(t)
  const image = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#515685' } }).png().toBuffer()
  const jobs = createStudioJobs(root)
  const work = jobs.run('preview', image, { targetWidth: 128, targetHeight: 128,
    fit: 'fill', interpolation: 'smooth', mode: 'lab00' })
  assert.equal(jobs.status().running, true)
  assert.equal(jobs.status().kind, 'preview')
  assert.throws(() => jobs.run('preview', image, {}), /已有图片转换/)
  const result = await work
  assert.equal(result.columns, 1)
  assert.match(result.preview, /^data:image\/png;base64,/)
  assert.deepEqual(await fs.readdir(root), [])
  assert.equal(jobs.status().running, false)
})

test('cancelled generation leaves no projection or schematic', async t => {
  const root = await temporaryRoot(t)
  const image = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#515685' } }).png().toBuffer()
  const jobs = createStudioJobs(root)
  const work = jobs.run('generate', image, { name: 'cancelled', targetWidth: 512, targetHeight: 512,
    fit: 'fill', interpolation: 'smooth', mode: 'lab00' })
  assert.equal(jobs.cancel('wrong-id'), false)
  assert.equal(jobs.cancel(work.jobId), true)
  assert.equal(jobs.status().cancelling, true)
  await assert.rejects(work, /已取消/)
  assert.equal(jobs.status().running, false)
  assert.deepEqual(await fs.readdir(root), [])
})

test('cancelling during packaging removes staged output', async t => {
  const root = await temporaryRoot(t)
  const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#515685' } }).png().toBuffer()
  const jobs = createStudioJobs(root)
  const work = jobs.run('generate', image, { name: 'package-cancel', targetWidth: 256, targetHeight: 256,
    fit: 'fill', interpolation: 'smooth', mode: 'rgb+' })
  let reachedPackage = false
  for (let attempt = 0; attempt < 1000; attempt++) {
    const progress = jobs.status()
    if (progress.phase === 'package' && progress.done >= 1) { reachedPackage = true; break }
    if (!progress.running) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  jobs.cancel(work.jobId)
  await assert.rejects(work, /已取消/)
  assert.equal(reachedPackage, true, 'package checkpoint was not observable')
  assert.deepEqual(await fs.readdir(root, { recursive: true }), [])
})

test('existing output is rejected before expensive colour conversion', async t => {
  const root = await temporaryRoot(t)
  await fs.mkdir(path.join(root, '投影文件'))
  await fs.writeFile(path.join(root, '投影文件', 'taken.litematic'), 'existing')
  const image = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#515685' } }).png().toBuffer()
  let progressCalls = 0
  await assert.rejects(createProjections({ root, image, options: {
    name: 'taken', targetWidth: 128, targetHeight: 128,
    fit: 'fill', interpolation: 'smooth', mode: 'rgb+'
  }, onProgress: () => progressCalls++ }), /同名文件已存在/)
  assert.equal(progressCalls, 0)
  assert.equal(await fs.readFile(path.join(root, '投影文件', 'taken.litematic'), 'utf8'), 'existing')
})
