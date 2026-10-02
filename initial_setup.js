function missing(config, mode = 'single') {
  const problems = []
  const text = value => typeof value === 'string' ? value.trim() : ''
  const placeholder = value => !text(value) || /^(example[_.-]|right-bot-cache$|left-bot-cache$|RightBot$|LeftBot$)/i.test(value)
  const point = value => value && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(value[axis]))
  const templatePoint = value => config.setupTemplate && value?.x === 0 && value?.y === 64 && value?.z === 0
  if (placeholder(config.connection?.host)) problems.push('服务器地址')
  if (!Number.isInteger(config.connection?.port) || config.connection.port < 1 || config.connection.port > 65535) problems.push('服务器端口')
  if (placeholder(config.workers?.right?.username)) problems.push('主机器人登录缓存标签')
  if (placeholder(config.workers?.right?.expectedMinecraftName)) problems.push('主机器人游戏名')
  if (mode === 'dual') {
    if (placeholder(config.workers?.left?.username)) problems.push('第二机器人登录缓存标签')
    if (placeholder(config.workers?.left?.expectedMinecraftName)) problems.push('第二机器人游戏名')
    if (config.workers?.left?.username && config.workers.left.username === config.workers?.right?.username) problems.push('第二机器人须使用不同的登录缓存标签')
    if (config.workers?.left?.expectedMinecraftName && config.workers.left.expectedMinecraftName === config.workers?.right?.expectedMinecraftName) problems.push('第二机器人须使用不同的游戏名')
  }
  for (const [label, command] of [['材料领地名称', config.sites?.material?.teleport], ['建造子领地名称', config.sites?.build?.teleport]]) {
    if (!/^\/res tp [A-Za-z0-9_.-]+$/.test(command || '') || /example_/i.test(command)) problems.push(label)
  }
  for (const [label, value] of [
    ['材料领地落点', config.sites?.material?.arrival], ['建造传送落点', config.sites?.build?.arrival],
    ['材料桶参考点', config.storage?.anchor], ['食物箱位置', config.foodChest?.position],
    ['食物箱站位', config.foodChest?.access], ['安全丢弃点', config.storage?.leftovers?.stand]
  ]) if (!point(value) || templatePoint(value)) problems.push(label)
  if (!config.storage?.columns || Object.values(config.storage.columns).some(value => !point(value))) problems.push('材料桶位置')
  return problems
}

module.exports = { missing }
