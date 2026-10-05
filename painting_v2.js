/*
 * Carpet map-art builder, v2.
 *
 * Travel between areas uses configured residence teleports. Local movement can
 * use normal pathfinding, Mineflayer creative flight, or the server-accepted
 * short coordinate updates used by the supplied first version.
 */
const mineflayer = require('mineflayer')
const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const config = require('./config')
const { resolveProjection } = require('./projection_resolver')
const { writeAuditReport } = require('./audit_report_writer')
const { selectedFoodItem } = require('./food_selection')

// Microsoft authentication happens inside mineflayer.createBot(), before the
// first spawn packet and before dashboard-job loading. Apply worker profile
// overrides here, not only in applyDashboardJob(), so a left worker never
// accidentally authenticates with the right worker's default cache.
if (process.env.MAPART_USERNAME) config.connection.username = process.env.MAPART_USERNAME
if (process.env.MAPART_PROFILES_FOLDER) config.connection.profilesFolder = process.env.MAPART_PROFILES_FOLDER
if (process.env.MAPART_EXPECTED_MC_USERNAME) config.connection.expectedMinecraftName = process.env.MAPART_EXPECTED_MC_USERNAME

let bot
let stopping = false
let activeStatePath
let deathRecoveryPending = false
const taskMode = process.argv[2] || 'build'
const workerRole = process.env.MAPART_WORKER || 'single'
const workerLabel = { single: '单人', bootstrap: '右机器人/平滑石头', left: '左半边', right: '右半边' }[workerRole] || workerRole

// The local dashboard starts a job with this file.  Direct `npm.cmd start`
// remains unchanged: without MAPART_JOB the normal config.js values are used.
async function applyDashboardJob() {
  if (!process.env.MAPART_JOB) return
  const job = JSON.parse(await fs.readFile(process.env.MAPART_JOB, 'utf8'))
  if (!job.schematicPath || !job.origin) throw new Error('Dashboard job is missing schematicPath or origin')
  if (process.env.MAPART_EXPECTED_JOB_ID && job.id !== process.env.MAPART_EXPECTED_JOB_ID) {
    throw new Error(`Dashboard job mismatch: expected ${process.env.MAPART_EXPECTED_JOB_ID}, got ${job.id || 'missing id'}`)
  }
  if (job.rotation != null && job.rotation !== 0) throw new Error('Only the original 0-degree schematic direction is supported')
  config.schematicPath = job.schematicPath
  config.sites.build.origin = new Vec3(job.origin.x, job.origin.y, job.origin.z)
  config.sites.build.rotation = 0
  // The dth landing is an independent residence coordinate. It is not tied
  // to the projection's X/Y/Z and normal construction never requires a ladder.
  console.log(`[dashboard] job ${job.name || path.basename(job.schematicPath)}: ${job.schematicPath} @ (${job.origin.x}, ${job.origin.y}, ${job.origin.z})`)
  console.log(`[dashboard] verified job id=${job.id}; schematic=${config.schematicPath}`)
}

function schematicSize(schematic) {
  return schematic.size || new Vec3(schematic.width, schematic.height, schematic.length)
}

