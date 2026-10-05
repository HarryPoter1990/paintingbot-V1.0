const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { Vec3 } = require('vec3')

const source = fs.readFileSync(path.join(__dirname, 'painting_v2.js'), 'utf8')
const startupGuard = /\nconst setupMissing = require\('\.\/initial_setup'\)\.missing\(config,[^\n]+\)\nif \(setupMissing\.length\) \{[\s\S]*?\} else createBot\(\)\s*$/
assert.match(source, startupGuard)
const configModule = fs.existsSync(path.join(__dirname, 'config.js')) ? './config' : './config.example'
const safeSource = source.replace(startupGuard, '\n').replace("require('./config')", `require('${configModule}')`)

function sandbox(blockNames, options = {}) {
  const calls = { acquired: [], travel: [], placed: [], dug: [], logs: [] }
  const blocks = new Map(Object.entries(blockNames))
  const context = vm.createContext({
    require,
    __dirname,
    process: { argv: ['node', 'painting_v2.js', 'repair'], env: options.workerRole ? { MAPART_WORKER: options.workerRole } : {} },
    console: { log(message) { calls.logs.push(String(message)) }, warn() {}, error() {} },
    setTimeout: callback => setImmediate(callback),
    clearTimeout,
    Buffer
  })
  vm.runInContext(safeSource, context, { filename: 'painting_v2.js' })
  const blockAt = pos => {
    const name = blocks.get(`${pos.x},${pos.y},${pos.z}`)
    return name == null ? null : { name, position: pos.clone() }
  }
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5) },
    blockAt,
    inventory: { items: () => [
      { name: 'smooth_stone', type: 1, count: 64 },
      { name: 'white_carpet', type: 2, count: 64 }
    ] },
    heldItem: null,
    async equip(item) { this.heldItem = item },
    async dig(block) {
      calls.dug.push(block.position.toString())
      if (!calls.digPositions) calls.digPositions = []
      calls.digPositions.push(this.entity.position.clone())
      blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, 'air')
    },
    async placeBlock(reference) {
      const target = reference.position.offset(0, 1, 0)
      calls.placeAttempts = (calls.placeAttempts || 0) + 1
      if (options.placeMode === 'reject') throw new Error('server refused placement')
      if (options.placeMode === 'disconnect') {
        vm.runInContext('stopping = true', context)
        throw new Error('socket disconnected')
      }
      if (options.placeMode === 'silent') return
      if (options.placeMode === 'confirmAfterReject') {
        blocks.set(`${target.x},${target.y},${target.z}`, this.heldItem.name)
        calls.placed.push(`${target.x},${target.y},${target.z}`)
        throw new Error('server confirmation arrived after placement timeout')
      }
      assert.equal(blocks.get(`${target.x},${target.y},${target.z}`), 'air')
      blocks.set(`${target.x},${target.y},${target.z}`, this.heldItem.name)
      calls.placed.push(`${target.x},${target.y},${target.z}`)
    }
  }
  context.__mockBot = bot
  vm.runInContext('bot = globalThis.__mockBot', context)
  const config = vm.runInContext('config', context)
  config.sites.build.origin = new Vec3(0, 0, 0)
  config.sites.build.rotation = 0
  config.build.replaceWrongSupportedBlock = options.replaceWrong !== false
  config.build.placeConfirmMs = 30
  config.build.placeRetries = 2
  context.acquire = async requirements => { calls.acquired.push({ ...requirements }) }
  context.confirmAcquiredMaterials = async () => {}
  context.travel = async site => { calls.travel.push(site) }
  return { context, calls, blocks }
}

const task = (x, z, name) => ({ local: new Vec3(x, 0, z), name })
const position = local => ({ local })

