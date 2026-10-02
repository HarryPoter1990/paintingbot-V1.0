/* Orchestrates a safe two-account map-art build.
 * Phase 1: right account alone builds the shared 128-block smooth-stone edge.
 * Phase 2: left/right accounts build disjoint X halves concurrently.
 */
const { spawn } = require('child_process')
const fs = require('fs/promises')
const path = require('path')
const config = require('./config')

let workers = []
let stopped = false
let gatePath = null
const sharedEnv = process.env

function prefix(role, text) {
  text.split(/\r?\n/).filter(Boolean).forEach(line => console.log(`[${role}] ${line}`))
}

function startWorker(role, profile) {
  return new Promise((resolve, reject) => {
    if (stopped) return reject(new Error('Dual runner stopped before worker launch'))
    const username = profile?.username
    const profilesFolder = profile?.profilesFolder
    const expectedMinecraftName = profile?.expectedMinecraftName
    if (!username) return reject(new Error(`Missing Microsoft cache label for ${role}`))
    const child = spawn(process.execPath, ['painting_v2.js'], {
      cwd: __dirname,
      windowsHide: true,
      env: {
        ...sharedEnv,
        MAPART_WORKER: role,
        MAPART_USERNAME: username,
        ...(expectedMinecraftName ? { MAPART_EXPECTED_MC_USERNAME: expectedMinecraftName } : {}),
        ...(profilesFolder ? { MAPART_PROFILES_FOLDER: profilesFolder } : {}),
        ...(gatePath ? { MAPART_DUAL_GATE: gatePath } : {})
      }
    })
    workers.push(child)
    child.stdout.on('data', data => prefix(role, data.toString()))
    child.stderr.on('data', data => prefix(role, data.toString()))
    child.once('error', reject)
    child.once('close', code => {
      workers = workers.filter(item => item !== child)
      if (stopped) return reject(new Error(`${role} was stopped`))
      if (code === 0) return resolve()
      reject(new Error(`${role} exited with code ${code}`))
    })
  })
}

function stopAll() {
  stopped = true
  for (const child of workers) child.kill()
}
process.once('SIGTERM', stopAll)
process.once('SIGINT', stopAll)

async function run() {
  const right = config.workers?.right
  const left = config.workers?.left
  if (!right?.username || !left?.username) throw new Error('Missing config.workers.left/right usernames')
  console.log(`[dual] profiles: right=${right.username}; left=${left.username}`)
  console.log('[dual] phase 1/2: right account is building the full smooth-stone edge')
  await startWorker('bootstrap', right)
  if (stopped) return
  // The server can reject a reconnect from the same Microsoft account even
  // after Mineflayer has exited. Keep a full 30-second cooldown between the
  // bootstrap login and the right account's next login.
  console.log(`[dual] phase 1 complete; waiting 30000ms before ${right.expectedMinecraftName || right.username} reconnects for the right half`)
  await new Promise(resolve => setTimeout(resolve, 30_000))
  if (stopped) return
  gatePath = path.join(__dirname, 'state', `dual-start-${process.env.MAPART_EXPECTED_JOB_ID || 'manual'}.gate`)
  await fs.mkdir(path.dirname(gatePath), { recursive: true })
  await fs.unlink(gatePath).catch(error => { if (error.code !== 'ENOENT') throw error })
  console.log(`[dual] phase 2/2: starting ${left.expectedMinecraftName || left.username} first; it will wait without building`)
  const leftRun = startWorker('left', left)
  let leftError = null
  leftRun.catch(error => { leftError = error })
  await new Promise(resolve => setTimeout(resolve, 12_000))
  if (leftError) throw leftError
  if (stopped) return
  console.log(`[dual] ${left.expectedMinecraftName || left.username} login window complete; starting ${right.expectedMinecraftName || right.username} for the right half`)
  const rightRun = startWorker('right', right)
  let rightError = null
  rightRun.catch(error => { rightError = error })
  await new Promise(resolve => setTimeout(resolve, 12_000))
  if (leftError) throw leftError
  if (rightError) throw rightError
  if (stopped) return
  await fs.writeFile(gatePath, 'open')
  console.log('[dual] both accounts have passed the login window; opening the shared start gate')
  await Promise.all([leftRun, rightRun])
  await fs.unlink(gatePath).catch(() => {})
  console.log('[dual] both halves finished. Use the dashboard full verification before accepting this map.')
}

run().catch(error => {
  console.error(`[dual] ${error.message}`)
  stopAll()
  process.exitCode = 1
})