async function verifyDashboardProjectionIntegrity() {
  // Dashboard jobs normally have a raw file named 投影文件/<name>.litematic.
  // Re-convert that source into the resolver cache, then compare every block
  // semantically instead of comparing bytes (different tools can serialize a
  // valid Sponge schematic differently). This prevents a stale same-named
  // .schem from silently building an older image.
  if (!process.env.MAPART_JOB) return
  const name = path.basename(config.schematicPath, path.extname(config.schematicPath))
  const source = path.join(__dirname, '投影文件', `${name}.litematic`)
  try {
    await fs.access(source)
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`[preflight] no matching raw projection for ${config.schematicPath}; integrity comparison skipped`)
      return
    }
    throw error
  }

  const canonicalPath = await resolveProjection(source)
  const [targetData, canonicalData] = await Promise.all([fs.readFile(config.schematicPath), fs.readFile(canonicalPath)])
  const [target, canonical] = await Promise.all([Schematic.read(targetData), Schematic.read(canonicalData)])
  const targetSize = schematicSize(target)
  const canonicalSize = schematicSize(canonical)
  if (!targetSize.equals(canonicalSize)) {
    throw new Error(`[preflight] schematic mismatch: ${config.schematicPath} is ${targetSize}, but ${path.basename(source)} is ${canonicalSize}`)
  }
  for (let y = 0; y < targetSize.y; y++) {
    for (let z = 0; z < targetSize.z; z++) {
      for (let x = 0; x < targetSize.x; x++) {
        const position = new Vec3(x, y, z)
        const expected = canonical.getBlock(position)?.name || 'air'
        const actual = target.getBlock(position)?.name || 'air'
        if (actual !== expected) {
          throw new Error(
            `[preflight] schematic mismatch at local (${x}, ${y}, ${z}): ` +
            `${config.schematicPath} has ${actual}, but ${path.basename(source)} has ${expected}. ` +
            'Re-convert this projection before starting.'
          )
        }
      }
    }
  }
  console.log(`[preflight] verified ${config.schematicPath} matches ${path.basename(source)}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isSupported = name => config.SUPPORTED_BLOCKS.includes(name)
const key = pos => `${pos.x},${pos.y},${pos.z}`
const formatServerReason = reason => {
  if (typeof reason === 'string') return reason
  try { return JSON.stringify(reason) } catch { return String(reason) }
}

function rotateLocal(local, rotation) {
  if (rotation !== 0) throw new Error(`Unsupported rotation: ${rotation}; only the original 0-degree direction is allowed`)
  return new Vec3(local.x, local.y, local.z)
}

function toWorld(local) {
  return config.sites.build.origin.plus(rotateLocal(local, config.sites.build.rotation))
}

function statePathForPlan(plan) {
  const baseName = path.basename(config.schematicPath, path.extname(config.schematicPath))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
  const siteIdentity = JSON.stringify({
    schematicHash: plan.schematicHash,
    origin: config.sites.build.origin,
    rotation: config.sites.build.rotation
  })
  const siteHash = crypto.createHash('sha256').update(siteIdentity).digest('hex').slice(0, 12)
  const suffix = workerRole === 'single' ? '' : `.${workerRole}`
  return path.join(config.stateDirectory, `${baseName}-${siteHash}${suffix}.job-state.json`)
}

function workerOwnsTask(task) {
  if (workerRole === 'left') return task.local.x >= 1 && task.local.x <= 64
  if (workerRole === 'right') return task.local.x >= 65
  return true
}

async function readState(plan) {
  activeStatePath = statePathForPlan(plan)
  try {
    const state = JSON.parse(await fs.readFile(activeStatePath, 'utf8'))
    console.log(`[state] Resuming progress: ${activeStatePath}`)
    return state
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`[state] New map progress: ${activeStatePath}`)
      return { version: 3, completedRows: [], completedRegions: [], blocked: [] }
    }
    throw error
  }
}

async function writeState(state) {
  if (!activeStatePath) throw new Error('State path has not been initialized')
  await fs.mkdir(path.dirname(activeStatePath), { recursive: true })
  const temporary = `${activeStatePath}.tmp`
  await fs.writeFile(temporary, JSON.stringify(state, null, 2))
  await fs.rename(temporary, activeStatePath)
}

async function loadPlan() {
  const resolvedPath = await resolveProjection(config.schematicPath)
  const data = await fs.readFile(resolvedPath)
  const schematic = await Schematic.read(data)
  const width = schematic.width || schematic.size?.x
  const height = schematic.height || schematic.size?.y
  const length = schematic.length || schematic.size?.z
  if (!width || !height || !length) throw new Error('Unable to read schematic dimensions')

  const layers = new Set()
  const rows = []
  for (let z = 0; z < length; z++) {
    const row = []
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const block = schematic.getBlock(new Vec3(x, y, z))
        if (!block || block.name === 'air') continue
        if (!isSupported(block.name)) {
          throw new Error(`Only 16-colour carpets and smooth_stone are supported; found ${block.name} at ${x},${y},${z}`)
        }
        layers.add(y)
        row.push({ local: new Vec3(x, y, z), name: block.name })
      }
    }
    rows.push(row)
  }

  if (rows.every(row => row.length === 0)) throw new Error('Schematic contains no supported blocks')
  console.log(`Loaded ${width}x${height}x${length}; ${rows.reduce((n, row) => n + row.length, 0)} supported blocks across ${layers.size} layer(s)`)
  return {
    width,
    height,
    length,
    rows,
    schematicHash: crypto.createHash('sha256').update(data).digest('hex'),
    resolvedPath
  }
}

async function waitFor(condition, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (stopping) throw new Error(`Stopped while waiting: ${message}`)
    if (condition()) return
    await sleep(100)
  }
  throw new Error(message)
}

async function waitForChunks() {
  if (typeof bot.waitForChunksToLoad === 'function') {
    await Promise.race([
      bot.waitForChunksToLoad(),
      sleep(10_000)
    ])
  }
}

async function verifyMarker(site) {
  if (!site.marker) return
  const block = bot.blockAt(site.marker.position)
  if (!block || block.name !== site.marker.block) {
    throw new Error(`Wrong site or unloaded chunks: expected marker ${site.marker.block} at ${site.marker.position}`)
  }
}

function describeTravelPosition(position) {
  if (!position) return 'no position packet'
  const here = `(${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`
  const known = Object.entries(config.sites)
    .filter(([, site]) => site.arrival)
    .map(([name, site]) => ({ name, distance: position.distanceTo(site.arrival) }))
    .sort((a, b) => a.distance - b.distance)
  if (known.length === 0) return here
  const nearest = known[0]
  return `${here}; nearest configured site=${nearest.name} (${nearest.distance.toFixed(2)} blocks away)`
}

async function travel(siteName) {
  const site = config.sites[siteName]
  if (!site) throw new Error(`Missing site configuration for ${siteName}`)
  // Residence commands often leave the player in exactly the same position
  // when they are already there. Treat that as success instead of waiting for
  // a movement packet that will never arrive.
  if (site.arrival && bot.entity.position.distanceTo(site.arrival) <= site.arrivalRadius) {
    console.log(`[travel] already near ${siteName}; no teleport needed (${describeTravelPosition(bot.entity.position)})`)
    await waitForChunks()
    await verifyMarker(site)
    return
  }
  if (site.teleport) {
    // The first working builder allowed the residence plugin to settle before
    // and after every command.  Preserve that proven timing instead of
    // changing the protocol flow while a transfer is in progress.
    console.log(`[travel] ${siteName}: settling ${config.teleportTiming.beforeCommandMs}ms before ${site.teleport}`)
    await sleep(config.teleportTiming.beforeCommandMs)
    if (stopping) throw new Error(`Stopped before ${siteName} teleport`)
    console.log(`[travel] ${siteName}: ${site.teleport}`)
    bot.chat(site.teleport)
    await sleep(config.teleportTiming.afterCommandMs)
    if (stopping) throw new Error(`Stopped during ${siteName} teleport`)
    // A residence command can be silently ignored or leave the player at a
    // different residence. Never fall through to pathfinding in that case:
    // it would make the bot physically walk across the world and overload
    // the server/other account. A longer passive wait is allowed for the
    // position packet because this server can apply a residence command after
    // its normal five-second command settle. It never re-sends the command.
    if (site.arrival) {
      try {
        await waitFor(
          () => Boolean(bot.entity?.position) && bot.entity.position.distanceTo(site.arrival) <= site.arrivalRadius,
          12_000,
          `Teleport for ${siteName} did not reach ${site.arrival}`
        )
      } catch (error) {
        const current = bot.entity?.position
        throw new Error(
          `Teleport for ${siteName} did not reach ${site.arrival}; ` +
          `last position ${describeTravelPosition(current)}. Stopped before any pathfinding.`
        )
      }
      console.log(`[travel] ${siteName} arrival confirmed (${describeTravelPosition(bot.entity.position)})`)
    }
  } else {
    if (!site.arrival) throw new Error(`Site ${siteName} needs an arrival coordinate when teleport is disabled`)
    console.log(`[travel] moving to ${siteName}: ${site.arrival}`)
    await moveNear(site.arrival, 1.5)
  }
  await waitForChunks()
  await verifyMarker(site)
}

async function moveNear(position, range = 1, mode = config.movement.mode, verifyActualPosition = true) {
  if (mode === 'creative_flight') {
    throw new Error('creative_flight is disabled: this server rejects its movement packets')
  }
  if (mode === 'coordinate_sync') {
    await moveByCoordinateSync(position, range)
    return
  }
  if (mode !== 'pathfinder') throw new Error(`Unknown movement mode: ${mode}`)
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (bot.entity.position.distanceTo(position) <= range + 0.2) return
    const goal = new GoalNear(position.x, position.y, position.z, range)
    const reached = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        bot.pathfinder.stop()
        reject(new Error(`Timed out moving near ${position}`))
      }, config.build.movementTimeoutMs)
      const onGoal = () => { cleanup(); resolve() }
      const onPath = result => {
        if (result.status === 'noPath') {
          cleanup()
          reject(new Error(`No path near ${position}`))
        }
      }
      const cleanup = () => {
        clearTimeout(timeout)
        bot.removeListener('goal_reached', onGoal)
        bot.removeListener('path_update', onPath)
      }
      bot.on('goal_reached', onGoal)
      bot.on('path_update', onPath)
      bot.pathfinder.setGoal(goal)
    })
    await reached
    // Material storage is different from the map surface: the normal game
    // container interaction radius is the real proof there. Keep the proven
    // old local-routing behaviour and let openContainer validate the reach.
    if (!verifyActualPosition) return
    const distance = bot.entity?.position?.distanceTo(position)
    if (Number.isFinite(distance) && distance <= range + 0.2) return
    console.warn(`[movement] pathfinder reported arrival attempt ${attempt}, but actual distance to ${position} is ${Number.isFinite(distance) ? distance.toFixed(2) : 'unknown'}; waiting for chunks and retrying`)
    await waitForChunks()
  }
  throw new Error(`Pathfinder stopped short of ${position}; actual position ${bot.entity?.position || 'unknown'}`)
}

async function moveByCoordinateSync(position, range) {
  const movement = config.movement
  const horizontalStep = movement.coordinateStepHorizontal
  const verticalStep = movement.coordinateStepVertical
  const delay = movement.coordinateStepDelayMs
  const maxSteps = movement.coordinateMaxSteps
  if (!(horizontalStep > 0 && verticalStep > 0 && delay >= 0 && maxSteps > 0)) {
    throw new Error('Invalid coordinate_sync movement configuration')
  }

  // Raise/lower first, then move in short horizontal packets. This preserves
  // the fixed residence as a safe launch point even when the next map is at a
  // different Y level. It deliberately follows the first version's supported
  // coordinate-update approach rather than calling creative flight.
  let steps = 0
  while (!stopping && bot.entity?.position && bot.entity.position.distanceTo(position) > range + 0.2) {
    if (++steps > maxSteps) {
      throw new Error(`coordinate_sync exceeded ${maxSteps} steps near ${position}`)
    }
    const current = bot.entity.position
    const yDifference = position.y - current.y
    const nextY = Math.abs(yDifference) <= verticalStep
      ? position.y
      : current.y + Math.sign(yDifference) * verticalStep

    // Do not start the long horizontal leg until the configured construction
    // height has been reached. This is important when maps are stacked higher.
    const atTargetY = Math.abs(nextY - position.y) < 0.001
    const dx = position.x - current.x
    const dz = position.z - current.z
    const horizontalDistance = Math.hypot(dx, dz)
    const scale = atTargetY && horizontalDistance > horizontalStep
      ? horizontalStep / horizontalDistance
      : 1
    const nextX = atTargetY ? current.x + dx * scale : current.x
    const nextZ = atTargetY ? current.z + dz * scale : current.z

    // Keep the same mutation pattern as the working first version; assigning
    // x/y/z separately lets Mineflayer emit its normal movement updates.
    bot.entity.position.x = nextX
    bot.entity.position.y = nextY
    bot.entity.position.z = nextZ
    await sleep(delay)
  }
  if (stopping || !bot.entity?.position) throw new Error('Movement interrupted by death or disconnect')
  await waitForChunks()
}

function inventoryCount(name) {
  return bot.inventory.items()
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0)
}

function stackCount(requirements) {
  return Object.values(requirements).reduce((sum, count) => sum + Math.ceil(count / 64), 0)
}

// Regions are resumed independently.  A previous interrupted region can leave
// carpet stacks in the inventory which are not needed by the next one.  Do not
// wait for a duplicator in that case: first discard only supported build
// materials above the current region's exact requirement.
async function discardSurplusMaterials(requirements, reason) {
  const disposal = config.storage.leftovers
  if (disposal?.mode !== 'toss_into_void' || !disposal.stand || disposal.facing !== 'west') {
    throw new Error('Backpack is full but safe void disposal is not configured')
  }

  const keep = { ...requirements }
  let tossed = 0
  for (const item of bot.inventory.items()) {
    // Keep only the current region's build materials and the configured food.
    // Any other item is explicitly surplus for this carpet-only builder.
    if (!isSupported(item.name) && isProtectedUtility(item.name)) continue
    const retain = isSupported(item.name)
      ? Math.min(item.count, keep[item.name] || 0)
      : 0
    if (isSupported(item.name)) keep[item.name] = Math.max(0, (keep[item.name] || 0) - retain)
    const extra = item.count - retain
    if (extra <= 0) continue
    if (tossed === 0) {
      try {
        await moveNear(disposal.stand, 1.2, config.storage.localMovement)
        await bot.lookAt(disposal.stand.offset(-3, 0.5, 0), true)
        console.log(`[storage] backpack cleanup (${reason}): moving to the void disposal point`)
      } catch (error) {
        // The material residence may not have a walkable corridor all the way
        // to the void edge.  Discarding at the landing point is still better
        // than blocking the build or retaining unwanted inventory.
        await bot.lookAt(bot.entity.position.offset(-3, 0.5, 0), true)
        console.warn(`[storage] cannot reach void disposal (${error.message}); dropping surplus west from the material landing`)
      }
    }
    await bot.toss(item.type, null, extra)
    tossed += extra
    console.log(`[storage] discarded ${extra} surplus ${item.name}`)
    await sleep(config.build.operationDelayMs)
  }
  // The disposal point faces the void and is deliberately away from the
  // storage corridor.  Never ask pathfinder to cross that gap afterwards;
  // reset through the permanent residence landing point first.
  if (tossed > 0) {
    console.log('[storage] cleanup complete; returning to material landing before collecting')
    await travel('material')
  }
  return tossed
}

function sourceLevels(name) {
  const base = config.storage.columns[name]
  if (!base) throw new Error(`No storage column configured for ${name}`)
  return Array.from({ length: config.storage.levels }, (_, level) => ({
    position: config.storage.anchor.plus(base).offset(0, level, 0),
    access: config.storage.anchor.plus(base).plus(config.storage.accessOffset).offset(0, level * config.storage.accessYStep, 0),
    level
  }))
}

async function withdrawFromColumn(name, needed) {
  let remaining = needed
  for (const source of sourceLevels(name)) {
    if (remaining <= 0) break
    // Preserve the original local barrel movement. `openContainer` is the
    // reach check; map/ladder routes are the only callers that demand an exact
    // server-confirmed standing coordinate.
    await moveNear(source.access, 2, config.storage.localMovement, false)
    const block = bot.blockAt(source.position)
    if (!block || !['barrel', 'chest', 'trapped_chest'].includes(block.name)) continue
    let container
    try {
      container = await bot.openContainer(block)
      const available = container.containerItems()
        .filter(item => item.name === name)
        .reduce((sum, item) => sum + item.count, 0)
      const take = Math.min(available, remaining)
      if (take > 0) {
        await container.withdraw(bot.registry.itemsByName[name].id, null, take)
        remaining -= take
        console.log(`[storage] ${name}: took ${take} from level ${source.level}; need ${remaining}`)
      }
    } catch (error) {
      // This is not a material shortage.  Let acquire() clear stale stacks
      // and retry the same colour instead of reporting a fake duplicator wait.
      if (/inventory is full/i.test(error.message)) throw error
      console.warn(`[storage] cannot use ${name} level ${source.level}: ${error.message}`)
    } finally {
      container?.close()
    }
    await sleep(config.build.operationDelayMs)
  }
  return remaining
}

async function acquire(requirements) {
  await travel('material')
  await discardSurplusMaterials(requirements, 'before collecting this region')
  const deadline = Date.now() + config.materialWait.maxWaitMs
  for (const [name, desired] of Object.entries(requirements)) {
    let missing = Math.max(0, desired - inventoryCount(name))
    while (missing > 0) {
      try {
        missing = await withdrawFromColumn(name, missing)
      } catch (error) {
        if (!/inventory is full/i.test(error.message)) throw error
        const tossed = await discardSurplusMaterials(requirements, `backpack full while collecting ${name}`)
        if (tossed <= 0) {
          const carried = bot.inventory.items().map(item => `${item.name}×${item.count}`).join(', ')
          throw new Error(`Backpack is full collecting ${name}, but no surplus build material can be discarded. Carried: ${carried}`)
        }
        missing = Math.max(0, desired - inventoryCount(name))
        continue
      }
      if (missing <= 0) break
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${missing} ${name}`)
      console.log(`[storage] waiting for ${missing} ${name} from the duplicator...`)
      await sleep(config.materialWait.retryMs)
    }
  }
}

