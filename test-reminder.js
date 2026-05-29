require("dotenv").config();
const { getAppointmentsForReminder } = require("./src/sheets");

async function test() {
  console.log("Testando lembrete 2h antes...")
  const appointments2h = await getAppointmentsForReminder(2)
  console.log("Agendamentos 2h:", appointments2h)

  console.log("\nTestando lembrete 24h antes...")
  const appointments24h = await getAppointmentsForReminder(24)
  console.log("Agendamentos 24h:", appointments24h)
}

test().catch(console.error)