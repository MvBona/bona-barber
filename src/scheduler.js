const { google } = require("googleapis");

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

function getNextTwoMonthsDates() {
  const dates = [];
  const today = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );

  const start = new Date(today);
  start.setDate(today.getDate() + 1);

  const end = new Date(today);
  end.setMonth(today.getMonth() + 2);
  end.setDate(0);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayOfWeek = d.getDay();
    if (dayOfWeek === 0) continue;

    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
  }

  return dates;
}

function generateSlots(date) {
  const slots = [];
  for (let hour = 10; hour < 20; hour++) {
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
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    console.log(`Aba ${sheetName} criada!`);
  }

  // Garante o cabeçalho sempre, mesmo que a aba já existisse sem ele
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1:G1`,
  });
  const header = (res.data.values || [])[0];
  if (!header || header[0] !== "data") {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:G1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["data", "horario", "nome", "telefone", "status", "criado_em", "lembretes"]],
      },
    });
  }
}

async function generateWeeklySlots() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const dates = getNextTwoMonthsDates();

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

  console.log(`${totalAdded} horários gerados!`);
}

async function blockDay(data) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const [year, month] = data.split("-");
  const sheetName = `${year}-${month}`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });

  const rows = response.data.values || [];
  const updates = [];

  rows.slice(1).forEach((row, i) => {
    if (row[0] === data && (row[4] === "livre" || row[4] === "agendado")) {
      updates.push({
        range: `${sheetName}!E${i + 2}`,
        values: [["bloqueado"]],
      });
    }
  });

  if (updates.length === 0) return 0;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data: updates },
  });

  return updates.length;
}

async function blockSlot(data, horario) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const [year, month] = data.split("-");
  const sheetName = `${year}-${month}`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] !== "bloqueado",
  );

  if (rowIndex === -1) return 0;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!E${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [["bloqueado"]] },
  });

  return 1;
}

async function blockPeriod(dataInicio, dataFim) {
  const start = new Date(dataInicio + "T00:00:00");
  const end = new Date(dataFim + "T00:00:00");
  let total = 0;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const blocked = await blockDay(`${yyyy}-${mm}-${dd}`);
    total += blocked;
  }

  return total;
}

async function unblockDay(data) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const [year, month] = data.split("-");
  const sheetName = `${year}-${month}`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });

  const rows = response.data.values || [];
  const updates = [];

  rows.slice(1).forEach((row, i) => {
    if (row[0] === data && row[4] === "bloqueado") {
      updates.push({
        range: `${sheetName}!E${i + 2}`,
        values: [["livre"]],
      });
    }
  });

  if (updates.length === 0) return 0;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data: updates },
  });

  return updates.length;
}

async function unblockSlot(data, horario) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const [year, month] = data.split("-");
  const sheetName = `${year}-${month}`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] === "bloqueado",
  );

  if (rowIndex === -1) return 0;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!E${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [["livre"]] },
  });

  return 1;
}

async function unblockPeriod(dataInicio, dataFim) {
  const start = new Date(dataInicio + "T00:00:00");
  const end = new Date(dataFim + "T00:00:00");
  let total = 0;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const unblocked = await unblockDay(`${yyyy}-${mm}-${dd}`);
    total += unblocked;
  }

  return total;
}

async function resetAllSlots() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );

  const sheetNames = [];
  for (let i = 0; i <= 2; i++) {
    const d = new Date(now);
    d.setMonth(d.getMonth() + i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    sheetNames.push(`${year}-${month}`);
  }

  let total = 0;
  const apagados = [];

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:F`,
      });

      const rows = response.data.values || [];
      const updates = [];

      rows.slice(1).forEach((row, i) => {
        if (!row[0] || !row[1]) return;
        if (row[4] === "agendado") {
          apagados.push({ data: row[0], horario: row[1], nome: row[2], telefone: row[3] });
        }
        if (row[4] !== "livre") {
          updates.push({
            range: `${sheetName}!A${i + 2}:F${i + 2}`,
            values: [[row[0], row[1], "", "", "livre", ""]],
          });
        }
      });

      if (updates.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { valueInputOption: "RAW", data: updates },
        });
        total += updates.length;
      }
    } catch (e) {}
  }

  // generateWeeklySlots começa de amanhã — no reset inclui hoje também
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todaySheetName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  try {
    await ensureSheetExists(sheets, todaySheetName);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${todaySheetName}!A:B`,
    });
    const rows = res.data.values || [];
    const existing = new Set(rows.slice(1).map((r) => `${r[0]}_${r[1]}`));
    const todaySlots = generateSlots(todayStr).filter(
      (s) => !existing.has(`${s[0]}_${s[1]}`),
    );
    if (todaySlots.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${todaySheetName}!A:E`,
        valueInputOption: "RAW",
        requestBody: { values: todaySlots },
      });
    }
  } catch (e) {}

  await generateWeeklySlots();
  return { total, apagados };
}

module.exports = {
  generateWeeklySlots,
  resetAllSlots,
  blockDay,
  blockSlot,
  blockPeriod,
  unblockDay,
  unblockSlot,
  unblockPeriod,
};