function ladderSupply() {
  const supply = config.storage.ladderSupply
  if (!supply?.itemName || !supply?.container || !supply?.access) {
    throw new Error('Missing storage.ladderSupply configuration')
  }
  return supply
}

function isProtectedUtility(name) {
  return name === config.foodChest.itemName || name === config.storage.ladderSupply?.itemName
}

async function returnUnusedLadders() {
  const supply = ladderSupply()
  const count = inventoryCount(supply.itemName)
  if (count <= 0) return
  await travel('material')
  await moveNear(supply.access, 2, config.storage.localMovement, false)
  const block = bot.blockAt(supply.container)
  if (!block || !['barrel', 'chest', 'trapped_chest'].includes(block.name)) {
    throw new Error(`Cannot return ladders: container unavailable at ${supply.container}`)
  }
  let container
  try {
    container = await bot.openContainer(block)
    const item = bot.inventory.items().find(entry => entry.name === supply.itemName)
    if (item) {
      await container.deposit(item.type, null, item.count)
      console.log(`[ladder] returned ${item.count} unused ${supply.itemName}`)
    }
  } finally {
    container?.close()
  }
}

function bestFoodItem() {
  return selectedFoodItem(bot.inventory.items(), bot.registry.foodsByName, config.foodChest.itemName)
}

async function withFoodChest(action) {
  const foodChest = config.foodChest
  await moveNear(foodChest.access, 2, config.storage.localMovement, false)
  const block = bot.blockAt(foodChest.position)
  if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) {
    throw new Error(`Food container not found at ${foodChest.position}`)
  }
  const container = await bot.openContainer(block)
  try {
    return await action(container, foodChest)
  } finally {
    container.close()
  }
}

async function borrowFoodIfNeeded() {
  if (bestFoodItem()) return
  await withFoodChest(async (container, foodChest) => {
    const available = container.containerItems()
      .filter(item => item.name === foodChest.itemName)
      .reduce((sum, item) => sum + item.count, 0)
    if (available <= 0) throw new Error(`Food chest has no ${foodChest.itemName}`)
    const take = Math.min(available, foodChest.borrowCount)
    await container.withdraw(bot.registry.itemsByName[foodChest.itemName].id, null, take)
    console.log(`[readiness] borrowed ${take} ${foodChest.itemName} from food chest`)
  })
}

async function returnUnusedFood() {
  const foodChest = config.foodChest
  const count = inventoryCount(foodChest.itemName)
  if (count <= 0) return
  await withFoodChest(async container => {
    let remaining = count
    for (const item of bot.inventory.items().filter(entry => entry.name === foodChest.itemName)) {
      if (remaining <= 0) break
      const deposit = Math.min(item.count, remaining)
      await container.deposit(item.type, null, deposit)
      remaining -= deposit
    }
    if (remaining > 0) throw new Error(`Food chest has no room for ${remaining} unused food item(s)`)
    console.log(`[readiness] returned ${count} unused ${foodChest.itemName} to food chest`)
  })
}

async function ensureReadyToWork() {
  const readiness = config.readiness
  const deadline = Date.now() + readiness.maxWaitMs
  while (bot.health < readiness.minHealth || bot.food < readiness.minFood) {
    if (Date.now() >= deadline) {
      throw new Error(`Not ready after ${readiness.maxWaitMs / 1000}s: health=${bot.health}, food=${bot.food}`)
    }
    // If hunger is not full, eat the most filling food carried by the bot.
    // Natural regeneration will then restore health while food is high.
    if (bot.food < 20) {
      await borrowFoodIfNeeded()
      const food = bestFoodItem()
      if (!food) throw new Error('Food chest did not provide an edible item')
      await bot.equip(food, 'hand')
      console.log(`[readiness] eating ${food.name}; health=${bot.health}, food=${bot.food}`)
      try {
        await bot.consume()
      } catch (error) {
        // `consume` waits for a server inventory/food update.  Under a
        // temporary TPS or packet-delay spike Mineflayer rejects that wait
        // even though the item may have been eaten server-side.  Do not
        // reconnect or abort the map job: wait for synchronization and let
        // the readiness loop re-read health/food before deciding to eat again.
        if (!/Promise timed out/i.test(error.message)) throw error
        console.warn(`[readiness] food-use confirmation timed out; waiting for server sync (health=${bot.health}, food=${bot.food})`)
        await sleep(Math.max(3_000, readiness.checkEveryMs))
        continue
      }
    }
    await sleep(readiness.checkEveryMs)
  }
  console.log(`[readiness] ready: health=${bot.health}, food=${bot.food}`)
}

function needsNutritionRefresh() {
  const monitor = config.nutritionMonitor
  return bot.food <= monitor.foodBelow || bot.health <= monitor.healthBelow
}

async function refreshNutritionAndReturnToBuild() {
  console.log(`[nutrition] low health/food detected (health=${bot.health}, food=${bot.food}); returning to material residence to recover`)
  await travel('material')
  await ensureReadyToWork()
  // Keep the food reserve while building. Returning it here used to force a
  // chest walk every time hunger dropped, which was the fragile path that
  // timed out during long jobs. Successful completion still returns food.
  console.log(`[nutrition] keeping ${inventoryCount(config.foodChest.itemName)} reserve food for later recovery`)
  await travel('build')
  await sleep(config.build.buildTeleportSettleMs)
}

function inspectTask(task) {
  const world = toWorld(task.local)
  const block = bot.blockAt(world)
  if (!block) return { status: 'unloaded', world }
  if (block.name === task.name) return { status: 'correct', world }
  if (block.name === 'air') return { status: 'empty', world }
  if (isSupported(block.name)) return { status: 'wrong_supported_block', world, block }
  return { status: 'blocked', world, block }
}

