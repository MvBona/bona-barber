const { google } = require("googleapis");

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
// Busca todos os horários livres
async function getAvailableSlots() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:E",
  });

  const rows = response.data.values || [];
  const available = rows.slice(1).filter((row) => row[4] === "livre");

  return available.map((row) => ({
    data: row[0],
    horario: row[1],
    status: row[4],
  }));
}

// Agenda um horário para um cliente
async function bookSlot(data, horario, nome, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  // Busca todas as linhas pra achar a certa
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:E",
  });

  const rows = response.data.values || [];

  // Acha o índice da linha com data, horario e status livre
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] === "livre",
  );

  if (rowIndex === -1) return false; // horário não encontrado ou já ocupado

  // Atualiza a linha (rowIndex + 1 porque a API usa base 1)
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

module.exports = { getAvailableSlots, bookSlot };
