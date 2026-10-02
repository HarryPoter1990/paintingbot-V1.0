const test = require('node:test')
const assert = require('node:assert/strict')
const { selectedFoodItem } = require('./food_selection')

test('机器人只选设置中的食物，不误用背包中的另一种食物', () => {
  const foods = { cooked_cod: { foodPoints: 5 }, bread: { foodPoints: 5 }, cooked_porkchop: { foodPoints: 8 } }
  const inventory = [{ name: 'cooked_cod', count: 4 }, { name: 'bread', count: 2 }]
  assert.equal(selectedFoodItem(inventory, foods, 'bread'), inventory[1])
  assert.equal(selectedFoodItem(inventory, foods, 'cooked_porkchop'), undefined)
  assert.equal(selectedFoodItem(inventory, foods, 'smooth_stone'), undefined)
})
