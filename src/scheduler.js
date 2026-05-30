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
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );

  const nextMonday = new Date(today);
  const dayOfWeek = today.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  nextMonday.setDate(today.getDate() + daysUntilMonday);

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
    if (hour >= lunchStart && hour < lunchEnd) continue;
    const horario = `${String(hour).padStart(2, "0")}:00`;
    slots.push([date, horario, "", "", "livre"]);
  }

  return slots;
}

async function ensureSheetExists(sheets, sheetName) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const exists = spreadsheet.data.sheets.some(
    (s) => s.properties.title === sheetName,
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title: sheetName },
            },
          },
        ],
      },
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:F1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [
          ["data", "horario", "nome", "telefone", "status", "criado_em"],
        ],
      },
    });

    console.log(`Aba ${sheetName} criada!`);
  }
}

async function generateWeeklySlots() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const dates = getNextWeekDates();

  const datesByMonth = {};
  for (const date of dates) {
    const [year, month] = date.split("-");
    const sheetName = `${year}-${month}`;
    if (!datesByMonth[sheetName]) datesByMonth[sheetName] = [];
    datesByMonth[sheetName].push(date);
  }

  let totalAdded = 0;

  for (const [sheetName, monthDates] of Object.entries(datesByMonth)) {
    await ensureSheetExists(sheets, sheetName);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:E`,
    });

    const rows = response.data.values || [];
    const existingSlots = new Set(
      rows.slice(1).map((row) => `${row[0]}_${row[1]}`),
    );

    const allSlots = monthDates.flatMap(generateSlots);
    const newSlots = allSlots.filter(
      (slot) => !existingSlots.has(`${slot[0]}_${slot[1]}`),
    );

    if (newSlots.length === 0) continue;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:E`,
      valueInputOption: "RAW",
      requestBody: { values: newSlots },
    });

    totalAdded += newSlots.length;
  }

  console.log(`${totalAdded} horários gerados para a semana!`);
}

module.exports = { generateWeeklySlots };
