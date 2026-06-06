const { google } = require("googleapis");
const config = require("../config");

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
const TZ = config.timezone;

// Colunas: data(A0) horario(B1) profissional(C2) nome(D3) telefone(E4) status(F5)
//          servico(G6) duracao_min(H7) criado_em(I8) lembretes(J9) reserva_id(K10)

function now() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}

function getSheetName(data) {
  const [year, month] = data.split("-");
  return `${year}-${month}`;
}

function getRelevantSheetNames() {
  const n = now();
  const sheets = [];
  for (let i = 0; i <= 1; i++) {
    const d = new Date(n.getFullYear(), n.getMonth() + i, 1);
    sheets.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return sheets;
}

function isSlotInFuture(data, horario) {
  const n = now();
  const [year, month, day] = data.split("-").map(Number);
  const [hour, minute] = horario.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute) > n;
}

function isWithinMinHours(data, horario) {
  const n = now();
  const [year, month, day] = data.split("-").map(Number);
  const [hour, minute] = horario.split(":").map(Number);
  const slotDate = new Date(year, month - 1, day, hour, minute);
  const diffHoras = (slotDate - n) / (1000 * 60 * 60);
  return diffHoras <= config.cancelamentoMinHoras && diffHoras > 0;
}

function getProfissionais() {
  if (config.profissionais?.length) return config.profissionais;
  return [{ id: "profissional", nome: config.adminAlias || "Profissional", telefone: config.telefoneAdmin }];
}

function isMultiProfessional() {
  return (config.profissionais?.length || 0) > 1;
}

// ── Slots disponíveis ────────────────────────────────────────────────────────

async function getAvailableSlots(profId = null) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetNames = getRelevantSheetNames();
  const allSlots = [];

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:F`,
      });
      const rows = response.data.values || [];
      const available = rows.slice(1).filter((row) =>
        row[5] === "livre" &&
        isSlotInFuture(row[0], row[1]) &&
        (!profId || row[2] === profId),
      );
      allSlots.push(...available.map((row) => ({ data: row[0], horario: row[1], profissional: row[2], status: row[5] })));
    } catch (e) {}
  }

  return allSlots;
}

// Retorna disponibilidade de cada profissional para um horário desejado
// Se horário não disponível, mostra o próximo disponível
async function getProfissionaisDisponibilidade(dataDesejada, horarioDesejado) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetNames = getRelevantSheetNames();
  const profissionais = getProfissionais();

  const avail = {};
  for (const prof of profissionais) {
    avail[prof.id] = { disponivelNoHorario: false, proximo: null };
  }

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:F`,
      });
      const rows = (response.data.values || []).slice(1);
      for (const row of rows) {
        const profId = row[2];
        if (!avail[profId]) continue;
        if (row[5] !== "livre" || !isSlotInFuture(row[0], row[1])) continue;

        if (row[0] === dataDesejada && row[1] === horarioDesejado) {
          avail[profId].disponivelNoHorario = true;
        }
        if (!avail[profId].proximo) {
          avail[profId].proximo = { data: row[0], horario: row[1] };
        }
      }
    } catch (e) {}
  }

  return profissionais.map((prof) => ({ ...prof, ...avail[prof.id] }));
}

// ── Agendamento ───────────────────────────────────────────────────────────────

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
    return rows.slice(1).filter(
      (row) => row[0] === data && row[4] === telefone && row[5] === "agendado",
    ).length;
  } catch (e) {
    return 0;
  }
}

async function bookSlot(data, horario, profId, servico, nome, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });
  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[2] === profId && row[5] === "livre",
  );
  if (rowIndex === -1) return false;

  const criadoEm = new Date().toLocaleString("pt-BR", { timeZone: TZ });
  const duracao = config.servicos?.find((s) => s.nome === servico)?.duracao || config.duracaoSlot;
  const reservaId = `${data}_${horario}_${profId}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex + 1}:K${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[data, horario, profId, nome, telefone, "agendado", servico || "", duracao, criadoEm, "", reservaId]] },
  });
  return true;
}

async function bookSlotAdmin(data, horario, profId, nome, telefone) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });
  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[2] === profId && row[5] !== "agendado",
  );
  if (rowIndex === -1) return false;

  const criadoEm = new Date().toLocaleString("pt-BR", { timeZone: TZ });
  const reservaId = `${data}_${horario}_${profId}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex + 1}:K${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[data, horario, profId, nome, telefone, "agendado", "", config.duracaoSlot, criadoEm, "", reservaId]] },
  });
  return true;
}

