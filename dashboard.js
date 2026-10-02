/* Local Chinese control panel for the map-art builder. */
const http = require('http')
const fsSync = require('fs')
const fs = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
require('./prepare_config')
const config = require('./config')
const siteSettings = require('./site_settings')
const connectionSettings = require('./connection_settings')
const initialSetup = require('./initial_setup')
const { safeLitematicName, previewColors, schematicPreview } = require('./dashboard_projection')
const { createJobProgress } = require('./dashboard_jobs')
const { createStudioJobs } = require('./studio_jobs')

const root = __dirname
const studioJobs = createStudioJobs(root)
const schemDir = path.join(root, 'schem')
const projectionDir = path.join(root, '投影文件')
const stateDir = path.join(root, 'state')
const recycleDir = path.join(root, '回收站')
const jobsPath = path.join(stateDir, 'dashboard-jobs.json')
const activePath = path.join(stateDir, 'dashboard-active-job.json')
const placementAnchorPath = path.join(stateDir, 'dashboard-placement-anchor.json')
const dashboardPort = Number(process.env.MAPART_DASHBOARD_PORT || 32124)
let child = null
let activeId = null
let lastRun = { state: 'idle', at: null }
let logs = []
const converting = new Set()
const pushLog = line => { logs.push(`[${new Date().toLocaleTimeString()}] ${line}`); logs = logs.slice(-300) }

const maxUploadBytes = 25 * 1024 * 1024

function convertProjection(input, output) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['convert_litematic.js', '--input', path.join('投影文件', input), '--output', path.join('schem', output)], { cwd: root, windowsHide: true })
    let errors = ''
    proc.stderr.on('data', data => { errors += data.toString() })
    proc.on('error', reject)
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(errors.trim() || ('转换失败，代码 ' + code))))
  })
}

