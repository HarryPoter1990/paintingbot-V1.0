const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const vm = require('node:vm')
const { createJobProgress, summarizeAuditReport } = require('./dashboard_jobs')

function report(job, overrides = {}) {
  return {
    version: 1,
    generatedAt: '2026-10-02T00:00:00.000Z',
    schematicPath: job.schematicPath,
    origin: job.origin,
    checked: 3,
    correct: 1,
    missing: [{ world: { x: 1, y: 2, z: 3 }, expected: 'white_carpet', actual: 'air' }],
    wrong: [{ world: { x: 2, y: 2, z: 3 }, expected: 'blue_carpet', actual: 'red_carpet' }],
    unloaded: [],
    ...overrides
  }
}

test('audit summary counts the report, not completed progress rows', () => {
  const job = { schematicPath: 'schem/sample.schem', origin: { x: 1, y: 2, z: 3 } }
  const summary = summarizeAuditReport(report(job))
  assert.equal(summary.checked, 3)
  assert.equal(summary.correct, 1)
  assert.equal(summary.missing, 1)
  assert.equal(summary.wrong, 1)
  assert.equal(summary.passed, false)
  assert.throws(() => summarizeAuditReport(report(job, { checked: 4 })), /计数不一致/)
  assert.throws(() => summarizeAuditReport(report(job, { missing: null })), /格式不完整/)
})

test('read-only audit lookup uses this job identity and refreshes its summary', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wolfx-audit-'))
  t.after(async () => {
    const absolute = path.resolve(root)
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    assert.ok(absolute.startsWith(tempRoot) && path.basename(absolute).startsWith('wolfx-audit-'))
    await fs.rm(absolute, { recursive: true, force: true })
  })
  const stateDir = path.join(root, 'state')
  const schematicPath = 'schem/sample.schem'
  const job = { schematicPath, origin: { x: 10, y: 20, z: 30 }, rotation: 0 }
  const data = Buffer.from('synthetic schematic identity')
  await fs.mkdir(path.join(root, 'schem'))
  await fs.mkdir(stateDir)
  await fs.writeFile(path.join(root, schematicPath), data)
  const schematicHash = crypto.createHash('sha256').update(data).digest('hex')
  const siteHash = crypto.createHash('sha256').update(JSON.stringify({ schematicHash, origin: job.origin, rotation: 0 })).digest('hex').slice(0, 12)
  const auditFile = path.join(stateDir, `sample-${siteHash}.audit.json`)
  const jobs = createJobProgress({ root, stateDir, json: async () => null })
  assert.equal(await jobs.jobAuditSummary(job), null)
  await fs.writeFile(auditFile, JSON.stringify(report(job)))
  assert.equal((await jobs.jobAuditSummary(job)).missing, 1)
  assert.equal((await jobs.jobAuditDetails(job)).issues.wrong[0].actual, 'red_carpet')
  const passed = report(job, { checked: 3, correct: 3, missing: [], wrong: [] })
  await fs.writeFile(auditFile, JSON.stringify(passed))
  assert.equal((await jobs.jobAuditSummary(job)).passed, true)
  await fs.writeFile(auditFile, JSON.stringify(report(job, { schematicPath: 'schem/other.schem' })))
  await assert.rejects(jobs.jobAuditDetails(job), /不匹配/)
})

test('schematic progress shares one read and parse, then refreshes after the file changes', async () => {
  const root = path.join(os.tmpdir(), 'wolfx-cache-test')
  const stateDir = path.join(root, 'state')
  const job = { schematicPath: 'schem/sample.schem', origin: { x: 10, y: 20, z: 30 }, rotation: 0 }
  const schematicFile = path.join(root, job.schematicPath)
  let data = Buffer.from([4, 1])
  let version = 1
  let reads = 0
  let parses = 0
  const fileSystem = {
    async stat(file) {
      assert.equal(file, schematicFile)
      return { mtimeMs: version, ctimeMs: version, size: data.length }
    },
    async readFile(file) {
      assert.equal(file, schematicFile)
      reads++
      return data
    }
  }
  const statePaths = []
  const jobs = createJobProgress({
    root,
    stateDir,
    fileSystem,
    parseSchematic: async bytes => {
      parses++
      return { length: bytes[0] }
    },
    json: async file => {
      statePaths.push(file)
      return { completedRows: [0, 1] }
    }
  })

  const first = await Promise.all(['single', 'bootstrap', 'left', 'right'].map(worker => jobs.jobProgress(job, worker)))
  assert.deepEqual(first, Array(4).fill({ done: 2, totalRows: 4, percent: 50 }))
  assert.equal(reads, 1)
  assert.equal(parses, 1)
  const schematicHash = crypto.createHash('sha256').update(data).digest('hex')
  const siteHash = crypto.createHash('sha256').update(JSON.stringify({ schematicHash, origin: job.origin, rotation: 0 })).digest('hex').slice(0, 12)
  assert.deepEqual(statePaths.sort(), ['single', 'bootstrap', 'left', 'right'].map(worker =>
    path.join(stateDir, `sample-${siteHash}${worker === 'single' ? '' : `.${worker}`}.job-state.json`)).sort())

  data = Buffer.from([8, 1])
  version++
  assert.deepEqual(await jobs.jobProgress(job), { done: 2, totalRows: 8, percent: 25 })
  assert.equal(reads, 2)
  assert.equal(parses, 2)
  assert.notEqual(statePaths.at(-1), path.join(stateDir, `sample-${siteHash}.job-state.json`))
})

test('dashboard inline script remains valid JavaScript', async () => {
  const html = await fs.readFile(path.join(__dirname, 'dashboard.html'), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new vm.Script(script))
})
