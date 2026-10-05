// The dashboard copies this template to local config.js on first launch.
// Fill server, account and site details in the web page. Do not commit config.js.
const { Vec3 } = require('vec3')

const CARPETS = [
  'white_carpet', 'orange_carpet', 'magenta_carpet', 'light_blue_carpet',
  'yellow_carpet', 'lime_carpet', 'pink_carpet', 'gray_carpet',
  'light_gray_carpet', 'cyan_carpet', 'purple_carpet', 'blue_carpet',
  'brown_carpet', 'green_carpet', 'red_carpet', 'black_carpet'
]

// Relative barrel positions from storage.anchor; adjust to your storage room.
const storageXOffsets = {
  white_carpet: 23, purple_carpet: 22, orange_carpet: 21,
  magenta_carpet: 20, light_gray_carpet: 19, cyan_carpet: 18,
  light_blue_carpet: 17, lime_carpet: 16, green_carpet: 15,
  red_carpet: 14, yellow_carpet: 13, brown_carpet: 12,
  blue_carpet: 11, pink_carpet: 10, black_carpet: 9, gray_carpet: 8
}

const materialAnchor = new Vec3(0, 64, 0)
const materialArrival = new Vec3(0, 64, 0)
// The position where the build-residence teleport actually lands.
const buildTransit = new Vec3(0, 64, 0)
// World position of schematic local (0, 0, 0). Jobs can override this.
const buildOrigin = new Vec3(0, 65, 1)

const config = {
  setupTemplate: true,
  connection: {
    host: '',
    port: 25565,
    // These are local Microsoft authentication cache labels, not passwords.
    username: '',
    auth: 'microsoft',
    respawn: true,
    version: '1.20.4'
  },
  workers: {
    right: { label: '右半边', username: '', expectedMinecraftName: '', profilesFolder: null },
    left: { label: '左半边', username: '', expectedMinecraftName: '', profilesFolder: './auth-cache/left' }
  },
  teleportTiming: { beforeCommandMs: 3_000, afterCommandMs: 5_000 },
  startup: { afterHoverMs: 5_000 },
  schematicPath: './schem/example.schem',
  stateDirectory: './state',
  sites: {
    material: {
      teleport: '/res tp example_material',
      arrival: materialArrival,
      arrivalRadius: 16,
      marker: null
    },
    build: {
      teleport: '/res tp example_build',
      origin: buildOrigin,
      rotation: 0,
      arrival: buildTransit,
      arrivalRadius: 2,
      marker: null,
      walkwayOffset: new Vec3(0, 0, -1)
    }
  },
  storage: {
    anchor: materialAnchor,
    localMovement: 'pathfinder',
    levels: 3,
    containerType: 'barrel',
    accessOffset: new Vec3(0, 0, 2),
    accessYStep: 1,
    columns: {
      smooth_stone: new Vec3(2, 0, 1),
      ...Object.fromEntries(Object.entries(storageXOffsets).map(([name, x]) => [name, new Vec3(x, 0, 0)]))
    },
    // Cleanup only: old bot versions may have left ladders in inventory.
    ladderSupply: {
      itemName: 'ladder',
      container: new Vec3(0, 64, 0),
      access: new Vec3(0, 64, 0)
    },
    leftovers: {
      mode: 'toss_into_void',
      stand: new Vec3(0, 64, 0),
      facing: 'west'
    }
  },
  build: {
    regionSize: 32,
    movementTimeoutMs: 20_000,
    chunkLoadTimeoutMs: 12_000,
    buildTeleportSettleMs: 5_000,
    placeRetries: 3,
    placeConfirmMs: 1_500,
    operationDelayMs: 10,
    autoAuditAfterBuild: true,
    replaceWrongSupportedBlock: true,
    maxDeferredWrongCarpets: 99,
    stopOnNonCarpetBlock: true,
    reservedInventorySlots: 4,
    maxCombinedAdjacentRegions: 2
  },
  movement: {
    mode: 'legacy_original',
    legacyHoverDelayMs: 10,
    legacyBatchEntryDelayMs: 80,
    legacyRetryEntryDelayMs: 120,
    legacyStepSize: 1,
    legacyStepDelayMs: 20,
    coordinateStepHorizontal: 8,
    coordinateStepVertical: 1,
    coordinateStepDelayMs: 100,
    coordinateMaxSteps: 2_000
  },
  materialWait: { retryMs: 15_000, maxWaitMs: 20 * 60 * 1000 },
  readiness: { minHealth: 20, minFood: 20, maxWaitMs: 90_000, checkEveryMs: 1_000 },
  nutritionMonitor: { foodBelow: 10, healthBelow: 16 },
  foodChest: {
    position: new Vec3(0, 64, 0),
    access: new Vec3(0, 64, 0),
    itemName: 'cooked_cod',
    borrowCount: 32
  },
  CARPETS,
  SUPPORTED_BLOCKS: ['smooth_stone', ...CARPETS]
}

module.exports = require('./connection_settings').load(require('./site_settings').load(config))