async function cancelSlot(data, horario, telefone, profId = null) {
  if (isWithinMinHours(data, horario)) return "bloqueado_tempo";

  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });
  const rows = response.data.values || [];

  let rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[5] === "agendado" && row[4] === telefone && (!profId || row[2] === profId),
  );

  if (rowIndex === -1) {
    const tail = (p) => (p || "").replace(/\D/g, "").slice(-8);
    const t = tail(telefone);
    if (t.length === 8) {
      rowIndex = rows.findIndex(
        (row) => row[0] === data && row[1] === horario && row[5] === "agendado" && tail(row[4]) === t && (!profId || row[2] === profId),
      );
    }
  }

  if (rowIndex === -1) return false;

  const profIdRow = rows[rowIndex][2];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex + 1}:K${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[data, horario, profIdRow, "", "", "livre", "", "", "", "", ""]] },
  });
  return true;
}

async function cancelSlotAdmin(data, horario, profId = null) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });
  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[5] === "agendado" && (!profId || row[2] === profId),
  );
  if (rowIndex === -1) return false;

  const clientPhone = rows[rowIndex][4];
  const clientName = rows[rowIndex][3];
  const profIdRow = rows[rowIndex][2];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex + 1}:K${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[data, horario, profIdRow, "", "", "livre", "", "", "", "", ""]] },
  });
  return { clientPhone, clientName, profId: profIdRow };
}

async function rescheduleSlot(dataAtual, horarioAtual, dataNova, horarioNovo, nome, telefone) {
  // Busca o profissional e serviço do agendamento original
  const original = await getSlotInfo(dataAtual, horarioAtual, null, telefone);
  if (!original) return false;

  const profId = original.profissional;
  const servico = original.servico;

  const cancelado = await cancelSlot(dataAtual, horarioAtual, telefone, profId);
  if (!cancelado || cancelado === "bloqueado_tempo") return cancelado;

  const agendado = await bookSlot(dataNova, horarioNovo, profId, servico, nome, telefone);
  if (!agendado) {
    await bookSlot(dataAtual, horarioAtual, profId, servico, nome, telefone);
    return false;
  }
  return true;
}

// ── Consultas ────────────────────────────────────────────────────────────────

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
      const found = rows.slice(1).find((row) => row[4] === telefone && row[3]?.trim());
      if (found) return found[3].trim();
    } catch (e) {}
  }
  return null;
}

// profId=null → todos os profissionais
// profId=X   → somente aquele profissional
async function getSlotInfo(data, horario, profId = null, telefone = null) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:K`,
    });
    const rows = response.data.values || [];
    const row = rows.find(
      (r) =>
        r[0] === data && r[1] === horario &&
        (!profId || r[2] === profId) &&
        (!telefone || r[4] === telefone),
    );
    if (!row) return null;
    return { data: row[0], horario: row[1], profissional: row[2], nome: row[3] || "", telefone: row[4] || "", status: row[5] || "livre", servico: row[6] || "" };
  } catch (e) {
    return null;
  }
}

// profId=null → todos | profId=X → filtrado
async function getDaySchedule(data, profId = null) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:G`,
    });
    const rows = response.data.values || [];
    return rows
      .slice(1)
      .filter((row) => row[0] === data && (!profId || row[2] === profId))
      .map((row) => ({ horario: row[1], profissional: row[2], nome: row[3] || "", status: row[5] || "livre", servico: row[6] || "" }))
      .sort((a, b) => a.horario.localeCompare(b.horario));
  } catch (e) {
    return [];
  }
}

async function updateClientPhone(data, horario, telefone, profId = null) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(data);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
  });
  const rows = response.data.values || [];
  const rowIndex = rows.findIndex(
    (row) => row[0] === data && row[1] === horario && row[5] === "agendado" && (!profId || row[2] === profId),
  );
  if (rowIndex === -1) return false;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!E${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[telefone]] },
  });
  return true;
}

// ── Lembretes ────────────────────────────────────────────────────────────────

