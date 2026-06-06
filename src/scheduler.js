const { google } = require("googleapis");
const config = require("../config");

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TZ = config.timezone;

// Colunas: data(A0) horario(B1) profissional(C2) nome(D3) telefone(E4) status(F5)
//          servico(G6) duracao_min(H7) criado_em(I8) lembretes(J9) reserva_id(K10)
const HEADER = ["data","horario","profissional","nome","telefone","status","servico","duracao_min","criado_em","lembretes","reserva_id"];

function getProfissionais() {
  if (config.profissionais?.length) return config.profissionais;
  return [{ id: "profissional", nome: config.adminAlias || "Profissional", telefone: config.telefoneAdmin }];
}

function getNextTwoMonthsDates() {
  const dates = [];
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(today);
  end.setMonth(today.getMonth() + 2);
  end.setDate(0);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (config.diasFechado.includes(d.getDay())) continue;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates;
}

function generateSlots(date, profId) {
  const slots = [];
  const { inicio, fim } = config.expediente;
  for (let min = inicio * 60; min + config.duracaoSlot <= fim * 60; min += config.duracaoSlot) {
    const h = String(Math.floor(min / 60)).padStart(2, "0");
    const m = String(min % 60).padStart(2, "0");
    slots.push([date, `${h}:${m}`, profId, "", "", "livre", "", "", "", "", ""]);
  }
  return slots;
}

async function ensureSheetExists(sheets, sheetName) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = spreadsheet.data.sheets.some((s) => s.properties.title === sheetName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    console.log(`Aba ${sheetName} criada!`);
  }

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1:K1` });
  const header = (res.data.values || [])[0];
  if (!header || header[0] !== "data") {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:K1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
}

async function generateWeeklySlots() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const dates = getNextTwoMonthsDates();
  const profissionais = getProfissionais();
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
      range: `${sheetName}!A:C`,
    });
    const rows = response.data.values || [];
    const existingSlots = new Set(rows.slice(1).map((row) => `${row[0]}_${row[1]}_${row[2]}`));

    const allSlots = [];
    for (const prof of profissionais) {
      for (const date of monthDates) {
        allSlots.push(...generateSlots(date, prof.id));
      }
    }

    const newSlots = allSlots.filter((slot) => !existingSlots.has(`${slot[0]}_${slot[1]}_${slot[2]}`));
    if (newSlots.length === 0) continue;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:K`,
      valueInputOption: "RAW",
      requestBody: { values: newSlots },
    });
    totalAdded += newSlots.length;
  }

  console.log(`${totalAdded} horários gerados!`);
}

// profId=null → bloqueia todos os profissionais
async function blockDay(data, profId = null) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const [year, month] = data.split("-");
  const sheetName = `${year}-${month}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:F` });
  const rows = response.data.values || [];
  const updates = [];
  rows.slice(1).forEach((row, i) => {
    if (row[0] !== data) return;
    if (profId && row[2] !== profId) return;
    if (row[5] === "livre" || row[5] === "agendado") {
      updates.push({ range: `${sheetName}!F${i + 2}`, values: [["bloqueado"]] });
    }
  });
  if (updates.length === 0) return 0;
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: "RAW", data: updates } });
  return updates.length;
}

async function blockSlot(data, horario, profId) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const [year, month] = data.split("-");
  const sheetName = `${year}-${month}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:F` });
  const rows = response.data.values || [];
  const rowIndex = rows.findIndex((row) => row[0] === data && row[1] === horario && row[2] === profId && row[5] !== "bloqueado");
  if (rowIndex === -1) return 0;
  await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!F${rowIndex + 1}`, valueInputOption: "RAW", requestBody: { values: [["bloqueado"]] } });
  return 1;
}

async function blockPeriod(dataInicio, dataFim, profId = null) {
  const start = new Date(dataInicio + "T00:00:00");
  const end = new Date(dataFim + "T00:00:00");
  let total = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    total += await blockDay(`${yyyy}-${mm}-${dd}`, profId);
  }
  return total;
}

async function unblockDay(data, profId = null) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const [year, month] = data.split("-");
  const sheetName = `${year}-${month}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:F` });
  const rows = response.data.values || [];
  const updates = [];
  rows.slice(1).forEach((row, i) => {
    if (row[0] !== data) return;
    if (profId && row[2] !== profId) return;
    if (row[5] === "bloqueado") updates.push({ range: `${sheetName}!F${i + 2}`, values: [["livre"]] });
  });
  if (updates.length === 0) return 0;
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: "RAW", data: updates } });
  return updates.length;
}

async function unblockSlot(data, horario, profId) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const [year, month] = data.split("-");
  const sheetName = `${year}-${month}`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:F` });
  const rows = response.data.values || [];
  const rowIndex = rows.findIndex((row) => row[0] === data && row[1] === horario && row[2] === profId && row[5] === "bloqueado");
  if (rowIndex === -1) return 0;
  await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!F${rowIndex + 1}`, valueInputOption: "RAW", requestBody: { values: [["livre"]] } });
  return 1;
}

async function unblockPeriod(dataInicio, dataFim, profId = null) {
  const start = new Date(dataInicio + "T00:00:00");
  const end = new Date(dataFim + "T00:00:00");
  let total = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    total += await unblockDay(`${yyyy}-${mm}-${dd}`, profId);
  }
  return total;
}

async function resetSlots(scope = "mes") {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const n = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const currentSheetName = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;

  const sheetNames = scope === "tudo"
    ? Array.from({ length: 3 }, (_, i) => { const d = new Date(n); d.setMonth(d.getMonth() + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })
    : [currentSheetName];

  const apagados = [];
  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:F` });
      (response.data.values || []).slice(1).forEach((row) => {
        if (row[5] === "agendado" && row[0] && row[1]) {
          apagados.push({ data: row[0], horario: row[1], profissional: row[2], nome: row[3], telefone: row[4] });
        }
      });
    } catch (e) {}
  }

  for (const sheetName of sheetNames) {
    try {
      await ensureSheetExists(sheets, sheetName);
      await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A2:K9999` });
    } catch (e) {}
  }

  await generateWeeklySlots();
  return { total: apagados.length, apagados };
}

module.exports = { generateWeeklySlots, resetSlots, blockDay, blockSlot, blockPeriod, unblockDay, unblockSlot, unblockPeriod, getProfissionais };
