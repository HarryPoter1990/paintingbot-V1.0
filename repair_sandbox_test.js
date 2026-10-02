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
  const calls = { acquired: [], travel: [], placed: [], dug: [] }
  const blocks = new Map(Object.entries(blockNames))
  const context = vm.createContext({
    require,
    __dirname,
    process: { argv: ['node', 'painting_v2.js', 'repair'], env: {} },
    console: { log() {}, warn() {}, error() {} },
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