async function getAppointmentsForReminder(horasAntes) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetNames = getRelevantSheetNames();
  const n = now();
  const appointments = [];
  const tipo = `${horasAntes}h`;

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:K`,
      });
      const rows = response.data.values || [];

      rows.slice(1).forEach((row, i) => {
        if (row[5] !== "agendado") return;
        if (!row[0] || !row[1] || !row[4]) return;

        const lembretes = row[9] || "";
        if (lembretes.includes(tipo)) return;

        const [year, month, day] = row[0].split("-").map(Number);
        const [hour, minute] = row[1].split(":").map(Number);
        const slotDate = new Date(year, month - 1, day, hour, minute);
        const diffHoras = (slotDate - n) / (1000 * 60 * 60);
        const dentroJanela = diffHoras >= horasAntes - 0.5 && diffHoras < horasAntes + 0.5;
        if (!dentroJanela) return;

        if (horasAntes === 24) {
          if (!row[8]) return;
          const criadoEm = new Date(
            row[8].split(", ")[0].split("/").reverse().join("-") + "T" + row[8].split(", ")[1],
          );
          if ((slotDate - criadoEm) / (1000 * 60 * 60 * 24) < 2) return;
        }

        appointments.push({
          data: row[0], horario: row[1], profissional: row[2],
          nome: row[3], telefone: row[4], sheetName, rowIndex: i + 2, lembretes,
        });
      });
    } catch (e) {}
  }
  return appointments;
}

async function markReminderSent(sheetName, rowIndex, lembretes, tipo) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const n = now();
  const hhmm = `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
  const novo = lembretes ? `${lembretes},${tipo}@${hhmm}` : `${tipo}@${hhmm}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!J${rowIndex}`,
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
    range: `${sheetName}!J${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[novo]] },
  });
}

async function getUnconfirmedReminders(tipo, minutosGraca) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetNames = getRelevantSheetNames();
  const n = now();
  const appointments = [];
  const avisoTag = `${tipo}-aviso`;
  const regex = new RegExp(`${tipo}@(\\d{2}:\\d{2})`);

  for (const sheetName of sheetNames) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:K`,
      });
      const rows = response.data.values || [];

      rows.slice(1).forEach((row, i) => {
        if (row[5] !== "agendado") return;
        if (!row[0] || !row[1] || !row[4]) return;

        const lembretes = row[9] || "";
        if (lembretes.includes(avisoTag)) return;

        const match = lembretes.match(regex);
        if (!match) return;

        const [hh, mm] = match[1].split(":").map(Number);
        const sent = new Date(n);
        sent.setHours(hh, mm, 0, 0);
        if (sent > n) sent.setDate(sent.getDate() - 1);

        if ((n - sent) / (1000 * 60) < minutosGraca) return;

        appointments.push({
          data: row[0], horario: row[1], profissional: row[2],
          nome: row[3], telefone: row[4], sheetName, rowIndex: i + 2, lembretes,
        });
      });
    } catch (e) {}
  }
  return appointments;
}

// ── Resumo semanal ────────────────────────────────────────────────────────────

async function getWeeklySummary() {
  const n = now();
  const PAD = (x) => String(x).padStart(2, "0");
  const FMT = (d) => `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;

  const pastDates = Array.from({ length: 6 }, (_, i) => { const d = new Date(n); d.setDate(n.getDate() - 6 + i); return FMT(d); });
  const nextDates = Array.from({ length: 6 }, (_, i) => { const d = new Date(n); d.setDate(n.getDate() + 1 + i); return FMT(d); });

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
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:F` });
      for (const row of (response.data.values || []).slice(1)) {
        if (monthDates.has(row[0]) && row[5] === "agendado") {
          if (!slotsByDate[row[0]]) slotsByDate[row[0]] = [];
          slotsByDate[row[0]].push({ horario: row[1], nome: row[3] || "Cliente", profissional: row[2] });
        }
      }
    } catch (e) {}
  }

  return {
    semanaPassada: pastDates.flatMap((d) => (slotsByDate[d] || []).map((s) => ({ ...s, data: d }))),
    proximaSemana: nextDates.flatMap((d) => slotsByDate[d] || []),
  };
}