// The working first version entered one 32×32 area at the map height, built
// all of it with horizontal updates, and only then returned for materials.
// The build residence is a transit pad, not a bridge to every map layer.
async function makeLegacyRegion(plan, state, regionX, regionZ) {
  const size = config.build.regionSize
  const maxTaskX = Math.max(...plan.rows.flat().map(task => task.local.x))
  const maxTaskZ = Math.max(...plan.rows.flat().map(task => task.local.z))
  // Exact first-version region bounds.  Local x/z=0 is the 128-block
  // bootstrap edge; regular regions begin at 1, then 33, 65 and 97.
  const minX = regionX * size + 1
  const maxX = Math.min(minX + size, maxTaskX + 1)
  const minZ = regionZ * size + 1
  const maxZ = Math.min(minZ + size, maxTaskZ + 1)
  const tasks = []
  const materials = {}
  for (let z = minZ; z < maxZ; z++) {
    if (state.completedRows.includes(z)) continue
    for (const task of plan.rows[z]) {
      if (task.local.x < minX || task.local.x >= maxX || !workerOwnsTask(task)) continue
      const inspection = inspectTask(task)
      if (inspection.status === 'correct') continue
      if (inspection.status === 'blocked' && config.build.stopOnNonCarpetBlock) throw new Error(`Blocked by ${inspection.block.name} at ${inspection.world}`)
      tasks.push(task)
      materials[task.name] = (materials[task.name] || 0) + 1
    }
  }
  if (stackCount(materials) > 36 - config.build.reservedInventorySlots) throw new Error(`Region ${regionX},${regionZ} exceeds backpack capacity`)
  return { regionX, regionZ, minX, maxX, minZ, maxZ, tasks, materials }
}

const legacyRegionId = (regionX, regionZ) => `${regionX},${regionZ}`

async function nextLegacyRegion(plan, state, deferredRegions = new Map()) {
  const size = config.build.regionSize
  const maxTaskX = Math.max(...plan.rows.flat().map(task => task.local.x))
  const maxTaskZ = Math.max(...plan.rows.flat().map(task => task.local.z))
  const regionsX = Math.ceil(maxTaskX / size)
  const regionsZ = Math.ceil(maxTaskZ / size)
  for (let regionZ = 0; regionZ < regionsZ; regionZ++) {
    const firstZ = regionZ * size + 1
    const hasOpenRow = Array.from({ length: Math.min(size, maxTaskZ - firstZ + 1) }, (_, n) => firstZ + n).some(z => !state.completedRows.includes(z))
    if (!hasOpenRow) continue
    for (let regionX = 0; regionX < regionsX; regionX++) {
      if (state.completedRegions?.includes(legacyRegionId(regionX, regionZ)) || deferredRegions.has(legacyRegionId(regionX, regionZ))) continue
      const region = await makeLegacyRegion(plan, state, regionX, regionZ)
      if (region.tasks.length) return region
    }
  }
  return null
}

function mergeMaterialRequirements(...requirementsList) {
  const merged = {}
  for (const requirements of requirementsList) {
    for (const [name, count] of Object.entries(requirements)) {
      merged[name] = (merged[name] || 0) + count
    }
  }
  return merged
}

// Collect at most one neighbouring region in the same 32-row stripe. This
// removes a material-residence round trip without changing placement order,
// confirmation, or the build-residence entry sequence for either region.
async function collectCompatibleRegionGroup(plan, state, first, deferredRegions = new Map()) {
  // Two accounts already halve the map. Do not also fill each inventory with
  // two 32×32 regions: under concurrent container updates a completely full
  // backpack can report a stale missing stack midway through placement.
  const maxRegions = (workerRole === 'left' || workerRole === 'right')
    ? 1
    : Math.max(1, config.build.maxCombinedAdjacentRegions || 1)
  const usableSlots = 36 - config.build.reservedInventorySlots
  const group = [first]
  let materials = { ...first.materials }
  if (maxRegions === 1) return { regions: group, materials }

  const maxTaskX = Math.max(...plan.rows.flat().map(task => task.local.x))
  const regionsX = Math.ceil(maxTaskX / config.build.regionSize)
  for (let regionX = first.regionX + 1; regionX < regionsX && group.length < maxRegions; regionX += 1) {
    if (state.completedRegions?.includes(legacyRegionId(regionX, first.regionZ)) || deferredRegions.has(legacyRegionId(regionX, first.regionZ))) break
    const candidate = await makeLegacyRegion(plan, state, regionX, first.regionZ)
    if (candidate.tasks.length === 0) break
    const combined = mergeMaterialRequirements(materials, candidate.materials)
    if (stackCount(combined) > usableSlots) break
    group.push(candidate)
    materials = combined
  }
  return { regions: group, materials }
}

function missingInventoryRequirements(requirements) {
  return Object.entries(requirements)
    .map(([name, count]) => ({ name, count: Math.max(0, count - inventoryCount(name)) }))
    .filter(entry => entry.count > 0)
}

async function confirmAcquiredMaterials(requirements, label) {
  // Mineflayer can receive a delayed inventory packet immediately after a
  // large barrel withdrawal. Let it synchronize, then retry the *full*
  // requirements once. Passing the full set keeps already-held colours.
  await sleep(500)
  let missing = missingInventoryRequirements(requirements)
  if (missing.length === 0) return
  console.warn(`[storage] ${label}: inventory sync is short (${missing.map(item => `${item.name}×${item.count}`).join(', ')}); retrying collection before build`)
  await acquire(requirements)
  await sleep(500)
  missing = missingInventoryRequirements(requirements)
  if (missing.length > 0) {
    throw new Error(`${label}: material collection incomplete; refusing to build with missing ${missing.map(item => `${item.name}×${item.count}`).join(', ')}`)
  }
}

async function waitForExpected(world, expected) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < config.build.placeConfirmMs) {
    const block = bot.blockAt(world)
    if (block?.name === expected) return true
    await sleep(50)
  }
  return false
}

async function waitForTaskChunk(world) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < config.build.chunkLoadTimeoutMs) {
    const block = bot.blockAt(world)
    if (block) return block
    await sleep(100)
  }
  return null
}

async function moveAcrossCompletedSurface(destination) {
  const stepSize = config.movement.legacyStepSize
  let steps = 0
  while (bot.entity?.position && bot.entity.position.distanceTo(destination) > 0.3) {
    if (++steps > 512) throw new Error(`Legacy surface move exceeded 512 steps near ${destination}`)
    const current = bot.entity.position
    bot.entity.position.x = current.x + Math.max(-stepSize, Math.min(stepSize, destination.x - current.x))
    bot.entity.position.y = current.y + Math.max(-stepSize, Math.min(stepSize, destination.y - current.y))
    bot.entity.position.z = current.z + Math.max(-stepSize, Math.min(stepSize, destination.z - current.z))
    await sleep(config.movement.legacyStepDelayMs)
  }
}

// Keep the first version's actual placement sequence intact. The surrounding
// v2 features handle litematic conversion, containers and checkpointing; this
// function deliberately does not add pathfinding, chunk waits, or per-block
// confirmation between the coordinate write and place packet.
async function placeTaskLegacyOriginal(task, state, justEnteredRegion = false, positionBeforeMove = null, safeSupportPosture = false) {
  if (stopping) return 'stopped'
  const world = toWorld(task.local)
  if (!justEnteredRegion) {
    const isBootstrapBorder = world.z === config.sites.build.origin.z && world.y === config.sites.build.origin.y
    if (isBootstrapBorder) {
      bot.entity.position.x = world.x - 0.5
      bot.entity.position.z = world.z + 0.5
    } else {
      // Exact first-version region behaviour: after entry, update X/Z only.
      bot.entity.position.x = world.x + 0.5
      bot.entity.position.z = world.z + 0.5
    }
    await sleep(config.movement.legacyHoverDelayMs)
  }

  const existing = bot.blockAt(world)
  if (existing && existing.name !== 'air') return existing.name === task.name ? 'correct' : 'occupied'
  // Exact first-version region correction. The original captures botPos
  // before its X/Z write, then raises one block only for this posture.
  if (positionBeforeMove &&
    Math.floor(positionBeforeMove.x) === world.x &&
    Math.floor(positionBeforeMove.y) === world.y - 1 &&
    Math.floor(positionBeforeMove.z) === world.z) {
    bot.entity.position.y += 1
  }
  const reference = bot.blockAt(world.offset(0, -1, 0))
  if (!reference || reference.name === 'air') return 'missing_support'
  for (let attempt = 1; attempt <= config.build.placeRetries; attempt++) {
    if (stopping) throw new Error('Build interrupted by death or disconnect')
    try {
      // Keep the already-established support-row posture on retries. Moving
      // to the target here makes the bot stand in the cell it is trying to
      // place and drops it off the one-block-high build position.
      if (attempt > 1) {
        await sleep(1_000)
      }
      // Inventory stacks can merge or disappear after prior placements. Fetch
      // the current stack on every attempt instead of equipping a stale slot.
      const item = bot.inventory.items().find(entry => entry.name === task.name)
      if (!item) throw new Error(`Missing ${task.name} while building at ${world}; stopped before continuing this region`)
      // Equipping the same carpet again emits an unnecessary inventory packet
      // for every block. Reuse the held stack across a same-colour run; the
      // next placement still waits for Mineflayer's server block update, so
      // this speeds only redundant inventory work and does not skip checks.
      if (!bot.heldItem || bot.heldItem.name !== task.name) {
        await bot.equip(item, 'hand')
      }
      if (!bot.heldItem || bot.heldItem.name !== task.name) {
        throw new Error(`failed to hold ${task.name}`)
      }
      await bot.placeBlock(reference, new Vec3(0, 1, 0))
      return 'placed'
    } catch (error) {
      if (stopping) throw new Error(`Build interrupted by death or disconnect while placing at ${world}: ${error.message}`)
      const current = bot.entity?.position
      const dualHalf = workerRole === 'left' || workerRole === 'right'
      const usesSupportPosture = dualHalf || safeSupportPosture
      const stand = world.offset(0, 0, -1)
      const standBlock = usesSupportPosture ? bot.blockAt(stand) : null
      const expectedX = usesSupportPosture ? stand.x + 0.5 : world.x + 0.5
      const expectedZ = usesSupportPosture ? stand.z + 0.5 : world.z + 0.5
      // A carpet's top is at block Y + 1/16, not Y + 1. Falling from the
      // temporary Y+1 entry posture onto a completed carpet is valid here:
      // the bot remains beside the target and can still click its support.
      const minimumFeetY = usesSupportPosture && standBlock?.name.endsWith('_carpet')
        ? stand.y + 0.0625 - 0.12
        : world.y + 1 - 0.12
      if (current && (Math.hypot(current.x - expectedX, current.z - expectedZ) > (usesSupportPosture ? 2 : 6) ||
        current.y < minimumFeetY || current.y > world.y + 1.5 ||
        (usesSupportPosture && (!standBlock || standBlock.name === 'air')))) {
        throw new Error(`Lost safe placement position for ${workerLabel}: current=${current}, target=${world}, previous-row block=${standBlock?.name || 'unloaded'}; original placement error: ${error.message}`)
      }
      if (error.message.startsWith('Missing ')) throw error
      // On this server Mineflayer can time out waiting for blockUpdate even
      // after the placement packet reached the server.  Inspect the actual
      // target before declaring the legacy placement failed.
      if (await waitForExpected(world, task.name)) return 'placed'
      if (attempt === config.build.placeRetries) {
        console.warn(`[legacy] ${task.name} at ${world}: ${error.message}; support=${reference.name}; bot=${bot.entity?.position}`)
        break
      }
      await sleep(1_000) // same retry cadence as the supplied first version
    }
  }
  state.blocked.push({ position: key(world), expected: task.name, reason: 'legacy_place_failed' })
  return 'place_failed'
}

