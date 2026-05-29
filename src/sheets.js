const { google } = require("googleapis");

let credentials;
try {
  credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} catch (e) {
  console.error("Erro ao carregar GOOGLE_CREDENTIALS:", e.message);
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

function isSlotInFuture(data, horario) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  const [year, month, day] = data.split("-").map(Number);
  const [hour, minute] = horario.split(":").map(Number);
  const slotDate = new Date(year, month - 1, day, hour, minute);
  return slotDate > now;
}

async function getAvailableSlots() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:E",
  });

  const rows = response.data.values || [];

  const available = rows
    .slice(1)
    .filter((row) => row[4] === "livre" && isSlotInFuture(row[0], row[1]));

  return available.map((row) => ({
    data: row[0],
    horario: row[1],
    status: row[4],
  }));
}

async function bookSlot(data, horario, nome, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:E",
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] === "livre",
  );

  if (rowIndex === -1) return false;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Sheet1!A${rowIndex + 1}:E${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[data, horario, nome, telefone, "agendado"]],
    },
  });

  return true;
}

async function cancelSlot(data, horario, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:E",
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) =>
      row[0] === data &&
      row[1] === horario &&
      row[4] === "agendado" &&
      row[3] === telefone,
  );

  if (rowIndex === -1) return false;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Sheet1!A${rowIndex + 1}:E${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[data, horario, "", "", "livre"]],
    },
  });

  return true;
}

async function rescheduleSlot(
  dataAtual,
  horarioAtual,
  dataNova,
  horarioNovo,
  nome,
  telefone,
) {
  const cancelado = await cancelSlot(dataAtual, horarioAtual, telefone);
  if (!cancelado) return false;

  const agendado = await bookSlot(dataNova, horarioNovo, nome, telefone);
  if (!agendado) {
    await bookSlot(dataAtual, horarioAtual, nome, telefone);
    return false;
  }

  return true;
}

async function getClientAppointments(telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:E",
  });

  const rows = response.data.values || [];
  return rows
    .slice(1)
    .filter((row) => row[3] === telefone && row[4] === "agendado")
    .map((row) => ({ data: row[0], horario: row[1] }));
}

module.exports = {
  getAvailableSlots,
  bookSlot,
  cancelSlot,
  rescheduleSlot,
  getClientAppointments,
};
