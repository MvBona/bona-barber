require("dotenv").config();
const { generateWeeklySlots } = require("./src/scheduler");

generateWeeklySlots()
  .then(() => console.log("Concluído!"))
  .catch(console.error);