async function verifyAndCheckpointRegion(plan, state, region) {
  const regionTasks = plan.rows.slice(region.minZ, region.maxZ)
    .flat()
    .filter(task => task.local.x >= region.minX && task.local.x < region.maxX && workerOwnsTask(task))
  const incorrect = regionTasks.find(task => inspectTask(task).status !== 'correct')
  if (incorrect) throw new Error(`Region ${region.regionX},${region.regionZ} verification failed at ${toWorld(incorrect.local)}`)

  state.completedRegions = [...new Set([...(state.completedRegions || []), legacyRegionId(region.regionX, region.regionZ)])]
  const size = config.build.regionSize
  const rowRegionIds = new Set(
    plan.rows.slice(region.minZ, region.maxZ).flat()
      .filter(workerOwnsTask)
      .map(task => legacyRegionId(Math.floor((task.local.x - 1) / size), region.regionZ))
  )
  const rowStripeDone = [...rowRegionIds].every(id => state.completedRegions.includes(id))
  if (rowStripeDone) {
    for (let z = region.minZ; z < region.maxZ; z++) {
      if (!state.completedRows.includes(z)) {
        state.completedRows.push(z)
        state.lastCompletedRow = z
        console.log(`[build] row ${z} complete (0 unresolved)`)
      }
    }
  }
  state.completedRows = [...new Set(state.completedRows)].sort((a, b) => a - b)
  await writeState(state)
}

async function buildLegacyRegion(plan, state, region, deferredOccupied = new Map(), allowDeferred = true) {
  await travel('build')
  await sleep(config.build.buildTeleportSettleMs)
  let lastZ = null
  let failures = 0
  let deferredInRegion = 0
  // Complete one row, then immediately return along the next row.  This
  // avoids a needless 32-block run back to the same edge between rows.
  const ordered = [...region.tasks].sort((a, b) => {
    if (a.local.z !== b.local.z) return a.local.z - b.local.z
    const forward = (a.local.z - region.minZ) % 2 === 0
    return forward ? a.local.x - b.local.x : b.local.x - a.local.x
  })
  if (ordered.length === 0) return verifyAndCheckpointRegion(plan, state, region)
  // Face 0 uses the original direct coordinate entry. Every later face first
  // enters face 0, then advances one block at a time across completed rows.
  // The dth landing only gets the bot into the world; it is not a build anchor.
  const enterRegion = async first => {
    // A resumed dual worker may first need a block in the middle of a region.
    // Jumping there directly from the residence landing was rejected for both
    // accounts. Enter at the completed first face and advance in short steps.
    if (region.regionZ === 0 && (workerRole === 'left' || workerRole === 'right') &&
      (first.local.z > 1 || first.local.x > region.minX)) {
      return enterRegionViaFirstFaceLegacyWalk(first)
    }
    if (region.regionZ === 0) return enterRegionViaLegacyCoordinates(first)
    return enterRegionViaFirstFaceLegacyWalk(first)
  }
  await enterRegion(ordered[0])
  for (let taskIndex = 0; taskIndex < ordered.length; taskIndex++) {
    const task = ordered[taskIndex]
    if (stopping) throw new Error('Build interrupted by death or disconnect')
    if (needsNutritionRefresh()) {
      await refreshNutritionAndReturnToBuild()
      await enterRegion(ordered[taskIndex])
    }
    const world = toWorld(task.local)
    const beforeMove = bot.entity.position.clone()
    // Single mode keeps the original target-column sequence. In dual mode,
    // Place from the completed row immediately behind the target so the bot
    // does not occupy the cell it is trying to fill. Let its feet settle on
    // the carpet top; repeatedly writing Y+1 makes it visibly hop each block.
    const dualHalf = workerRole === 'left' || workerRole === 'right'
    const stand = dualHalf
      ? toWorld(new Vec3(task.local.x, task.local.y, task.local.z - 1))
      : world
    if (dualHalf && lastZ !== task.local.z) {
      const walkway = await waitForTaskChunk(stand)
      if (!walkway || walkway.name === 'air') {
        throw new Error(`Completed support row is missing at ${stand}; stopped before placing at ${world}`)
      }
    }
    const crossedRegion = stand.x - beforeMove.x > 30 || stand.z - beforeMove.z > 30
    bot.entity.position.x = stand.x + 0.5
    if (crossedRegion) await sleep(200)
    bot.entity.position.z = stand.z + 0.5
    if (lastZ !== task.local.z) {
      await sleep(50)
      lastZ = task.local.z
    }
    const result = await placeTaskLegacyOriginal(task, state, true, beforeMove)
    if (result === 'occupied' && allowDeferred) {
      const inspection = inspectTask(task)
      if (inspection.status === 'correct') continue
      if (config.build.replaceWrongSupportedBlock && task.name.endsWith('_carpet') &&
        inspection.status === 'wrong_supported_block' && inspection.block.name.endsWith('_carpet')) {
        const localKey = key(task.local)
        const configuredLimit = config.build.maxDeferredWrongCarpets
        const limit = Number.isInteger(configuredLimit) && configuredLimit >= 0 ? Math.min(99, configuredLimit) : 99
        if (!deferredOccupied.has(localKey) && deferredOccupied.size >= limit) {
          throw new Error(`Deferred wrong-carpet limit ${limit} reached at ${world}; stopped without breaking blocks`)
        }
        deferredOccupied.set(localKey, task)
        deferredInRegion++
        console.warn(`[build] deferred wrong carpet at ${world}: expected=${task.name}, actual=${inspection.block.name}; will repair after laying the remaining regions`)
        await sleep(config.build.operationDelayMs)
        continue
      }
      throw new Error(`Unsafe occupied target at ${world}: expected=${task.name}, actual=${inspection.block?.name || inspection.status}; automatic removal refused`)
    }
    if (!['placed', 'correct'].includes(result)) {
      failures++
      console.warn(`[build] skipped ${task.name} at local ${task.local}: ${result}`)
    }
    await sleep(config.build.operationDelayMs)
  }
  if (failures > 0) throw new Error(`Region ${region.regionX},${region.regionZ} has ${failures} unresolved blocks; progress was not advanced`)
  if (deferredInRegion > 0) {
    console.log(`[build] region ${region.regionX},${region.regionZ} laid with ${deferredInRegion} deferred wrong carpet(s); checkpoint waits for repair`)
    return 'deferred'
  }
  await verifyAndCheckpointRegion(plan, state, region)
  return 'complete'
}

// Retained only for the first-version repair compatibility path.
async function enterRegionViaLegacyCoordinates(first) {
  const support = toWorld(new Vec3(first.local.x, first.local.y, first.local.z - 1))
  bot.entity.position.x = support.x + 0.5
  bot.entity.position.y = support.y + 1
  bot.entity.position.z = support.z + 0.5
  await sleep(config.movement.legacyBatchEntryDelayMs)
  console.log(`[movement] initial-version direct entry at ${bot.entity.position}`)
}