test('repair uses first-edge, first-face and completed-row entry without a ladder', async () => {
  const edge = task(1, 0, 'smooth_stone')
  const first = task(1, 1, 'white_carpet')
  const later = task(1, 2, 'white_carpet')
  const env = sandbox({
    '1,-1,0': 'smooth_stone', '1,-1,1': 'smooth_stone', '1,-1,2': 'smooth_stone',
    '1,0,0': 'air', '1,0,1': 'air', '1,0,2': 'blue_carpet'
  })
  await env.context.repairFromAudit(
    { rows: [[edge], [first], [later]] },
    { missing: [position(first.local), position(edge.local)], wrong: [{ ...position(later.local), actual: 'blue_carpet' }], unloaded: [] }
  )
  assert.deepEqual(env.calls.placed, ['1,0,0', '1,0,1', '1,0,2'])
  assert.equal(env.calls.dug.length, 1)
  assert.equal(env.blocks.get('1,0,2'), 'white_carpet')
  assert.deepEqual(env.calls.travel, ['build'])
})

test('repair refuses unsupported obstruction before collecting', async () => {
  const target = task(1, 1, 'white_carpet')
  const env = sandbox({ '1,0,1': 'dirt' })
  await assert.rejects(
    env.context.repairFromAudit({ rows: [[], [target]] }, { missing: [], wrong: [{ ...position(target.local), actual: 'dirt' }], unloaded: [] }),
    /unsupported obstructing block/
  )
  assert.equal(env.calls.acquired.length, 0)
  assert.equal(env.calls.placed.length, 0)
})

test('dual worker defers a wrong carpet, repairs it after laying, then checkpoints', async () => {
  const target = task(1, 1, 'white_carpet')
  const region = { regionX: 0, regionZ: 0, minX: 1, maxX: 2, minZ: 1, maxZ: 2, tasks: [target] }
  const plan = { rows: [[], [target]] }
  const state = { completedRows: [0], completedRegions: [], blocked: [] }
  const env = sandbox({
    '1,0,0': 'smooth_stone', '1,-1,1': 'smooth_stone', '1,0,1': 'blue_carpet'
  }, { workerRole: 'left' })
  env.context.writeState = async () => {}
  const deferred = new Map()
  assert.equal(await env.context.buildLegacyRegion(plan, state, region, deferred), 'deferred')
  assert.equal(deferred.size, 1)
  assert.equal(env.calls.dug.length, 0)
  assert.deepEqual(state.completedRegions, [])
  await env.context.repairDeferredOccupied(plan, state, new Map([['0,0', region]]), deferred)
  assert.equal(env.blocks.get('1,0,1'), 'white_carpet')
  assert.equal(env.calls.dug.length, 1)
  assert.equal(env.calls.travel.includes('material'), false)
  assert.deepEqual(Array.from(state.completedRegions), ['0,0'])
})

test('single worker also repairs a deferred wrong carpet before checkpoint', async () => {
  const target = task(1, 1, 'white_carpet')
  const region = { regionX: 0, regionZ: 0, minX: 1, maxX: 2, minZ: 1, maxZ: 2, tasks: [target] }
  const plan = { rows: [[], [target]] }
  const state = { completedRows: [0], completedRegions: [], blocked: [] }
  const env = sandbox({
    '1,0,0': 'smooth_stone', '1,-1,1': 'smooth_stone', '1,0,1': 'blue_carpet'
  })
  env.context.writeState = async () => {}
  const deferred = new Map()
  assert.equal(await env.context.buildLegacyRegion(plan, state, region, deferred), 'deferred')
  await env.context.repairDeferredOccupied(plan, state, new Map([['0,0', region]]), deferred)
  assert.equal(env.blocks.get('1,0,1'), 'white_carpet')
  assert.equal(env.calls.digPositions[0].z, 0.5)
  assert.deepEqual(Array.from(state.completedRegions), ['0,0'])
})

test('single deferred repair accepts a late block update from the safe support row', async () => {
  const target = task(1, 1, 'white_carpet')
  const env = sandbox({
    '1,0,0': 'smooth_stone', '1,-1,1': 'smooth_stone', '1,0,1': 'blue_carpet'
  }, { placeMode: 'confirmAfterReject' })
  await env.context.repairOneTaskViaLegacyCoordinates(target, false, true)
  assert.equal(env.blocks.get('1,0,1'), 'white_carpet')
  assert.equal(env.calls.placeAttempts, 1)
  assert.equal(env.calls.digPositions[0].z, 0.5)
})

