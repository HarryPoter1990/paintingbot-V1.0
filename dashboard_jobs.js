const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { Schematic } = require('prismarine-schematic')

function summarizeAuditReport(report) {
  const counts = ['checked', 'correct'].map(name => report?.[name])
  if (counts.some(count => !Number.isInteger(count) || count < 0) ||
    !Array.isArray(report?.missing) || !Array.isArray(report?.wrong) || !Array.isArray(report?.unloaded)) {
    throw new Error('复检报告格式不完整')
  }
  const missing = report.missing.length
  const wrong = report.wrong.length
  const unloaded = report.unloaded.length
  if (report.correct + missing + wrong + unloaded !== report.checked) {
    throw new Error('复检报告计数不一致')
  }
  return {
    generatedAt: report.generatedAt || null,
    checked: report.checked,
    correct: report.correct,
    missing,
    wrong,
    unloaded,
    passed: report.checked > 0 && missing === 0 && wrong === 0 && unloaded === 0
  }
}

function createJobProgress({ root, stateDir, json, fileSystem = fs, parseSchematic = data => Schematic.read(data) }) {
  const auditCache = new Map()
  const schematicCache = new Map()
  const schematicLoads = new Map()

  function sameFileVersion(a, b) {
    return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size
  }

  async function schematicInfo(job) {
    const file = path.join(root, job.schematicPath)
    const stat = await fileSystem.stat(file)
    const cached = schematicCache.get(file)
    if (cached && sameFileVersion(cached, stat)) return cached

    const loading = schematicLoads.get(file)
    if (loading && sameFileVersion(loading.stat, stat)) return loading.promise

    const promise = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = attempt ? await fileSystem.stat(file) : stat
        const data = await fileSystem.readFile(file)
        const after = await fileSystem.stat(file)
        if (!sameFileVersion(before, after)) continue
        const info = {
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          size: after.size,
          data,
          schematicHash: crypto.createHash('sha256').update(data).digest('hex'),
          totalRows: null,
          rowsPromise: null
        }
        schematicCache.set(file, info)
        return info
      }
      throw new Error(`Schematic changed while reading: ${file}`)
    })()
    schematicLoads.set(file, { stat, promise })
    try { return await promise } finally {
      if (schematicLoads.get(file)?.promise === promise) schematicLoads.delete(file)
    }
  }

  async function jobStatePath(job, worker = 'single') {
    const { schematicHash } = await schematicInfo(job)
    const sourceName = path.basename(job.schematicPath, path.extname(job.schematicPath)).replace(/[^a-zA-Z0-9._-]/g, '_')
    const siteIdentity = JSON.stringify({ schematicHash, origin: job.origin, rotation: job.rotation || 0 })
    const siteHash = crypto.createHash('sha256').update(siteIdentity).digest('hex').slice(0, 12)
    const suffix = worker === 'single' ? '' : `.${worker}`
    return path.join(stateDir, `${sourceName}-${siteHash}${suffix}.job-state.json`)
  }

  async function jobState(job, worker = 'single') {
    return json(await jobStatePath(job, worker), null)
  }

  async function auditPath(job) {
    return (await jobStatePath(job)).replace(/\.job-state\.json$/, '.audit.json')
  }

  function validateAuditIdentity(report, job) {
    if (report.schematicPath !== job.schematicPath ||
      report.origin?.x !== job.origin.x || report.origin?.y !== job.origin.y || report.origin?.z !== job.origin.z) {
      throw new Error('复检报告与当前任务投影或起点不匹配')
    }
  }

  async function jobAuditSummary(job) {
    const file = await auditPath(job)
    let stat
    try { stat = await fileSystem.stat(file) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    const cached = auditCache.get(file)
    if (cached?.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.size === stat.size) return cached.summary
    const report = JSON.parse(await fileSystem.readFile(file, 'utf8'))
    validateAuditIdentity(report, job)
    const summary = summarizeAuditReport(report)
    auditCache.set(file, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, summary })
    return summary
  }

  async function jobAuditDetails(job) {
    let report
    try { report = JSON.parse(await fileSystem.readFile(await auditPath(job), 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    validateAuditIdentity(report, job)
    return {
      summary: summarizeAuditReport(report),
      issues: { missing: report.missing, wrong: report.wrong, unloaded: report.unloaded }
    }
  }

  async function jobProgress(job, worker = 'single') {
    try {
      const info = await schematicInfo(job)
      if (info.totalRows === null) {
        if (!info.rowsPromise) {
          info.rowsPromise = (async () => {
            const schematic = await parseSchematic(info.data)
            info.totalRows = schematic.length || schematic.size?.z || 0
            info.data = null
          })().catch(error => {
            info.rowsPromise = null
            throw error
          })
        }
        await info.rowsPromise
      }
      const totalRows = info.totalRows
      const state = await jobState(job, worker)
      const done = state?.completedRows?.length || 0
      return { done, totalRows, percent: totalRows ? Math.round(done * 1000 / totalRows) / 10 : 0 }
    } catch { return { done: 0, totalRows: 0, percent: 0 } }
  }

  return { jobState, jobProgress, jobAuditSummary, jobAuditDetails }
}

module.exports = { createJobProgress, summarizeAuditReport }