// ── Slots para o painel web ────────────────────────────────────────────────────
// profId=null → agrega por horário (livre se qualquer prof disponível)
// profId=X   → filtra por profissional
async function getSlotsForDates(dates, profId = null) {
  if (!dates.length) return { dates: [] };
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const byMonth = {};
  for (const date of dates) {
    const sheetName = getSheetName(date);
    if (!byMonth[sheetName]) byMonth[sheetName] = new Set();
    byMonth[sheetName].add(date);
  }

  // grouped[date][horario] = [{ profissional, status }]
  const grouped = {};

  for (const [sheetName, monthDates] of Object.entries(byMonth)) {
    try {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:F` });
      for (const row of (response.data.values || []).slice(1)) {
        if (!monthDates.has(row[0])) continue;
        if (profId && row[2] !== profId) continue;

        if (!grouped[row[0]]) grouped[row[0]] = {};
        if (!grouped[row[0]][row[1]]) grouped[row[0]][row[1]] = [];
        grouped[row[0]][row[1]].push({ profissional: row[2], status: row[5] || "livre" });
      }
    } catch (e) {}
  }

  const slotsByDate = {};
  for (const [date, horarios] of Object.entries(grouped)) {
    slotsByDate[date] = Object.entries(horarios)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([horario, profs]) => {
        if (profId) {
          return { horario, status: profs[0]?.status || "livre" };
        }
        const disponiveis = profs.filter((p) => p.status === "livre").map((p) => p.profissional);
        const hasLivre = disponiveis.length > 0;
        const allBloqueado = profs.every((p) => p.status === "bloqueado");
        return {
          horario,
          status: hasLivre ? "livre" : allBloqueado ? "bloqueado" : "agendado",
          profissionaisDisponiveis: disponiveis,
        };
      });
  }

  return { dates: dates.map((date) => ({ date, slots: slotsByDate[date] || [] })) };
}

// ── Horário customizado ────────────────────────────────────────────────────────
// profId=null → aplica para todos os profissionais
async function setCustomHours(date, inicio, fim, profId = null) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetName = getSheetName(date);

  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:K` });
  const rows = response.data.values || [];

  const desiredSlots = new Set();
  for (let h = inicio; h < fim; h++) desiredSlots.add(`${String(h).padStart(2, "0")}:00`);

  // Agrupa horários existentes por profissional
  const existingByProf = {};
  const updates = [];
  const warnings = [];

  rows.slice(1).forEach((row, i) => {
    if (row[0] !== date) return;
    if (profId && row[2] !== profId) return;
    const sheetRow = i + 2;
    const horario = row[1];
    const status = row[5] || "livre";
    const pId = row[2];

    if (!existingByProf[pId]) existingByProf[pId] = new Set();
    existingByProf[pId].add(horario);

    if (desiredSlots.has(horario)) {
      if (status === "bloqueado") updates.push({ range: `${sheetName}!F${sheetRow}`, values: [["livre"]] });
    } else {
      if (status === "agendado") warnings.push(`⚠️ ${horario} — *${row[3]}* (${pId}) agendado fora do novo horário`);
      else if (status !== "bloqueado") updates.push({ range: `${sheetName}!F${sheetRow}`, values: [["bloqueado"]] });
    }
  });

  const targetProfs = profId
    ? getProfissionais().filter((p) => p.id === profId)
    : getProfissionais();

  const newSlots = [];
  for (const prof of targetProfs) {
    const existing = existingByProf[prof.id] || new Set();
    const novos = [...desiredSlots].sort().filter((h) => !existing.has(h));
    newSlots.push(...novos.map((h) => [date, h, prof.id, "", "", "livre", "", "", "", "", ""]));
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: "RAW", data: updates } });
  }
  if (newSlots.length > 0) {
    await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:K`, valueInputOption: "RAW", requestBody: { values: newSlots } });
  }

  return { warnings };
}

module.exports = {
  getAvailableSlots, getProfissionaisDisponibilidade,
  bookSlot, bookSlotAdmin, cancelSlot, cancelSlotAdmin,
  rescheduleSlot, getClientName, getAppointmentsForReminder, markReminderSent,
  appendLembretes, getUnconfirmedReminders, countClientAppointmentsOnDay,
  getSlotInfo, getDaySchedule, updateClientPhone, getWeeklySummary,
  getSlotsForDates, setCustomHours, getProfissionais, isMultiProfessional,
};
