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

function isWithinTwoHours(data, horario) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  const [year, month, day] = data.split("-").map(Number);
  const [hour, minute] = horario.split(":").map(Number);
  const slotDate = new Date(year, month - 1, day, hour, minute);
  const diffHoras = (slotDate - now) / (1000 * 60 * 60);
  return diffHoras <= 2 && diffHoras > 0;
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

  // Busca exata por telefone
  let rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] === "agendado" && row[3] === telefone,
  );

  // Fallback: cliente digitou número sem/com código de país (ex: site vs WhatsApp)
  // Usa os últimos 8 dígitos — suficiente para diferenciar clientes, evita cancelar agendamento alheio
  if (rowIndex === -1) {
    const tail = (p) => (p || "").replace(/\D/g, "").slice(-8);
    const t = tail(telefone);
    if (t.length === 8) {
      rowIndex = rows.findIndex(
        (row) => row[0] === data && row[1] === horario && row[4] === "agendado" && tail(row[3]) === t,
      );
    }
  }

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
  if (!cancelado || cancelado === "bloqueado_tempo") return cancelado;

  const agendado = await bookSlot(dataNova, horarioNovo, nome, telefone);
  if (!agendado) {
    const restored = await bookSlot(dataAtual, horarioAtual, nome, telefone);
    return restored ? false : "rollback_failed";
  }

  return true;
}

async function getClientName(telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetNames = getRelevantSheetNames();

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:E`,
      });
      const rows = response.data.values || [];
      const found = rows.slice(1).find((row) => row[3] === telefone && row[2] && row[2].trim());
      if (found) return found[2].trim();
    } catch (e) {}
  }
  return null;
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
  const tipo = `${horasAntes}h`;

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:G`,
      });
      const rows = response.data.values || [];

      rows.slice(1).forEach((row, i) => {
        if (row[4] !== "agendado") return;
        if (!row[0] || !row[1] || !row[3]) return;

        const lembretes = row[6] || "";
        if (lembretes.includes(tipo)) return;

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
          sheetName,
          rowIndex: i + 2,
          lembretes,
        });
      });
    } catch (e) {}
  }

  return appointments;
}

async function markReminderSent(sheetName, rowIndex, lembretes, tipo) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hhmm = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  const tag = `${tipo}@${hhmm}`;
  const novo = lembretes ? `${lembretes},${tag}` : tag;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!G${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[novo]] },
  });
}

async function appendLembretes(sheetName, rowIndex, lembretes, tag) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const novo = lembretes ? `${lembretes},${tag}` : tag;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!G${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[novo]] },
  });
}

async function getUnconfirmedReminders(tipo, minutosGraca) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetNames = getRelevantSheetNames();
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const appointments = [];
  const avisoTag = `${tipo}-aviso`;
  const regex = new RegExp(`${tipo}@(\\d{2}:\\d{2})`);

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:G`,
      });
      const rows = response.data.values || [];

      rows.slice(1).forEach((row, i) => {
        if (row[4] !== "agendado") return;
        if (!row[0] || !row[1] || !row[3]) return;

        const lembretes = row[6] || "";
        if (lembretes.includes(avisoTag)) return;

        const match = lembretes.match(regex);
        if (!match) return;

        const [hh, mm] = match[1].split(":").map(Number);
        const sent = new Date(now);
        sent.setHours(hh, mm, 0, 0);
        if (sent > now) sent.setDate(sent.getDate() - 1);

        const minutosDecorridos = (now - sent) / (1000 * 60);
        if (minutosDecorridos < minutosGraca) return;

        appointments.push({
          data: row[0],
          horario: row[1],
          nome: row[2],
          telefone: row[3],
          sheetName,
          rowIndex: i + 2,
          lembretes,
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

// Atualiza nome de um agendamento pelo telefone
async function updateSlotName(telefone, nome) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetNames = getRelevantSheetNames();

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:F`,
      });

      const rows = response.data.values || [];
      const updates = [];

      rows.slice(1).forEach((row, i) => {
        if (
          row[3] === telefone &&
          row[4] === "agendado" &&
          (!row[2] || row[2].trim() === "")
        ) {
          updates.push({
            range: `${sheetName}!C${i + 2}`,
            values: [[nome]],
          });
        }
      });

      if (updates.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { valueInputOption: "RAW", data: updates },
        });
      }
    } catch (e) {}
  }
}

async function getWeeklySummary() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const PAD = (n) => String(n).padStart(2, "0");
  const FMT = (d) => `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;

  const pastDates = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() - 6 + i);
    return FMT(d);
  });
  const nextDates = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() + 1 + i);
    return FMT(d);
  });

  const allDates = [...pastDates, ...nextDates];
  const byMonth = {};
  for (const date of allDates) {
    const sheet = getSheetName(date);
    if (!byMonth[sheet]) byMonth[sheet] = new Set();
    byMonth[sheet].add(date);
  }

  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const slotsByDate = {};
  for (const [sheetName, monthDates] of Object.entries(byMonth)) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:E`,
      });
      const rows = response.data.values || [];
      for (const row of rows.slice(1)) {
        if (monthDates.has(row[0]) && row[4] === "agendado") {
          if (!slotsByDate[row[0]]) slotsByDate[row[0]] = [];
          slotsByDate[row[0]].push({ horario: row[1], nome: row[2] || "Cliente" });
        }
      }
    } catch (e) {}
  }

  const semanaPassada = pastDates.flatMap((d) => (slotsByDate[d] || []).map((s) => ({ ...s, data: d })));
  const proximaSemana = nextDates.flatMap((d) => slotsByDate[d] || []);

  return { semanaPassada, proximaSemana };
}

async function updateClientPhone(data, horario, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:E`,
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[4] === "agendado",
  );

  if (rowIndex === -1) return false;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!D${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[telefone]] },
  });

  return true;
}

async function getSlotsForDates(dates) {
  if (!dates.length) return { dates: [] };

  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const byMonth = {};
  for (const date of dates) {
    const sheetName = getSheetName(date);
    if (!byMonth[sheetName]) byMonth[sheetName] = new Set();
    byMonth[sheetName].add(date);
  }

  const slotsByDate = {};
  for (const [sheetName, monthDates] of Object.entries(byMonth)) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:E`,
      });
      const rows = response.data.values || [];
      for (const row of rows.slice(1)) {
        if (monthDates.has(row[0])) {
          if (!slotsByDate[row[0]]) slotsByDate[row[0]] = [];
          slotsByDate[row[0]].push({ horario: row[1], status: row[4] || "livre" });
        }
      }
    } catch (e) {}
  }

  for (const date in slotsByDate) {
    slotsByDate[date].sort((a, b) => a.horario.localeCompare(b.horario));
  }

  return {
    dates: dates.map((date) => ({ date, slots: slotsByDate[date] || [] })),
  };
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
  markReminderSent,
  appendLembretes,
  getUnconfirmedReminders,
  countClientAppointmentsOnDay,
  getSlotInfo,
  getDaySchedule,
  updateSlotName,
  updateClientPhone,
  getClientName,
  getWeeklySummary,
  getSlotsForDates,
};
