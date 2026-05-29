const { google } = require("googleapis");

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

function getNextWeekDates() {
  const dates = [];
  const today = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
  );

  // Começa na próxima segunda-feira
  const nextMonday = new Date(today);
  const dayOfWeek = today.getDay(); // 0=dom, 1=seg, ..., 6=sab
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  nextMonday.setDate(today.getDate() + daysUntilMonday);

  // Gera segunda a sábado
  for (let i = 0; i < 6; i++) {
    const date = new Date(nextMonday);
    date.setDate(nextMonday.getDate() + i);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
  }

  return dates;
}

function generateSlots(date) {
  const slots = [];
  const open = 10;
  const close = 20;
  const lunchStart = 12;
  const lunchEnd = 13;

  for (let hour = open; hour < close; hour++) {
    // Pula horário de almoço
    if (hour >= lunchStart && hour < lunchEnd) continue;

    const horario = `${String(hour).padStart(2, "0")}:00`;
    slots.push([date, horario, "", "", "livre"]);
  }

  return slots;
}

async function generateWeeklySlots() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const dates = getNextWeekDates();
  const allSlots = [];

  for (const date of dates) {
    const slots = generateSlots(date);
    allSlots.push(...slots);
  }

  // Busca todas as linhas existentes
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:E",
  });

  const rows = response.data.values || [];

  // Filtra slots que já existem na planilha
  const existingSlots = new Set(
    rows.slice(1).map((row) => `${row[0]}_${row[1]}`)
  );

  const newSlots = allSlots.filter(
    (slot) => !existingSlots.has(`${slot[0]}_${slot[1]}`)
  );

  if (newSlots.length === 0) {
    console.log("Nenhum slot novo para adicionar.");
    return;
  }

  // Adiciona os novos slots
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:E",
    valueInputOption: "RAW",
    requestBody: {
      values: newSlots,
    },
  });

  console.log(`${newSlots.length} horários gerados para a semana!`);
}

module.exports = { generateWeeklySlots };