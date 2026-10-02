const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { writeAuditReport } = require('./audit_report_writer')

test('audit report is created and replaces an existing complete report', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wolfx-audit-write-'))
  t.after(async () => {
    const absolute = path.resolve(folder)
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(absolute).startsWith('wolfx-audit-write-'))
    await fs.rm(absolute, { recursive: true, force: true })
  })
  const destination = path.join(folder, 'map.audit.json')
  const oldReport = { checked: 1, correct: 0 }
  const newReport = { checked: 2, correct: 2 }
  await writeAuditReport(destination, oldReport)
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), oldReport)
  await writeAuditReport(destination, newReport)
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), newReport)
  assert.deepEqual(await fs.readdir(folder), ['map.audit.json'])

  let releaseWrite
  let signalPartialWrite
  const paused = new Promise(resolve => { releaseWrite = resolve })
  const partialWritten = new Promise(resolve => { signalPartialWrite = resolve })
  const slowFileSystem = {
    ...fs,
    async writeFile(file, contents, options) {
      await fs.writeFile(file, contents.slice(0, 8), options)
      signalPartialWrite()
      await paused
      await fs.appendFile(file, contents.slice(8))
    }
  }
  const laterReport = { checked: 4, correct: 4 }
  const writing = writeAuditReport(destination, laterReport, slowFileSystem)
  await partialWritten
  try {
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), newReport)
  } finally { releaseWrite() }
  await writing
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), laterReport)

  const failingRename = { ...fs, rename: async () => { throw new Error('simulated rename failure') } }
  await assert.rejects(writeAuditReport(destination, { checked: 99 }, failingRename), /simulated rename failure/)
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), laterReport)
  assert.deepEqual(await fs.readdir(folder), ['map.audit.json'])

  const circular = {}; circular.self = circular
  await assert.rejects(writeAuditReport(destination, circular), /circular/i)
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), laterReport)
  assert.deepEqual(await fs.readdir(folder), ['map.audit.json'])
})
