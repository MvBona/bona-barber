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

function getSheetName(data) {
  const [year, month] = data.split("-");
  return `${year}-${month}`;
}

function getCurrentSheetName() {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getRelevantSheetNames() {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  const sheets = [];
  for (let i = 0; i <= 1; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    sheets.push(`${year}-${month}`);
  }
  return sheets;
}

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
  const sheetNames = getRelevantSheetNames();
  const allSlots = [];

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:E`,
      });
      const rows = response.data.values || [];
      const available = rows
        .slice(1)
        .filter((row) => row[4] === "livre" && isSlotInFuture(row[0], row[1]));
      allSlots.push(
        ...available.map((row) => ({
          data: row[0],
          horario: row[1],
          status: row[4],
        })),
      );
    } catch (e) {}
  }

  return allSlots;
}

async function countClientAppointmentsOnDay(telefone, data) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:F`,
    });
    const rows = response.data.values || [];
    return rows
      .slice(1)
      .filter(
        (row) =>
          row[0] === data && row[3] === telefone && row[4] === "agendado",
      ).length;
  } catch (e) {
    return 0;
  }
}

async function bookSlot(data, horario, nome, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] === "livre",
  );

  if (rowIndex === -1) return false;

  const criadoEm = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex + 1}:F${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[data, horario, nome, telefone, "agendado", criadoEm]],
    },
  });

  return true;
}

async function bookSlotAdmin(data, horario, nome, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] !== "agendado",
  );

  if (rowIndex === -1) return false;

  const criadoEm = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex + 1}:F${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[data, horario, nome, telefone, "agendado", criadoEm]],
    },
  });

  return true;
}

async function cancelSlot(data, horario, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
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
    range: `${sheetName}!A${rowIndex + 1}:F${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[data, horario, "", "", "livre", ""]],
    },
  });

  return true;
}

async function cancelSlotAdmin(data, horario) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] === "agendado",
  );

  if (rowIndex === -1) return false;

  const clientPhone = rows[rowIndex][3];
  const clientName = rows[rowIndex][2];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex + 1}:F${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[data, horario, "", "", "livre", ""]],
    },
  });

  return { clientPhone, clientName };
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
  const sheetNames = getRelevantSheetNames();
  const appointments = [];

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:E`,
      });
      const rows = response.data.values || [];
      appointments.push(
        ...rows
          .slice(1)
          .filter((row) => row[3] === telefone && row[4] === "agendado")
          .map((row) => ({ data: row[0], horario: row[1] })),
      );
    } catch (e) {}
  }

  return appointments;
}

async function getAppointmentsForReminder(horasAntes) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetNames = getRelevantSheetNames();
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  const appointments = [];

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:F`,
      });
      const rows = response.data.values || [];

      rows.slice(1).forEach((row) => {
        if (row[4] !== "agendado") return;
        if (!row[0] || !row[1] || !row[3]) return;

        const [year, month, day] = row[0].split("-").map(Number);
        const [hour, minute] = row[1].split(":").map(Number);
        const slotDate = new Date(year, month - 1, day, hour, minute);
        const diffHoras = (slotDate - now) / (1000 * 60 * 60);
        const dentroJanela =
          diffHoras >= horasAntes - 0.5 && diffHoras < horasAntes + 0.5;

        if (!dentroJanela) return;

        if (horasAntes === 24) {
          if (!row[5]) return;
          const criadoEm = new Date(
            row[5].split(", ")[0].split("/").reverse().join("-") +
              "T" +
              row[5].split(", ")[1],
          );
          const diasDeAntecedencia =
            (slotDate - criadoEm) / (1000 * 60 * 60 * 24);
          if (diasDeAntecedencia < 2) return;
        }

        appointments.push({
          data: row[0],
          horario: row[1],
          nome: row[2],
          telefone: row[3],
        });
      });
    } catch (e) {}
  }

  return appointments;
}

async function getSlotInfo(data, horario) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:F`,
    });

    const rows = response.data.values || [];
    const row = rows.find((r) => r[0] === data && r[1] === horario);
    if (!row) return null;

    return {
      data: row[0],
      horario: row[1],
      nome: row[2] || "",
      telefone: row[3] || "",
      status: row[4] || "livre",
    };
  } catch (e) {
    return null;
  }
}

// Retorna agenda completa de um dia para o barbeiro
async function getDaySchedule(data) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:F`,
    });

    const rows = response.data.values || [];
    return rows
      .slice(1)
      .filter((row) => row[0] === data)
      .map((row) => ({
        horario: row[1],
        nome: row[2] || "",
        status: row[4] || "livre",
      }))
      .sort((a, b) => a.horario.localeCompare(b.horario));
  } catch (e) {
    return [];
  }
}

module.exports = {
  getAvailableSlots,
  bookSlot,
  bookSlotAdmin,
  cancelSlot,
  cancelSlotAdmin,
  rescheduleSlot,
  getClientAppointments,
  getAppointmentsForReminder,
  countClientAppointmentsOnDay,
  getSlotInfo,
  getDaySchedule,
};