// Later faces always enter through local (1,0,1), the first-face anchor. They
// then replay one-block initial-version coordinate writes across completed rows;
// this is not a ladder route and does not call pathfinder.
async function enterRegionViaFirstFaceLegacyWalk(first) {
  const entry = { local: new Vec3(1, first.local.y, 1) }
  await enterRegionViaLegacyCoordinates(entry)
  const supportLocal = new Vec3(first.local.x, first.local.y, first.local.z - 1)
  const entrySupport = new Vec3(1, first.local.y, 0)
  const horizontalSteps = Math.abs(supportLocal.x - entrySupport.x)
  const forwardSteps = Math.abs(supportLocal.z - entrySupport.z)
  console.log(`[movement] initial-version walking from first-face entry to completed row ${supportLocal.z} (${horizontalSteps + forwardSteps} short steps)`)
  const stepDelay = config.movement.legacyStepDelayMs
  const xDirection = Math.sign(supportLocal.x - entrySupport.x)
  for (let x = entrySupport.x; x !== supportLocal.x; x += xDirection) {
    const next = toWorld(new Vec3(x + xDirection, first.local.y, 0))
    bot.entity.position.x = next.x + 0.5
    await sleep(stepDelay)
  }
  const zDirection = Math.sign(supportLocal.z - entrySupport.z)
  for (let z = entrySupport.z; z !== supportLocal.z; z += zDirection) {
    const next = toWorld(new Vec3(supportLocal.x, first.local.y, z + zDirection))
    const walkway = await waitForTaskChunk(next)
    if (!walkway || walkway.name === 'air') {
      throw new Error(`Completed route has a gap at ${next}; stopped before crossing it`)
    }
    bot.entity.position.z = next.z + 0.5
    await sleep(stepDelay)
  }
  await sleep(config.movement.legacyBatchEntryDelayMs)
  const reached = bot.entity?.position
  const support = toWorld(supportLocal)
  const supportBlock = bot.blockAt(support)
  const minimumFeetY = supportBlock?.name.endsWith('_carpet')
    ? support.y + 0.0625 - 0.12
    : support.y + 1 - 0.12
  if (!reached || !supportBlock || supportBlock.name === 'air' ||
    Math.hypot(reached.x - support.x - 0.5, reached.z - support.z - 0.5) > 2 ||
    reached.y < minimumFeetY || reached.y > support.y + 1.5) {
    throw new Error(`Build entry left the completed route: current=${reached || 'unknown'}, support=${supportBlock?.name || 'unloaded'} at ${support}; stopped before placement`)
  }
}
function pendingBootstrapTasks(plan, state) {
  return plan.rows[0].filter(task => !state.completedRows.includes(0) && inspectTask(task).status !== 'correct')
}

function bootstrapRequirements(tasks) {
  const materials = {}
  for (const task of tasks) materials[task.name] = (materials[task.name] || 0) + 1
  return materials
}

async function buildLegacyBootstrap(plan, state, materialsAlreadyCollected = false) {
  if (!materialsAlreadyCollected) {
    // Count from the schematic, not from blockAt() while the map chunks are
    // still unloaded at the material residence. Any unused smooth stone is ordinary leftover
    // material and is handled by the existing completion cleanup.
    await acquire(bootstrapRequirements(plan.rows[0]))
    await travel('build')
    await sleep(config.build.buildTeleportSettleMs)
  }
  const tasks = pendingBootstrapTasks(plan, state)
  if (tasks.length === 0) {
    if (!state.completedRows.includes(0)) {
      state.completedRows.push(0)
      state.completedRows.sort((a, b) => a - b)
      await writeState(state)
    }
    return
  }
  console.log(`[build] initial smooth-stone edge: using original coordinate placement for ${tasks.length} block(s)`)
  for (const task of tasks.sort((a, b) => a.local.x - b.local.x)) {
    const world = toWorld(task.local)
    // The original builder places the vertically stacked first edge from the
    // layer below. It does not require a completed Y+1 standing surface.
    bot.entity.position.x = world.x - 0.5
    bot.entity.position.y = world.y + 1
    bot.entity.position.z = world.z + 0.5
    const result = await placeTaskLegacyOriginal(task, state, true)
    if (!['placed', 'correct'].includes(result)) throw new Error(`Initial smooth-stone edge failed at ${world}: ${result}`)
  }
  state.completedRows.push(0)
  state.completedRows = [...new Set(state.completedRows)].sort((a, b) => a - b)
  await writeState(state)
  console.log('[build] initial smooth-stone edge complete')
}

async function handleLeftovers() {
  const leftovers = Object.fromEntries(
    config.SUPPORTED_BLOCKS.map(name => [name, inventoryCount(name)]).filter(([, count]) => count > 0)
  )
  if (Object.keys(leftovers).length === 0) return
  await travel('material')
  const mode = config.storage.leftovers?.mode || 'return'
  if (mode === 'toss_into_void') {
    const disposal = config.storage.leftovers
    if (!disposal.stand || disposal.facing !== 'west') {
      throw new Error('Void disposal requires a west-facing safe stand coordinate')
    }
    await moveNear(disposal.stand, 1.2, config.storage.localMovement)
    // Items are ejected in the direction the bot is facing. The west side of
    // 37485,90,13886 must remain open to the void.
    await bot.lookAt(disposal.stand.offset(-3, 0.5, 0), true)
    for (const [name, count] of Object.entries(leftovers)) {
      const item = bot.inventory.items().find(entry => entry.name === name)
      if (!item) continue
      try {
        await bot.toss(item.type, null, Math.min(item.count, count))
        console.log(`[leftovers] tossed ${Math.min(item.count, count)} ${name} west into the void`)
      } catch (error) {
        console.warn(`[leftovers] could not toss ${name}: ${error.message}`)
      }
      await sleep(config.build.operationDelayMs)
    }
    return
  }
  if (mode !== 'return') throw new Error(`Unknown leftovers mode: ${mode}`)
  for (const [name, count] of Object.entries(leftovers)) {
    let remaining = count
    for (const source of sourceLevels(name)) {
      if (remaining <= 0) break
      await moveNear(source.access, 2, config.storage.localMovement, false)
      const block = bot.blockAt(source.position)
      if (!block || !['barrel', 'chest', 'trapped_chest'].includes(block.name)) continue
      let container
      try {
        container = await bot.openContainer(block)
        const item = bot.inventory.items().find(entry => entry.name === name)
        if (item) {
          const deposit = Math.min(item.count, remaining)
          await container.deposit(item.type, null, deposit)
          remaining -= deposit
        }
      } catch (error) {
        console.warn(`[storage] could not return ${name}: ${error.message}`)
      } finally {
        container?.close()
      }
    }
  }
}

function auditReportPath() {
  if (!activeStatePath?.endsWith('.job-state.json')) throw new Error('Audit requires a valid initialized state path')
  return activeStatePath.replace(/\.job-state\.json$/, '.audit.json')
}

async function auditPlan(plan) {
  await travel('build')
  await sleep(config.build.buildTeleportSettleMs)
  // Match the initial builder's chunk-loading route. Unlike construction, this
  // only reads blocks and must not require a ladder rung on the new layer.
  const report = {
    version: 1, generatedAt: new Date().toISOString(), schematicPath: config.schematicPath,
    origin: config.sites.build.origin, checked: 0, correct: 0, missing: [], wrong: [], unloaded: []
  }
  for (let rowIndex = 0; rowIndex < plan.rows.length; rowIndex++) {
    const row = plan.rows[rowIndex]
    if (stopping) throw new Error('Audit interrupted by death or disconnect')
    const adjacentZ = rowIndex > 0 ? rowIndex - 1 : Math.min(rowIndex + 1, plan.rows.length - 1)
    const probe = toWorld(new Vec3(Math.floor(plan.width / 2), 0, adjacentZ)).offset(0.5, 1, 0.5)
    await moveAcrossCompletedSurface(probe)
    await waitForChunks()
    for (const task of row) {
      const world = toWorld(task.local)
      const block = bot.blockAt(world)
      const entry = { local: task.local, world, expected: task.name, actual: block?.name || null }
      report.checked++
      if (!block) report.unloaded.push(entry)
      else if (block.name === task.name) report.correct++
      else if (block.name === 'air') report.missing.push(entry)
      else report.wrong.push(entry)
    }
  }
  await writeAuditReport(auditReportPath(), report)
  console.log(`[audit] checked=${report.checked}, correct=${report.correct}, missing=${report.missing.length}, wrong=${report.wrong.length}, unloaded=${report.unloaded.length}`)
  console.log(`[audit] report: ${auditReportPath()}`)
  return report
}

function assertDeferredRepairStand(support, label) {
  const block = bot.blockAt(support)
  const position = bot.entity?.position
  const minimumFeetY = block?.name.endsWith('_carpet')
    ? support.y + 0.0625 - 0.12
    : support.y + 1 - 0.12
  if (!position || !block || !isSupported(block.name) ||
    Math.hypot(position.x - support.x - 0.5, position.z - support.z - 0.5) > 0.8 ||
    position.y < minimumFeetY || position.y > support.y + 1.5) {
    throw new Error(`Deferred repair left the completed route ${label}: current=${position || 'unknown'}, support=${block?.name || 'unloaded'} at ${support}; stopped before digging`)
  }
}