test('nearby deferred carpets share one first-face entry and stay on completed support rows', async () => {
  const first = task(1, 3, 'white_carpet')
  const second = task(3, 3, 'white_carpet')
  const region = { regionX: 0, regionZ: 0, minX: 1, maxX: 4, minZ: 3, maxZ: 4, tasks: [first, second] }
  const blocks = {
    '1,0,3': 'blue_carpet', '3,0,3': 'blue_carpet',
    '1,-1,3': 'smooth_stone', '3,-1,3': 'smooth_stone'
  }
  for (let x = 1; x <= 3; x++) {
    blocks[`${x},0,0`] = 'smooth_stone'
    blocks[`${x},0,2`] = 'white_carpet'
  }
  blocks['1,0,1'] = 'white_carpet'
  const env = sandbox(blocks, { workerRole: 'left' })
  env.context.buildLegacyRegion = async () => 'complete'
  await env.context.repairDeferredOccupied(
    { rows: [[], [], [], [first, second]] },
    { completedRows: [0], completedRegions: [], blocked: [] },
    new Map([['0,0', region]]),
    new Map([['first', first], ['second', second]])
  )
  assert.deepEqual(env.calls.placed, ['1,0,3', '3,0,3'])
  assert.equal(env.calls.logs.filter(line => line.includes('initial-version direct entry')).length, 1)
  assert.equal(env.calls.digPositions[1].z, 2.5)
})

test('deferred movement refuses to dig after falling below the completed row', async () => {
  const target = task(2, 3, 'white_carpet')
  const env = sandbox({ '1,0,2': 'white_carpet', '2,0,2': 'white_carpet', '2,0,3': 'blue_carpet' })
  env.context.__mockBot.entity.position = new Vec3(1.5, -1, 2.5)
  await assert.rejects(
    env.context.moveDeferredRepairToSupport(new Vec3(1, 0, 2), new Vec3(2, 0, 2)),
    /left the completed route/
  )
  assert.equal(env.calls.dug.length, 0)
})

test('automatic deferred repair refuses a non-carpet obstruction', async () => {
  const target = task(1, 1, 'white_carpet')
  const region = { regionX: 0, regionZ: 0, minX: 1, maxX: 2, minZ: 1, maxZ: 2, tasks: [target] }
  const env = sandbox({ '1,0,0': 'smooth_stone', '1,0,1': 'smooth_stone' }, { workerRole: 'left' })
  await assert.rejects(
    env.context.buildLegacyRegion({ rows: [[], [target]] }, { completedRows: [0], completedRegions: [], blocked: [] }, region, new Map()),
    /Unsafe occupied target/
  )
  assert.equal(env.calls.dug.length, 0)
})

test('deferred carpet limit stops before exceeding 99 positions', async () => {
  const first = task(1, 1, 'white_carpet')
  const second = task(2, 1, 'white_carpet')
  const region = { regionX: 0, regionZ: 0, minX: 1, maxX: 3, minZ: 1, maxZ: 2, tasks: [first, second] }
  const env = sandbox({
    '1,0,0': 'smooth_stone', '2,0,0': 'smooth_stone',
    '1,0,1': 'blue_carpet', '2,0,1': 'blue_carpet'
  }, { workerRole: 'left' })
  vm.runInContext('config.build.maxDeferredWrongCarpets = 1', env.context)
  const deferred = new Map()
  await assert.rejects(
    env.context.buildLegacyRegion({ rows: [[], [first, second]] }, { completedRows: [0], completedRegions: [], blocked: [] }, region, deferred),
    /Deferred wrong-carpet limit 1 reached/
  )
  assert.equal(deferred.size, 1)
  assert.equal(env.calls.dug.length, 0)
})

test('deferred region is skipped during laying but remains uncheckpointed', async () => {
  const target = task(1, 1, 'white_carpet')
  const env = sandbox({ '1,0,1': 'blue_carpet' })
  const state = { completedRows: [0], completedRegions: [], blocked: [] }
  const plan = { rows: [[], [target]] }
  const first = await env.context.nextLegacyRegion(plan, state)
  assert.equal(first.regionX, 0)
  assert.equal(first.regionZ, 0)
  const skipped = await env.context.nextLegacyRegion(plan, state, new Map([['0,0', first]]))
  assert.equal(skipped, null)
  assert.deepEqual(state.completedRegions, [])
})

