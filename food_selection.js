function selectedFoodItem(items, foodsByName, itemName) {
  if (!foodsByName?.[itemName]) return undefined
  return items.find(item => item.name === itemName)
}

module.exports = { selectedFoodItem }