// Deferred repairs share one careful route instead of replaying the long
// first-face entry for every nearby wrong-colour carpet. Validate every step
// after the server has had time to update the bot's actual position.
async function moveDeferredRepairToSupport(fromLocal, toLocal) {
  const delay = Math.max(120, config.movement.legacyStepDelayMs)
  const from = toWorld(fromLocal)
  assertDeferredRepairStand(from, 'before moving')
  let x = fromLocal.x
  let z = fromLocal.z
  while (x !== toLocal.x || z !== toLocal.z) {
    if (stopping) throw new Error('Deferred repair interrupted while moving')
    const nextX = x !== toLocal.x ? x + Math.sign(toLocal.x - x) : x
    const nextZ = x !== toLocal.x ? z : z + Math.sign(toLocal.z - z)
    const next = toWorld(new Vec3(nextX, toLocal.y, nextZ))
    const walkway = await waitForTaskChunk(next)
    if (!walkway || !isSupported(walkway.name)) throw new Error(`Deferred repair route is not a supported block at ${next}; stopped before crossing it`)
    if (nextX !== x) bot.entity.position.x = next.x + 0.5
    else bot.entity.position.z = next.z + 0.5
    await sleep(delay)
    assertDeferredRepairStand(next, 'after a short step')
    x = nextX
    z = nextZ
  }
}

async function repairOneTaskViaLegacyCoordinates(task, edge, carpetOnly = false, positionedOnSupport = false) {
  if (stopping) throw new Error('Repair interrupted by death or disconnect')
  const world = toWorld(task.local)
  if (edge) {
    // Match the already-working first smooth-stone edge placement posture.
    bot.entity.position.x = world.x - 0.5
    bot.entity.position.y = world.y + 1
    bot.entity.position.z = world.z + 0.5
  } else {
    // Match normal region entry: row 1 is entered directly; later rows first
    // enter face 0 and cross the completed rows in short coordinate steps.
    if (!positionedOnSupport) {
      if (task.local.z === 1) await enterRegionViaLegacyCoordinates(task)
      else await enterRegionViaFirstFaceLegacyWalk(task)
    }
    const support = world.offset(0, 0, -1)
    const supportBlock = await waitForTaskChunk(support)
    if (!supportBlock || supportBlock.name === 'air') {
      throw new Error(`Repair route has no completed support row at ${support}`)
    }
    // Deferred carpet repair must never dig the block under the bot, even in
    // single mode. The completed row behind the target is the safe stand.
    const stand = carpetOnly || workerRole === 'left' || workerRole === 'right' ? support : world
    if (positionedOnSupport) {
      assertDeferredRepairStand(support, 'before digging')
    } else {
      bot.entity.position.x = stand.x + 0.5
      bot.entity.position.z = stand.z + 0.5
      await sleep(50)
    }
  }
  let inspection = inspectTask(task)
  if (inspection.status === 'correct') return
  if (carpetOnly) {
    if (!task.name.endsWith('_carpet') ||
      (inspection.status !== 'empty' &&
        (inspection.status !== 'wrong_supported_block' || !inspection.block.name.endsWith('_carpet')))) {
      throw new Error(`Deferred repair found unsafe ${inspection.block?.name || inspection.status} at ${world}; removal refused`)
    }
    const floor = await waitForTaskChunk(world.offset(0, -1, 0))
    if (!floor || floor.name === 'air') throw new Error(`Deferred repair has no support under ${world}; removal refused`)
  }
  if (inspection.status === 'wrong_supported_block') {
    if (!config.build.replaceWrongSupportedBlock) {
      throw new Error(`Repair found wrong ${inspection.block.name} at ${world}; replacement is disabled`)
    }
    try {
      await bot.dig(inspection.block, true)
    } catch (error) {
      if (!await waitForExpected(world, 'air')) throw new Error(`Repair could not remove wrong block at ${world}: ${error.message}`)
    }
    if (!await waitForExpected(world, 'air')) throw new Error(`Repair removal was not confirmed at ${world}`)
    inspection = inspectTask(task)
  }
  if (inspection.status !== 'empty') {
    throw new Error(`Repair blocked by ${inspection.block?.name || inspection.status} at ${world}`)
  }
  const result = await placeTaskLegacyOriginal(task, { blocked: [] }, true, null, carpetOnly)
  if (!['placed', 'correct'].includes(result) || !await waitForExpected(world, task.name)) {
    throw new Error(`Repair placement was not confirmed at ${world}: ${result}`)
  }
  console.log(`[repair] confirmed ${task.name} at ${world}`)
}

async function repairFromAudit(plan, report) {
  if (report.unloaded.length > 0) throw new Error('Audit has unloaded blocks; repair is intentionally refused')
  const issues = [...report.missing, ...report.wrong]
  if (issues.length === 0) return
  const taskByLocal = new Map(plan.rows.flat().map(task => [key(task.local), task]))
  const tasks = issues.map(issue => taskByLocal.get(key(issue.local))).filter(Boolean)
  if (tasks.length !== issues.length) throw new Error('Audit contains a position outside the schematic; repair refused')
  if (report.wrong.some(issue => !isSupported(issue.actual))) {
    throw new Error('Audit found an unsupported obstructing block; repair refused before collecting materials')
  }
  const requirements = {}
  for (const task of tasks) requirements[task.name] = (requirements[task.name] || 0) + 1
  if (stackCount(requirements) > 36 - config.build.reservedInventorySlots) throw new Error(`Repair needs too many inventory slots (${tasks.length} blocks)`)
  await acquire(requirements)
  await confirmAcquiredMaterials(requirements, 'repair')
  await travel('build')
  await sleep(config.build.buildTeleportSettleMs)
  for (const task of tasks.sort((a, b) => a.local.z - b.local.z || a.local.x - b.local.x)) {
    await repairOneTaskViaLegacyCoordinates(task, task.local.z === 0)
  }
}

async function repairDeferredOccupied(plan, state, deferredRegions, deferredOccupied) {
  if (deferredOccupied.size === 0) return
  const tasks = [...deferredOccupied.values()].sort((a, b) => a.local.z - b.local.z || a.local.x - b.local.x)
  const requirements = {}
  for (const task of tasks) requirements[task.name] = (requirements[task.name] || 0) + 1
  if (stackCount(requirements) > 36 - config.build.reservedInventorySlots) {
    throw new Error(`Deferred carpet repair needs too many inventory slots (${tasks.length} blocks)`)
  }
  console.log(`[repair] starting ${tasks.length} deferred wrong-carpet replacement(s) after laying the remaining regions`)
  if (missingInventoryRequirements(requirements).length > 0) {
    console.log('[repair] collecting missing carpet colours before the deferred pass')
    await acquire(requirements)
    await confirmAcquiredMaterials(requirements, 'deferred carpet repair')
  }
  // Reset to the known build residence once. Enter the first face only once,
  // then walk between nearby completed support rows at a verified pace.
  await travel('build')
  await sleep(config.build.buildTeleportSettleMs)
  const firstFaceSupport = new Vec3(1, tasks[0].local.y, 0)
  await enterRegionViaLegacyCoordinates({ local: new Vec3(1, tasks[0].local.y, 1) })
  let currentSupport = firstFaceSupport
  for (const task of tasks) {
    const targetSupport = new Vec3(task.local.x, task.local.y, task.local.z - 1)
    await moveDeferredRepairToSupport(currentSupport, targetSupport)
    await repairOneTaskViaLegacyCoordinates(task, false, true, true)
    currentSupport = targetSupport
  }
  for (const region of deferredRegions.values()) {
    console.log(`[repair] rechecking deferred region ${region.regionX},${region.regionZ} before checkpoint`)
    await buildLegacyRegion(plan, state, region, new Map(), false)
  }
  console.log(`[repair] ${tasks.length} deferred wrong-carpet position(s) repaired and their regions checked`)
}