test('deferred repair rechecks the block immediately before digging', async () => {
  const target = task(1, 1, 'white_carpet')
  const env = sandbox({
    '1,0,0': 'smooth_stone', '1,-1,1': 'smooth_stone', '1,0,1': 'chest'
  }, { workerRole: 'left' })
  await assert.rejects(env.context.repairOneTaskViaLegacyCoordinates(target, false, true), /removal refused/)
  assert.equal(env.calls.dug.length, 0)
})

test('repair refuses unloaded audit results', async () => {
  const env = sandbox({})
  await assert.rejects(
    env.context.repairFromAudit({ rows: [] }, { missing: [], wrong: [], unloaded: [{}] }),
    /unloaded blocks/
  )
  assert.equal(env.calls.acquired.length, 0)
})

test('repair stops when the completed support row is missing', async () => {
  const target = task(1, 2, 'white_carpet')
  const env = sandbox({ '1,0,0': 'smooth_stone', '1,0,1': 'air', '1,0,2': 'air', '1,-1,2': 'smooth_stone' })
  await assert.rejects(
    env.context.repairFromAudit({ rows: [[], [], [target]] }, { missing: [position(target.local)], wrong: [], unloaded: [] }),
    /Completed route has a gap|no completed support row/
  )
  assert.equal(env.calls.placed.length, 0)
})

test('repair respects the wrong-block replacement switch', async () => {
  const target = task(1, 1, 'white_carpet')
  const env = sandbox({ '1,0,0': 'smooth_stone', '1,0,1': 'blue_carpet', '1,-1,1': 'smooth_stone' }, { replaceWrong: false })
  await assert.rejects(
    env.context.repairFromAudit({ rows: [[], [target]] }, { missing: [], wrong: [{ ...position(target.local), actual: 'blue_carpet' }], unloaded: [] }),
    /replacement is disabled/
  )
  assert.equal(env.calls.dug.length, 0)
  assert.equal(env.calls.placed.length, 0)
})

test('repair stops after a refused placement without accepting the gap', async () => {
  const target = task(1, 0, 'smooth_stone')
  const env = sandbox({ '1,-1,0': 'smooth_stone', '1,0,0': 'air' }, { placeMode: 'reject' })
  await assert.rejects(
    env.context.repairFromAudit({ rows: [[target]] }, { missing: [position(target.local)], wrong: [], unloaded: [] }),
    /Repair placement was not confirmed/
  )
  assert.equal(env.blocks.get('1,0,0'), 'air')
  assert.equal(env.calls.placed.length, 0)
})

test('repair rejects a resolved place call without a block update', async () => {
  const target = task(1, 0, 'smooth_stone')
  const env = sandbox({ '1,-1,0': 'smooth_stone', '1,0,0': 'air' }, { placeMode: 'silent' })
  await assert.rejects(
    env.context.repairFromAudit({ rows: [[target]] }, { missing: [position(target.local)], wrong: [], unloaded: [] }),
    /Repair placement was not confirmed/
  )
  assert.equal(env.blocks.get('1,0,0'), 'air')
})

test('repair stops on disconnect without retrying the placement', async () => {
  const target = task(1, 0, 'smooth_stone')
  const env = sandbox({ '1,-1,0': 'smooth_stone', '1,0,0': 'air' }, { placeMode: 'disconnect' })
  await assert.rejects(
    env.context.repairFromAudit({ rows: [[target]] }, { missing: [position(target.local)], wrong: [], unloaded: [] }),
    /Build interrupted by death or disconnect/
  )
  assert.equal(env.calls.placeAttempts, 1)
  assert.equal(env.blocks.get('1,0,0'), 'air')
})

test('no active ladder route or ladder placement remains', () => {
  assert.doesNotMatch(source, /ladderRoute|borrowLadders|placeAscendingLadder|climbLadderToExit|enterRegionViaLadder|buildPhysicalBootstrap/)
})