async function uploadProjection(payload) {
  const input = safeLitematicName(payload.name)
  if (typeof payload.data !== 'string' || !payload.data) throw new Error('上传文件为空')
  const data = Buffer.from(payload.data, 'base64')
  if (!data.length || data.length > maxUploadBytes) throw new Error('投影文件为空或超过 25 MB')
  const target = path.join(projectionDir, input)
  try {
    await fs.access(target)
    if (!payload.overwrite) throw new Error('同名投影已存在；请确认覆盖或修改文件名')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await fs.mkdir(projectionDir, { recursive: true })
  await fs.writeFile(target, data)
  const output = path.basename(input, '.litematic') + '.schem'
  pushLog('上传完成：' + input + '；正在转换为 ' + output)
  await convertProjection(input, output)
  pushLog('上传并转换完成：' + input + ' → ' + output)
  return { input, output }
}

async function archiveProjection(rawName) {
  if (child) throw new Error('机器人正在运行，不能移动投影文件')
  const input = safeLitematicName(rawName)
  const base = path.basename(input, '.litematic')
  const schematicPath = path.join('schem', base + '.schem')
  const jobs = await json(jobsPath, [])
  if (jobs.some(job => job.schematicPath === schematicPath)) {
    throw new Error('仍有任务引用 ' + schematicPath + '；请先删除对应任务记录')
  }
  const folder = path.join(recycleDir, new Date().toISOString().replace(/[:.]/g, '-'))
  const items = [
    path.join(projectionDir, input),
    path.join(schemDir, base + '.schem'),
    path.join(schemDir, base + '.materials.json')
  ]
  await fs.mkdir(folder, { recursive: true })
  const moved = []
  for (const source of items) {
    try {
      await fs.access(source)
      const destination = path.join(folder, path.basename(source))
      await fs.rename(source, destination)
      moved.push(path.basename(source))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!moved.length) throw new Error('找不到要移入回收站的投影文件')
  pushLog('已移入回收站：' + moved.join('、'))
  return { moved, folder: path.relative(root, folder) }
}

async function json(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return fallback; throw e } }
const { jobState, jobProgress, jobAuditSummary, jobAuditDetails } = createJobProgress({ root, stateDir, json })
async function saveJobs(jobs) { await fs.mkdir(stateDir, { recursive: true }); await fs.writeFile(jobsPath, JSON.stringify(jobs, null, 2)) }
async function files(dir, ext) { try { return (await fs.readdir(dir)).filter(n => n.toLowerCase().endsWith(ext)).sort() } catch { return [] } }

async function saveBuildTransit(origin) {
  if (!Number.isFinite(origin?.x) || !Number.isFinite(origin?.y) || !Number.isFinite(origin?.z)) {
    throw new Error('请填写完整的建造传送落点 X/Y/Z')
  }
  const configPath = path.join(root, 'config.js')
  const source = await fs.readFile(configPath, 'utf8')
  const pattern = /const buildTransit = new Vec3\([^\r\n]*\)/
  if (!pattern.test(source)) throw new Error('未找到建造传送落点配置，请不要继续开工')
  const replacement = `const buildTransit = new Vec3(${origin.x}, ${origin.y}, ${origin.z})`
  const updated = source.replace(pattern, replacement)
  await fs.writeFile(configPath, updated)
  config.sites.build.arrival = new Vec3(origin.x, origin.y, origin.z)
  pushLog(`已更新建造传送落点：${origin.x}, ${origin.y}, ${origin.z}`)
}
async function saveWorkers(workers) {
  throw new Error('旧账号接口已停用；请到“仓库与领地”同时填写登录缓存标签和游戏名')
}
function suggestedOrigin(last) {
  if (!last?.origin) return null
  // This server stacks each finished horizontal map-art plane directly above
  // the preceding one. Keep X/Z and raise only the projection Y by one.
  return { x: last.origin.x, y: last.origin.y + 1, z: last.origin.z, rotation: 0 }
}

function suggestedBuildTransit(origin) {
  if (!origin) return null
  // Converted map-art schematics reserve local X=0 as an empty margin. The
  // first real smooth-stone/carpet column is local (1, 0, 0); the residence
  // landing is one block in front of it, at local (1, 0, -1).
  return { x: origin.x + 1, y: origin.y, z: origin.z - 1 }
}
async function autoConvertNewProjections() {
  for (const input of await files(projectionDir, '.litematic')) {
    const output = `${path.basename(input, '.litematic')}.schem`
    if ((await files(schemDir, '.schem')).includes(output) || converting.has(input)) continue
    converting.add(input)
    pushLog(`检测到新投影，自动转换：${input} → ${output}`)
    const proc = spawn(process.execPath, ['convert_litematic.js', '--input', path.join('投影文件', input), '--output', path.join('schem', output)], { cwd: root, windowsHide: true })
    proc.stderr.on('data', d => pushLog(d.toString().trim()))
    proc.on('close', code => { converting.delete(input); pushLog(`自动转换 ${input} ${code === 0 ? '完成' : `失败（代码 ${code}）`}`) })
  }
}
async function preflightJob(id) {
  const jobs = await json(jobsPath, [])
  const job = jobs.find(item => item.id === id)
  if (!job) throw new Error('找不到任务')
  const checks = []
  const add = (level, text) => checks.push({ level, text })
  for (const field of initialSetup.missing(config)) add('error', `首次配置未完成：${field}。请到“仓库与领地”填写。`)
  const validOrigin = Number.isFinite(job.origin?.x) && Number.isFinite(job.origin?.y) && Number.isFinite(job.origin?.z)
  add(validOrigin ? 'ok' : 'error', validOrigin ? '任务 X / Y / Z 坐标完整' : '任务坐标不完整')
  const validRotation = job.rotation == null || job.rotation === 0
  add(validRotation ? 'ok' : 'error', validRotation ? '投影方向为原始 0°' : '仅支持原始 0° 投影；请重新创建任务')
  const schematicName = path.basename(job.schematicPath || '')
  const safePath = /^.+\.schem$/i.test(schematicName) && path.resolve(root, job.schematicPath || '') === path.resolve(schemDir, schematicName)
  add(safePath ? 'ok' : 'error', safePath ? '任务引用的 schem 路径正常：' + schematicName : '任务引用的 schem 路径异常')
  let schematic = null
  if (safePath) {
    try {
      schematic = await Schematic.read(await fs.readFile(path.join(schemDir, schematicName)))
      add('ok', 'schem 可读取：' + schematic.size.x + ' × ' + schematic.size.y + ' × ' + schematic.size.z)
      const allowed = new Set(['air', 'smooth_stone', ...Object.keys(previewColors)])
      let unsupported = null
      await schematic.forEach((block, pos) => { if (!unsupported && !allowed.has(block.name)) unsupported = block.name + ' @ ' + pos.x + ',' + pos.y + ',' + pos.z })
      add(unsupported ? 'error' : 'ok', unsupported ? '发现不支持方块：' + unsupported : '方块类型仅包含地毯、平滑石头和空气')
    } catch (error) { add('error', '无法读取 schem：' + error.message) }
  }
  const projectionName = schematicName.replace(/\.schem$/i, '.litematic')
  try { await fs.access(path.join(projectionDir, projectionName)); add('ok', '找到同名原始投影：' + projectionName) }
  catch { add('warning', '未找到同名 .litematic；仍可建造，但无法从控制台确认来源') }
  const transit = config.sites?.build?.arrival
  add(transit && Number.isFinite(transit.x) && Number.isFinite(transit.y) && Number.isFinite(transit.z) ? 'ok' : 'error', transit ? '建造子领地落点已配置：' + transit.x + ',' + transit.y + ',' + transit.z : '未配置建造子领地落点')
  if (validOrigin) {
    add('ok', '正常建造使用初版坐标进场；dth 落点与投影高度独立，不要求梯子。')
    add('warning', '此检查不登录服务器；请确认 dth 实际落点脚下有地板、头顶两格为空。')
  }
  const state = schematic ? await jobState(job).catch(() => null) : null
  add('ok', '本地进度文件：已完成 ' + (state?.completedRows?.length || 0) + ' 行')
  const passed = !checks.some(check => check.level === 'error')
  return { jobName: job.name, passed, checks }
}
async function status() {
  await autoConvertNewProjections()
  const jobs = await json(jobsPath, [])
  // Before the first dashboard-created job, use the current configured map
  // as the remembered starting point so an existing build is not forgotten.
  // The sidebar/list order is not a build-height order.  Always use the
  // highest placed projection as the stacking reference.
  const queuedHighest = jobs.length ? jobs.reduce((highest, job) =>
    !highest || job.origin.y > highest.origin.y ? job : highest, null) : null
  const savedAnchor = await json(placementAnchorPath, null)
  const manualAnchor = savedAnchor && Number.isFinite(savedAnchor.origin?.x) && Number.isFinite(savedAnchor.origin?.y) && Number.isFinite(savedAnchor.origin?.z)
    ? { name: '手动同步的位置', origin: savedAnchor.origin, rotation: savedAnchor.rotation || 0, width: 130, manual: true }
    : null
  // A manual anchor chooses the current X/Z map-art stack. Within that stack,
  // later queued layers must still advance the recommendation in real time.
  // Jobs from an older residence/stack cannot override this selection.
  const stackHighest = manualAnchor ? jobs
    .filter(job => job.origin.x === manualAnchor.origin.x && job.origin.z === manualAnchor.origin.z && job.origin.y >= manualAnchor.origin.y)
    .reduce((highest, job) => !highest || job.origin.y > highest.origin.y ? job : highest, null)
    : null
  const lastJob = stackHighest || manualAnchor || queuedHighest || {
    name: '当前已配置地图', origin: config.sites.build.origin, rotation: config.sites.build.rotation, width: 130
  }
  const nextOrigin = suggestedOrigin(lastJob)
  return { running: !!child, activeId, lastRun, logs, lastJob, suggestedOrigin: nextOrigin, suggestedBuildTransit: suggestedBuildTransit(nextOrigin), buildTransit: config.sites.build.arrival, buildResidence: siteSettings.snapshot(config).buildResidence, workers: config.workers, schematics: await files(schemDir, '.schem'), projections: await files(projectionDir, '.litematic'), jobs: await Promise.all(jobs.map(async j => ({ ...j, progress: await jobProgress(j), auditSummary: await jobAuditSummary(j).catch(error => ({ error: error.message })), dualProgress: { bootstrap: await jobProgress(j, 'bootstrap'), left: await jobProgress(j, 'left'), right: await jobProgress(j, 'right') } }))) }
}
async function start(id, mode = 'build', buildMode = 'single') {
  if (studioJobs.status().running) throw new Error('图片转换仍在进行；请等待完成或先取消，避免影响机器人')
  if (child) throw new Error('机器人正在运行；请先等待它完成或在终端停止。')
  const jobs = await json(jobsPath, [])
  const job = jobs.find(j => j.id === id)
  if (!job) throw new Error('找不到任务')
  if (job.rotation != null && job.rotation !== 0) throw new Error('仅支持原始 0° 投影；该旧任务不会启动')
  if (!['single', 'dual'].includes(buildMode)) throw new Error('未知铺设模式')
  if (mode !== 'build' && buildMode !== 'single') throw new Error('复检只能使用单人模式')
  const missing = initialSetup.missing(config, buildMode)
  if (missing.length) throw new Error(`信息未填完整：${missing.join('、')}。请到“仓库与领地”补全后再启动。`)
  await fs.writeFile(activePath, JSON.stringify(job, null, 2))
  activeId = id; logs = []; pushLog(mode === 'verify' ? `开始复检：${job.name}` : mode === 'repair' ? `开始修复：${job.name}` : `开始：${job.name}（${buildMode === 'dual' ? '双人左右半图' : '单人'}）`)
  lastRun = { state: 'running', jobName: job.name, mode: buildMode === 'dual' ? 'dual' : mode, at: new Date().toISOString() }
  const program = buildMode === 'dual' ? 'dual_runner.js' : 'painting_v2.js'
  const env = { ...process.env, MAPART_JOB: activePath, MAPART_EXPECTED_JOB_ID: job.id }
  if (buildMode === 'single') {
    env.MAPART_WORKER = 'single'
    env.MAPART_USERNAME = config.workers?.right?.username || config.connection.username
    env.MAPART_EXPECTED_MC_USERNAME = config.workers?.right?.expectedMinecraftName || ''
  }
  child = spawn(process.execPath, buildMode === 'dual' ? [program] : [program, mode], { cwd: root, env, windowsHide: true })
  child.once('close', code => {
    const state = code === 0 ? 'completed' : (code === null ? 'stopped' : 'failed')
    lastRun = { state, jobName: job.name, mode: buildMode === 'dual' ? 'dual' : mode, code, at: new Date().toISOString() }
  })
  child.stdout.on('data', d => d.toString().split(/\r?\n/).filter(Boolean).forEach(pushLog))
  child.stderr.on('data', d => d.toString().split(/\r?\n/).filter(Boolean).forEach(pushLog))
  child.on('close', code => { pushLog(`机器人已退出，代码 ${code}`); child = null; activeId = null })
}
// Kept in a separate file so the browser-side code can be checked normally,
// rather than being embedded inside a JavaScript template literal.
function page() { return fsSync.readFileSync(path.join(root, 'dashboard.html'), 'utf8') }
function studioPage() { return fsSync.readFileSync(path.join(root, 'studio.html'), 'utf8') }
function sitesPage() { return fsSync.readFileSync(path.join(root, 'sites.html'), 'utf8') }
async function readBody(req) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > maxUploadBytes * 2) throw new Error('请求内容超过允许大小')
  }
  const body = text ? JSON.parse(text) : {}
  if ((req.url === '/api/jobs' || req.url === '/api/placement-anchor') && body.rotation != null && body.rotation !== 0) {
    throw new Error('仅支持原始 0° 投影')
  }
  return body
}
async function deleteDashboardJob(id) {
  if (child && activeId === id) throw new Error('该任务正在运行，请先终止机器人')
  const jobs = await json(jobsPath, [])
  const kept = jobs.filter(job => job.id !== id)
  if (kept.length === jobs.length) throw new Error('找不到任务')
  await saveJobs(kept)
  pushLog(`已删除任务：${id}（schem、投影、进度文件均保留）`)
}
async function stopDashboardBot() {
  if (!child) throw new Error('当前没有运行中的机器人')
  pushLog('正在终止机器人；未完成区域下次会重新检查。')
  child.kill()
}
const originalCreateServer = http.createServer
http.createServer = listener => originalCreateServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/studio') {
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' })
      return res.end(studioPage())
    }
    if (req.method === 'GET' && req.url === '/sites') {
      res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' })
      return res.end(sitesPage())
    }
    if (req.method === 'GET' && req.url === '/pink-theme.css') {
      res.writeHead(200, { 'content-type': 'text/css;charset=utf-8', 'cache-control': 'no-store' })
      return res.end(fsSync.readFileSync(path.join(root, 'pink_theme.css'), 'utf8'))
    }
    if (req.method === 'GET' && req.url === '/api/site-settings') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ settings: siteSettings.snapshot(config), carpets: siteSettings.CARPETS, running: !!child }))
    }
    if (req.method === 'GET' && req.url === '/api/connection-settings') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ settings: connectionSettings.snapshot(config), missing: initialSetup.missing(config), running: !!child }))
    }
    if (req.method === 'POST' && req.url === '/api/connection-settings') {
      if (child) throw new Error('机器人正在运行；请先停止，再修改服务器和账号')
      const body = await readBody(req)
      if (body.confirm !== true) throw new Error('保存前需要确认')
      const saved = await connectionSettings.save(body.settings)
      connectionSettings.apply(config, saved)
      pushLog('服务器和机器人账号已保存；后续启动生效')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, settings: saved, missing: initialSetup.missing(config) }))
    }
    if (req.method === 'POST' && req.url === '/api/site-settings') {
      if (child) throw new Error('机器人正在运行；请先停止，再修改场地坐标')
      const body = await readBody(req)
      if (body.confirm !== true) throw new Error('保存前需要确认')
      const saved = await siteSettings.save(body.settings)
      siteSettings.apply(config, saved)
      pushLog('场地坐标已保存；后续启动的机器人将使用新坐标')
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, settings: saved }))
    }
    if (req.method === 'GET' && req.url === '/api/studio/progress') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(studioJobs.status()))
    }
    if (req.method === 'POST' && req.url === '/api/studio/cancel') {
      const cancelled = studioJobs.cancel()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ cancelled }))
    }
    if (req.method === 'POST' && (req.url === '/api/studio/preview' || req.url === '/api/studio/generate')) {
      if (child) throw new Error('机器人正在运行；请等铺设结束后再处理图片，避免占用计算资源')
      const payload = await readBody(req)
      if (typeof payload.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.data)) throw new Error('请上传有效的图片')
      const image = Buffer.from(payload.data, 'base64')
      const previewOnly = req.url === '/api/studio/preview'
      const work = studioJobs.run(previewOnly ? 'preview' : 'generate', image, payload)
      res.once('close', () => { if (!res.writableEnded) studioJobs.cancel(work.jobId) })
      const result = await work
      if (!previewOnly) pushLog(`图片已转换：${result.files.length} 张投影（${result.mode}，固定抖动）`)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(result))
    }
    if (req.method === 'GET' && req.url.startsWith('/api/preview-job/')) {
      const jobs = await json(jobsPath, [])
      const job = jobs.find(item => item.id === decodeURIComponent(req.url.slice('/api/preview-job/'.length)))
      if (!job) throw new Error('找不到任务')
      const result = await schematicPreview(path.basename(job.schematicPath), (await jobState(job))?.completedRows || [])
      res.writeHead(200, {'content-type':'application/json'})
      return res.end(JSON.stringify(result))
    }
    if (req.method === 'GET' && req.url.startsWith('/api/preflight/')) {
      const result = await preflightJob(decodeURIComponent(req.url.slice('/api/preflight/'.length)))
      res.writeHead(200, {'content-type':'application/json'})
      return res.end(JSON.stringify(result))
    }
    if (req.method === 'GET' && req.url.startsWith('/api/audit/')) {
      const jobs = await json(jobsPath, [])
      const job = jobs.find(item => item.id === decodeURIComponent(req.url.slice('/api/audit/'.length)))
      if (!job) throw new Error('找不到任务')
      const result = await jobAuditDetails(job)
      if (!result) throw new Error('这张任务尚无完整复检报告；请先点「复检」')
      res.writeHead(200, {'content-type':'application/json'})
      return res.end(JSON.stringify(result))
    }
    if (req.method === 'GET' && req.url.startsWith('/api/preview/')) {
      const result = await schematicPreview(decodeURIComponent(req.url.slice('/api/preview/'.length)))
      res.writeHead(200, {'content-type':'application/json'})
      return res.end(JSON.stringify(result))
    }
    if (req.method === 'POST' && req.url === '/api/upload') {
      const result = await uploadProjection(await readBody(req))
      res.writeHead(200, {'content-type':'application/json'})
      return res.end(JSON.stringify(result))
    }
    if (req.method === 'POST' && req.url.startsWith('/api/reconvert/')) {
      const input = safeLitematicName(decodeURIComponent(req.url.slice('/api/reconvert/'.length)))
      const output = path.basename(input, '.litematic') + '.schem'
      pushLog('正在重新转换：' + input)
      await convertProjection(input, output)
      pushLog('重新转换完成：' + input + ' → ' + output)
      res.writeHead(200, {'content-type':'application/json'})
      return res.end(JSON.stringify({ input, output }))
    }
    if (req.method === 'POST' && req.url.startsWith('/api/archive-projection/')) {
      const result = await archiveProjection(decodeURIComponent(req.url.slice('/api/archive-projection/'.length)))
      res.writeHead(200, {'content-type':'application/json'})
      return res.end(JSON.stringify(result))
    }
    if (req.method === 'POST' && req.url.startsWith('/api/delete/')) { await deleteDashboardJob(req.url.split('/').pop()); res.writeHead(200, {'content-type':'application/json'}); return res.end('{"ok":true}') }
    if (req.method === 'POST' && req.url === '/api/stop') { await stopDashboardBot(); res.writeHead(200, {'content-type':'application/json'}); return res.end('{"ok":true}') }
  } catch (error) { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({error:error.message})) }
  return listener(req, res)
})
http.createServer(async (req, res) => { try { let result; if (req.method === 'GET' && req.url === '/') { res.writeHead(200, {'content-type':'text/html;charset=utf-8'}); return res.end(page()) } if (req.method === 'GET' && req.url === '/api/status') result = await status(); else if (req.method === 'POST' && req.url === '/api/jobs') { const j = await readBody(req); if (!j.name || !j.schematicPath || !Number.isFinite(j.origin?.x) || !Number.isFinite(j.origin?.y) || !Number.isFinite(j.origin?.z)) throw new Error('请填完整名称、schem 和 X/Y/Z'); const jobs = await json(jobsPath, []); j.id = `${Date.now()}`; jobs.push(j); await saveJobs(jobs); result = j } else if (req.method === 'POST' && req.url === '/api/build-transit') { const transit = await readBody(req); await saveBuildTransit(transit); result = { ok: true, buildTransit: config.sites.build.arrival } } else if (req.method === 'POST' && req.url === '/api/workers') { await saveWorkers(await readBody(req)); result = { ok: true, workers: config.workers } } else if (req.method === 'POST' && req.url === '/api/placement-anchor') { const anchor = await readBody(req); if (!Number.isFinite(anchor.origin?.x) || !Number.isFinite(anchor.origin?.y) || !Number.isFinite(anchor.origin?.z)) throw new Error('请填完整的当前投影起点 X/Y/Z'); await fs.mkdir(stateDir, { recursive: true }); await fs.writeFile(placementAnchorPath, JSON.stringify({ origin: anchor.origin, rotation: Number.isInteger(anchor.rotation) ? anchor.rotation : 0, updatedAt: new Date().toISOString() }, null, 2)); result = { ok: true } } else if (req.method === 'POST' && req.url.startsWith('/api/start/')) { const options = await readBody(req); await start(req.url.split('/').pop(), 'build', options.buildMode || 'single'); result = { ok:true } } else if (req.method === 'POST' && req.url.startsWith('/api/verify/')) { await start(req.url.split('/').pop(), 'verify'); result = { ok:true } } else if (req.method === 'POST' && req.url.startsWith('/api/repair/')) { await start(req.url.split('/').pop(), 'repair'); result = { ok:true } } else if (req.method === 'POST' && req.url === '/api/convert') { const x = await readBody(req); if (!x.input || !x.output || !/\.schem$/i.test(x.output)) throw new Error('请选择投影并填写以 .schem 结尾的输出名'); const proc = spawn(process.execPath, ['convert_litematic.js','--input',path.join('投影文件',x.input),'--output',path.join('schem',path.basename(x.output))], {cwd:root, windowsHide:true}); proc.on('close', c => pushLog(`转换 ${x.input} 完成，代码 ${c}`)); result = {ok:true} } else throw new Error('Not found'); res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(result)) } catch (e) { res.writeHead(400, {'content-type':'application/json'},); res.end(JSON.stringify({error:e.message})) } }).on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[dashboard] 端口 ${dashboardPort} 已被另一个控制台占用；请关闭旧控制台后重试。`)
    process.exitCode = 1
    return
  }
  throw error
}).listen(dashboardPort, '127.0.0.1', () => console.log(`地图画控制台：http://127.0.0.1:${dashboardPort}`))