async function waitForDualStartGate() {
  const gate = process.env.MAPART_DUAL_GATE
  if (!gate) return
  console.log(`[dual] ${workerLabel} logged in; waiting for the two-account start gate`)
  while (!stopping) {
    try {
      await fs.access(gate)
      console.log(`[dual] ${workerLabel} start gate opened`)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await sleep(500)
  }
  throw new Error('Stopped while waiting for the two-account start gate')
}
async function run() {
  await applyDashboardJob()
  if (config.sites.build.rotation !== 0) throw new Error('Only the original 0-degree schematic direction is supported')
  await verifyDashboardProjectionIntegrity()
  const plan = await loadPlan()
  const state = await readState(plan)
  console.log(`[worker] ${workerLabel}; owns ${workerRole === 'left' ? 'local X=1..64' : workerRole === 'right' ? 'local X=65..128' : workerRole === 'bootstrap' ? 'only the full smooth-stone edge' : 'the full map'}`)
  // No matter where the account logged out, always reset at the permanent
  // material residence before calculating materials or starting construction.
  await travel('material')
  await ensureReadyToWork()
  // Do not open the food chest just to return leftovers immediately after
  // spawn. On this server that container request can stall the entire
  // residence interaction while both accounts are loading. Food is harmless
  // in the reserved inventory slots and is returned after successful work.
  console.log('[readiness] keeping unused food during startup; food-chest return deferred')
  await waitForDualStartGate()
  if (taskMode === 'verify') {
    await auditPlan(plan)
    return
  }
  if (taskMode === 'repair') {
    const before = await auditPlan(plan)
    await repairFromAudit(plan, before)
    const after = await auditPlan(plan)
    if (after.missing.length || after.wrong.length || after.unloaded.length) throw new Error('Repair finished with remaining audit issues')
    console.log('[repair] audit passed after repair')
    return
  }
  if (taskMode !== 'build') throw new Error(`Unknown mode: ${taskMode}`)
  // Bootstrap is deliberately a separate right-account phase in dual mode.
  // It alone writes the full smooth-stone edge, then exits before either half starts.
  if (workerRole === 'bootstrap') {
    if (!state.completedRows.includes(0)) {
      await acquire(bootstrapRequirements(plan.rows[0]))
      await travel('build')
      await sleep(config.build.buildTeleportSettleMs)
      await buildLegacyBootstrap(plan, state, true)
    }
    console.log('[dual] right bootstrap completed; safe to start left/right carpet workers')
    return
  }
  // Each half has its own state file, but both may rely on the shared edge.
  if ((workerRole === 'left' || workerRole === 'right') && !state.completedRows.includes(0)) {
    await travel('build')
    await sleep(config.build.buildTeleportSettleMs)
    const missingEdge = plan.rows[0].find(task => inspectTask(task).status !== 'correct')
    if (missingEdge) throw new Error(`[dual] smooth-stone bootstrap is not complete at ${toWorld(missingEdge.local)}; left/right workers were not started`)
    state.completedRows.push(0)
    state.completedRows.sort((a, b) => a - b)
    await writeState(state)
    console.log('[dual] shared smooth-stone edge confirmed')
  }
  // Normal region entry starts from the completed first face and no longer
  // borrows or requires a top ladder for this map layer.
  let bootstrapEnteredBuild = false
  if (!state.completedRows.includes(0)) {
    // `blockAt()` cannot tell which edge blocks are missing while the map is
    // unloaded at the material residence. Carry one schematic-sized edge supply instead of
    // making a stale remote scan decide that only one block is needed.
    await acquire(bootstrapRequirements(plan.rows[0]))
    await travel('build')
    await sleep(config.build.buildTeleportSettleMs)
    await buildLegacyBootstrap(plan, state, true)
    bootstrapEnteredBuild = true
  }
  if (!bootstrapEnteredBuild) {
    await travel('build')
    await sleep(config.build.buildTeleportSettleMs)
  }
  const deferredRegions = new Map()
  const deferredOccupied = new Map()
  while (!stopping) {
    const region = await nextLegacyRegion(plan, state, deferredRegions)
    if (!region) break
    const group = await collectCompatibleRegionGroup(plan, state, region, deferredRegions)
    const labels = group.regions.map(item => `${item.regionX},${item.regionZ}`).join(' + ')
    console.log(`[storage] collecting materials for region group ${labels} (${stackCount(group.materials)} usable stack slot(s))`)
    await acquire(group.materials)
    await confirmAcquiredMaterials(group.materials, `region group ${labels}`)
    for (const item of group.regions) {
      console.log(`[build] starting initial-version region ${item.regionX},${item.regionZ}: X(${item.minX}-${item.maxX - 1}), Z(${item.minZ}-${item.maxZ - 1})`)
      const outcome = await buildLegacyRegion(plan, state, item, deferredOccupied)
      if (outcome === 'deferred') deferredRegions.set(legacyRegionId(item.regionX, item.regionZ), item)
    }
  }
  if (stopping) throw new Error('Build interrupted before deferred carpet repair')
  await repairDeferredOccupied(plan, state, deferredRegions, deferredOccupied)
  if (config.build.autoAuditAfterBuild && workerRole === 'single') {
    console.log('[audit] starting automatic final read-only audit')
    const report = await auditPlan(plan)
    const issues = report.missing.length + report.wrong.length + report.unloaded.length
    if (issues > 0) {
      throw new Error(
        `Automatic final audit did not pass: missing=${report.missing.length}, ` +
        `wrong=${report.wrong.length}, unloaded=${report.unloaded.length}. ` +
        `See ${auditReportPath()}`
      )
    }
    console.log('[audit] automatic final audit passed')
  }
  if (workerRole === 'left' || workerRole === 'right') console.log('[dual] half-map worker finished; run the dashboard full verification after both halves complete.')
  // A passed full-map audit is the completion boundary. Storage cleanup is
  // useful but must never turn a verified finished map into a failed job just
  // because a barrel path is temporarily blocked or unloaded.
  for (const [label, action] of [
    ['returning unused food', returnUnusedFood],
    ['returning unused ladders', returnUnusedLadders],
    ['handling leftover build materials', handleLeftovers]
  ]) {
    try {
      await action()
    } catch (error) {
      console.warn(`[cleanup] ${label} was skipped: ${error.message}`)
    }
  }
  console.log('Map-art task finished.')
}

function createBot() {
  if (process.env.MAPART_AUTH_LEGACY !== '1') {
    config.connection.auth = require('./right_auth_sisu').makeSisuAuth(config.connection, __dirname)
    console.log(`[auth] ${workerLabel} uses isolated Sisu authentication`)
  }
  bot = mineflayer.createBot(config.connection)
  bot.loadPlugin(pathfinder)
  bot.once('spawn', async () => {
    const movements = new Movements(bot)
    movements.canDig = false
    movements.allow1by1towers = false
    bot.pathfinder.setMovements(movements)
    if (stopping) return
    // The server has rejected Mineflayer's creative hover packet immediately
    // after spawn (multiplayer.disconnect.flying). Normal construction uses
    // coordinate entry for both normal builds and repairs; neither needs a ladder.
    console.log('[network] spawn received; initial-version coordinate entry enabled (no ladder required)')
    try {
      const expectedMinecraftName = config.connection.expectedMinecraftName
      if (expectedMinecraftName) {
        const actualMinecraftName = bot.username || '(unknown)'
        console.log(`[identity] ${workerLabel} authenticated as ${actualMinecraftName}; expected ${expectedMinecraftName}`)
        if (actualMinecraftName.toLowerCase() !== expectedMinecraftName.toLowerCase()) {
          throw new Error(`Wrong Microsoft account for ${workerLabel}: authenticated as ${actualMinecraftName}, expected ${expectedMinecraftName}. Run npm.cmd run login-left and sign in to the account owning ${expectedMinecraftName}.`)
        }
      }
      // Do not force a residence teleport on every login.  That was added
      // after the original builder and can make the residence plugin/chunks
      // stall both accounts.  Stay completely still while the login packets
      // settle; run() will issue /res tp only when the current position is
      // actually outside the material residence.
      console.log(`[network] settling ${config.startup.afterHoverMs}ms with no movement or teleport`)
      await sleep(config.startup.afterHoverMs)
      if (stopping) return
      await run()
      stopping = true
      bot.quit(`map-art ${taskMode} finished`)
    } catch (error) {
      if (stopping) {
        process.exitCode = 1
        console.error(`[safety] work interrupted and stopped: ${error.message}`)
        return
      }
      console.error(`[fatal] ${error.stack || error.message}`)
      process.exitCode = 1
      stopping = true
      bot.quit('map-art bot stopped safely; inspect console and the state directory')
    }
  })
  bot.on('kicked', reason => {
    const message = formatServerReason(reason)
    console.error(`[kicked] ${message}`)
    stopping = true
    process.exitCode = 1
    if (message.includes('multiplayer.disconnect.invalid_player_movement')) {
      console.error('[safety] server rejected the account position; reconnect disabled')
    }
  })
  bot.on('error', error => {
    stopping = true
    // A socket reset is a failed run even though Mineflayer may otherwise let
    // Node exit with status 0.  Surface it accurately in the dashboard.
    process.exitCode = 1
    console.error(`[network] ${error.message}; stopped without reconnecting`)
  })
  bot.on('death', () => {
    // Do not reconnect or resume a build after death. First ask Minecraft for
    // one ordinary respawn so an account saved in the void is no longer stuck
    // there on its next login.
    deathRecoveryPending = true
    stopping = true
    console.error(`[safety] bot died at ${bot.entity?.position || 'unknown position'}; requesting Minecraft respawn`)
    setTimeout(() => {
      if (!deathRecoveryPending || !bot?.respawn) return
      try { bot.respawn() } catch (error) { console.error(`[safety] respawn request failed: ${error.message}`) }
    }, 350)
  })
  bot.on('spawn', async () => {
    if (!deathRecoveryPending) return
    deathRecoveryPending = false
    try {
      // The main build coroutine was stopped deliberately. Permit only this
      // one recovery teleport; the bot will exit before any building retry.
      stopping = false
      await sleep(750)
      await travel('material')
      console.log('[safety] returned to material residence after death; stopped before retrying the unsafe build route')
    } catch (error) {
      console.error(`[safety] could not return to material residence after death: ${error.message}`)
    } finally {
      stopping = true
      bot.quit('stopped after death recovery')
    }
  })
  bot.on('end', () => {
    if (!stopping) {
      stopping = true
      process.exitCode = 1
      console.error('[network] disconnected; stopped without reconnecting')
    }
  })
}

const setupMissing = require('./initial_setup').missing(config, ['left', 'right', 'bootstrap'].includes(workerRole) ? 'dual' : 'single')
if (setupMissing.length) {
  console.error(`[setup] 信息未填完整：${setupMissing.join('、')}。请到网页“仓库与领地”补全后再启动。`)
  process.exitCode = 1
} else createBot()
