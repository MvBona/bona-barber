console.log("=== INICIANDO ===");

process.on("uncaughtException", (err) => {
  console.error("ERRO FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("PROMISE REJEITADA:", err.message);
  console.error(err.stack);
  process.exit(1);
});

console.log("carregando dotenv...");
require("dotenv").config();

console.log("carregando express...");
const express = require("express");
const path = require("path");
const schedule = require("node-cron");
const { tr, clientLanguages } = require("./i18n");

console.log("carregando sheets...");
const {
  getAvailableSlots,
  bookSlot,
  bookSlotAdmin,
  cancelSlot,
  cancelSlotAdmin,
  rescheduleSlot,
  getAppointmentsForReminder,
  markReminderSent,
  appendLembretes,
  getUnconfirmedReminders,
  countClientAppointmentsOnDay,
  getSlotInfo,
  getDaySchedule,
  updateClientPhone,
  getClientName,
  getWeeklySummary,
  getSlotsForDates,
} = require("./sheets");

console.log("carregando ai...");
const { interpretMessage, addToHistory, clearAllHistories } = require("./ai");

console.log("carregando transcribe...");
const { transcribeAudio } = require("./transcribe");

console.log("carregando scheduler...");
const {
  generateWeeklySlots,
  resetSlots,
  blockDay,
  blockSlot,
  blockPeriod,
  unblockDay,
  unblockSlot,
  unblockPeriod,
} = require("./scheduler");

console.log("todos os módulos carregados!");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const BARBERSHOP_PHONE = process.env.BARBERSHOP_PHONE;

const debounceTimers = new Map();
const pendingMessages = new Map();
// Agendamento pendente aguardando nome válido: phone → { data, horario }
const waitingForNameToBook = new Map();
// Cancelamento aguardando motivo: phone → { data, horario }
// Handoff humano ativo: clientPhone → { name }
const humanHandoff = new Map();
const waitingForCancelReason = new Map();
// Barbeiro agendou sem número: barberPhone → { data, horario, nome }
const waitingForClientPhone = new Map();

function fmtDate(iso) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

// Verifica se nome parece real
function isValidName(name) {
  if (!name || name.trim().length < 3) return false;
  if (/\p{Emoji}/u.test(name)) return false;
  if (/\d/.test(name)) return false;
  const suspicious = [
    "uber",
    "taxi",
    "delivery",
    "ifood",
    "moto",
    "bot",
    "test",
    "zap",
    "whats",
  ];
  if (suspicious.some((w) => name.toLowerCase().includes(w))) return false;
  if (name === name.toUpperCase() && name.replace(/\s/g, "").length <= 4)
    return false;
  return true;
}

async function sendMessage(phone, message) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Token": ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify({ phone, message }),
  });
  const data = await response.json();
  console.log("Resposta enviada:", data);
}

async function notifyBarber(message) {
  if (!BARBERSHOP_PHONE) return;
  try {
    await sendMessage(BARBERSHOP_PHONE, message);
  } catch (error) {
    console.error("Erro ao notificar barbeiro:", error.message);
  }
}

async function sendWeeklySummary() {
  try {
    const { semanaPassada, proximaSemana } = await getWeeklySummary();

    const total = semanaPassada.length;
    const nomes = [...new Set(semanaPassada.map((s) => s.nome))];
    const listaClientes = nomes.length
      ? nomes.map((n) => `• ${n}`).join("\n")
      : "• Nenhum atendimento registrado";

    const msg =
      `📊 *Resumo da semana*\n\n` +
      `✂️ *Semana passada — ${total} atendimento${total !== 1 ? "s" : ""}*\n` +
      `${listaClientes}\n\n` +
      `📅 *Semana que vem — ${proximaSemana.length} agendamento${proximaSemana.length !== 1 ? "s" : ""} confirmado${proximaSemana.length !== 1 ? "s" : ""}*\n\n` +
      `Bom descanso! 🙌`;

    await notifyBarber(msg);
    console.log("Resumo semanal enviado ao barbeiro.");
  } catch (error) {
    console.error("Erro ao enviar resumo semanal:", error.message);
  }
}

async function sendUnconfirmedNotifications(tipo, minutosGraca) {
  try {
    const appointments = await getUnconfirmedReminders(tipo, minutosGraca);
    for (const appt of appointments) {
      const prazo = tipo === "24h" ? "2h" : "20min";
      const msg =
        `⚠️ *Sem confirmação (${prazo})*\n` +
        `👤 ${appt.nome || "Cliente"}\n` +
        `📞 ${appt.telefone}\n` +
        `📅 ${fmtDate(appt.data)} às ${appt.horario}\n` +
        `Lembrete de ${tipo} enviado mas sem resposta.`;
      await notifyBarber(msg);
      await appendLembretes(appt.sheetName, appt.rowIndex, appt.lembretes, `${tipo}-aviso`);
      console.log(`Aviso sem-resposta (${tipo}) enviado para barbeiro — ${appt.nome} ${appt.telefone}`);
    }
  } catch (error) {
    console.error(`Erro ao verificar sem-resposta ${tipo}:`, error.message);
  }
}

async function sendReminders(horasAntes) {
  try {
    const appointments = await getAppointmentsForReminder(horasAntes);
    console.log(
      `Lembretes ${horasAntes}h: ${appointments.length} agendamento(s) encontrado(s)`,
    );
    for (const appt of appointments) {
      const nome = process.env.BARBERSHOP_NAME || "barbearia";
      const msg = horasAntes === 24
        ? tr(appt.telefone, "reminder24h", appt.horario, nome)
        : tr(appt.telefone, "reminder2h", appt.horario, nome);
      await sendMessage(appt.telefone, msg);
      await markReminderSent(appt.sheetName, appt.rowIndex, appt.lembretes, `${horasAntes}h`);
      addToHistory(appt.telefone, "assistant", msg);
      console.log(
        `Lembrete ${horasAntes}h enviado para ${appt.nome} (${appt.telefone})`,
      );
    }
  } catch (error) {
    console.error(`Erro ao enviar lembretes ${horasAntes}h:`, error.message);
  }
}

async function processBarberCommand(text) {
  const normalized = text
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  const currentYear = now.getFullYear();
  const currentMonth = String(now.getMonth() + 1).padStart(2, "0");

  const monthNames = {
    janeiro: "01",
    fevereiro: "02",
    marco: "03",
    abril: "04",
    maio: "05",
    junho: "06",
    julho: "07",
    agosto: "08",
    setembro: "09",
    outubro: "10",
    novembro: "11",
    dezembro: "12",
  };

  function parseMonth(m) {
    if (/^\d+$/.test(m)) return m.padStart(2, "0");
    return monthNames[m] || null;
  }

  function extractDate(str) {
    if (str.includes("hoje"))
      return `${currentYear}-${currentMonth}-${String(now.getDate()).padStart(2, "0")}`;
    if (str.includes("amanha")) {
      const t = new Date(now);
      t.setDate(now.getDate() + 1);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    }
    const match = str.match(
      /(?:dia\s+)?(\d{1,2})[\/\s](?:do\s+|de\s+)?(\d{1,2}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?/,
    );
    if (!match) return null;
    const day = match[1].padStart(2, "0");
    const month = parseMonth(match[2]);
    const year = match[3] || currentYear;
    if (!month) return null;
    return `${year}-${month}-${day}`;
  }

  function extractTime(str) {
    const periodMatch = str.match(/(\d{1,2})\s+da\s+(manha|tarde|noite)/);
    if (periodMatch) {
      let hour = parseInt(periodMatch[1]);
      if (periodMatch[2] === "tarde" && hour < 12) hour += 12;
      if (periodMatch[2] === "noite" && hour < 12) hour += 12;
      return String(hour).padStart(2, "0") + ":00";
    }
    const match = str.match(/\b(\d{1,2})(?:h|:00)\b/);
    if (!match) return null;
    return match[1].padStart(2, "0") + ":00";
  }

  function extractTwoTimes(str) {
    const match = str.match(/(\d{1,2})h?\s+(?:para|pro|pra).+?(\d{1,2})h/);
    if (!match) return null;
    return {
      de: match[1].padStart(2, "0") + ":00",
      para: match[2].padStart(2, "0") + ":00",
    };
  }

  function extractTwoDates(str) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const dayAfter = new Date(now);
    dayAfter.setDate(now.getDate() + 2);
    const fmt = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const fromMatch = str.match(/(?:de\s+)?(.+?)\s+(?:para|pro|pra)\s+(.+)/);
    if (!fromMatch) return null;
    function parseDateStr(s) {
      if (s.includes("depois de amanha")) return fmt(dayAfter);
      if (s.includes("amanha")) return fmt(tomorrow);
      if (s.includes("hoje")) return fmt(now);
      return extractDate(s);
    }
    const from = parseDateStr(fromMatch[1]);
    const to = parseDateStr(fromMatch[2]);
    if (!from || !to) return null;
    return { de: from, para: to };
  }

  function extractPeriod(str) {
    const match = str.match(
      /(?:dia\s+)?(\d{1,2})[\/\s](?:do\s+|de\s+)?(\d{1,2}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?\s+a[o]?\s+(?:dia\s+)?(\d{1,2})[\/\s](?:do\s+|de\s+)?(\d{1,2}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?/,
    );
    if (!match) return null;
    const month1 = parseMonth(match[2]);
    const month2 = parseMonth(match[5]);
    if (!month1 || !month2) return null;
    return {
      inicio: `${match[3] || currentYear}-${month1}-${match[1].padStart(2, "0")}`,
      fim: `${match[6] || currentYear}-${month2}-${match[4].padStart(2, "0")}`,
    };
  }

  const hasUnblock =
    normalized.includes("desbloquear") ||
    normalized.includes("desbloqueia") ||
    normalized.includes("desbloqueie") ||
    normalized.includes("abrir dia") ||
    normalized.includes("abre dia") ||
    normalized.includes("liberar") ||
    normalized.includes("libera");

  if (hasUnblock) {
    const timeMatch = extractTime(normalized);
    const dateMatch = extractDate(normalized);
    if (timeMatch && dateMatch) {
      const count = await unblockSlot(dateMatch, timeMatch);
      const [y, m, d] = dateMatch.split("-");
      return count > 0
        ? `🟢 ${timeMatch} de ${d}/${m} liberado.`
        : `❌ Horário ${timeMatch} de ${d}/${m} não estava bloqueado.`;
    }
    const period = extractPeriod(normalized);
    if (period) {
      const count = await unblockPeriod(period.inicio, period.fim);
      return count > 0
        ? `🟢 Período liberado — ${count} horário(s) desbloqueado(s).`
        : `❌ Nenhum horário bloqueado encontrado nesse período.`;
    }
    if (dateMatch) {
      const count = await unblockDay(dateMatch);
      const [y, m, d] = dateMatch.split("-");
      return count > 0
        ? `🟢 ${d}/${m} liberado — ${count} horário(s) desbloqueado(s).`
        : `❌ Nenhum horário bloqueado em ${d}/${m}.`;
    }
    const onlyDay = normalized.match(/(?:dia\s+)?(\d{1,2})(?!\s*[\/h:])/);
    if (onlyDay) {
      const day = onlyDay[1].padStart(2, "0");
      const count = await unblockDay(`${currentYear}-${currentMonth}-${day}`);
      return count > 0
        ? `🟢 ${day}/${currentMonth} liberado — ${count} horário(s) desbloqueado(s).`
        : `❌ Nenhum horário bloqueado em ${day}/${currentMonth}.`;
    }
  }

  const hasBlock =
    normalized.includes("bloquear") ||
    normalized.includes("bloqueia") ||
    normalized.includes("bloqueie") ||
    normalized.includes("fechar") ||
    normalized.includes("fecha") ||
    normalized.includes("cancelar dia") ||
    normalized.includes("folga");

  if (hasBlock) {
    const timeMatch = extractTime(normalized);
    const dateMatch = extractDate(normalized);
    if (timeMatch && dateMatch) {
      const count = await blockSlot(dateMatch, timeMatch);
      const [y, m, d] = dateMatch.split("-");
      return count > 0
        ? `🔴 ${timeMatch} de ${d}/${m} bloqueado.`
        : `❌ Horário ${timeMatch} não encontrado em ${d}/${m}.`;
    }
    const period = extractPeriod(normalized);
    if (period) {
      const count = await blockPeriod(period.inicio, period.fim);
      return count > 0
        ? `🔴 Período bloqueado — ${count} horário(s).`
        : `❌ Nenhum horário disponível nesse período.`;
    }
    if (dateMatch) {
      const count = await blockDay(dateMatch);
      const [y, m, d] = dateMatch.split("-");
      return count > 0
        ? `🔴 ${d}/${m} bloqueado — ${count} horário(s).`
        : `❌ Nenhum horário disponível em ${d}/${m}.`;
    }
  }

  const hasReschedule =
    normalized.includes("passa") ||
    normalized.includes("muda") ||
    normalized.includes("move") ||
    normalized.includes("transfere") ||
    normalized.includes("reagenda");

  if (hasReschedule) {
    const times = extractTwoTimes(normalized);
    const dates = extractTwoDates(normalized);

    if (times && dates) {
      const slotInfo = await getSlotInfo(dates.de, times.de);
      if (!slotInfo || slotInfo.status !== "agendado") {
        const [y, m, d] = dates.de.split("-");
        return `❌ Nenhum agendamento em ${d}/${m} às ${times.de}.`;
      }

      const newSlotInfo = await getSlotInfo(dates.para, times.para);
      if (!newSlotInfo) {
        const [y, m, d] = dates.para.split("-");
        return `❌ Horário ${times.para} não existe na agenda de ${d}/${m}.`;
      }

      if (newSlotInfo.status === "agendado") {
        const [y, m, d] = dates.para.split("-");
        return `⚠️ ${times.para} de ${d}/${m} já está com *${newSlotInfo.nome}*.\nEscolha outro horário para ${slotInfo.nome}.`;
      }

      await cancelSlotAdmin(dates.de, times.de);
      const booked = await bookSlotAdmin(
        dates.para,
        times.para,
        slotInfo.nome,
        slotInfo.telefone,
      );

      if (!booked) {
        await bookSlotAdmin(
          dates.de,
          times.de,
          slotInfo.nome,
          slotInfo.telefone,
        );
        return `❌ Não consegui reagendar. Horário mantido em ${dates.de.split("-").reverse().slice(0,2).join("/")}.`;
      }

      const [yd, md, dd] = dates.de.split("-");
      const [yp, mp, dp] = dates.para.split("-");
      await sendMessage(
        slotInfo.telefone,
        `Olá ${slotInfo.nome}! Seu horário foi alterado de ${dd}/${md} às ${times.de} para ${dp}/${mp} às ${times.para} pela barbearia.`,
      );
      return `✅ *${slotInfo.nome}* reagendado\n${dd}/${md} às ${times.de} → ${dp}/${mp} às ${times.para}\n📲 Cliente notificado.`;
    }
  }

  const hasCancel =
    normalized.includes("cancela") ||
    normalized.includes("cancelar") ||
    normalized.includes("remove") ||
    normalized.includes("apaga");

  if (hasCancel) {
    const timeMatch = extractTime(normalized);
    const dateMatch = extractDate(normalized);
    if (timeMatch && dateMatch) {
      const cancelled = await cancelSlotAdmin(dateMatch, timeMatch);
      const [y, m, d] = dateMatch.split("-");
      if (cancelled) {
        await sendMessage(
          cancelled.clientPhone,
          `Olá ${cancelled.clientName}! Seu horário do dia ${d}/${m} às ${timeMatch} foi cancelado pela barbearia. Entre em contato para reagendar.`,
        );
        return `❎ *${cancelled.clientName}* — ${d}/${m} às ${timeMatch} cancelado\n📲 Cliente notificado.`;
      }
      return `❌ Nenhum agendamento em ${d}/${m} às ${timeMatch}.`;
    }
  }

  const hasBook =
    normalized.includes("agenda") ||
    normalized.includes("marca") ||
    normalized.includes("reserva");

  if (hasBook) {
    const timeMatch = extractTime(normalized);
    const dateMatch = extractDate(normalized);
    if (timeMatch && dateMatch) {
      // Extrai número do cliente (8-13 dígitos, ignora partes de datas)
      const phoneExtract = (() => {
        const sem_datas = normalized.replace(/\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g, "");
        const m = sem_datas.match(/\b(\d{8,13})\b/);
        if (!m) return null;
        let num = m[1];
        if (!num.startsWith("55") && num.length <= 11) num = "55" + num;
        return num.length >= 10 ? num : null;
      })();
      const clientPhone = phoneExtract || BARBERSHOP_PHONE;

      // Extrai nome removendo todos os outros elementos da mensagem
      const afterVerb = normalized.replace(/.*?(?:agenda|marca|reserva)\s+(?:pra?\s+|para\s+)?/, "");
      const nameRaw = afterVerb
        .replace(/\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g, "")
        .replace(/\b\d{8,13}\b/g, "")
        .replace(/\b\d{1,2}\s*h\b/g, "")
        .replace(/\b(?:dia|hoje|amanha|às|as|de|do|da|para|pra|no|na)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const clientName = nameRaw
        ? nameRaw.replace(/\b\w/g, (c) => c.toUpperCase())
        : "Cliente";

      const existing = await getSlotInfo(dateMatch, timeMatch);
      if (existing && existing.status === "agendado") {
        const [y, m, d] = dateMatch.split("-");
        return `⚠️ ${d}/${m} às ${timeMatch} já está com *${existing.nome}*.`;
      }
      const booked = await bookSlotAdmin(dateMatch, timeMatch, clientName, clientPhone);
      const [y, m, d] = dateMatch.split("-");
      if (booked) {
        if (!phoneExtract) {
          waitingForClientPhone.set(BARBERSHOP_PHONE, { data: dateMatch, horario: timeMatch, nome: clientName });
          return `✅ Agendado *${clientName}* — ${d}/${m} às ${timeMatch}.\n⚠️ Sem número — cliente não receberá lembretes.\nEnvia o número do cliente para eu registrar.`;
        }
        return `✅ Agendado *${clientName}* — ${d}/${m} às ${timeMatch}.\n📞 ${phoneExtract}`;
      }
      return `❌ Não consegui agendar ${clientName} em ${d}/${m} às ${timeMatch}.`;
    }
  }

  const hasAgenda =
    normalized.includes("agenda hoje") ||
    normalized.includes("agenda amanha") ||
    normalized.includes("ver agenda") ||
    normalized.includes("agenda do dia") ||
    normalized.includes("quem tem hoje") ||
    normalized.includes("quem tem amanha") ||
    (normalized.includes("agenda") &&
      (normalized.includes("hoje") ||
        normalized.includes("amanha") ||
        extractDate(normalized)));

  if (hasAgenda) {
    const dateMatch =
      extractDate(normalized) ||
      (normalized.includes("hoje")
        ? `${currentYear}-${currentMonth}-${String(now.getDate()).padStart(2, "0")}`
        : null) ||
      (normalized.includes("amanha")
        ? (() => {
            const t = new Date(now);
            t.setDate(now.getDate() + 1);
            return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
          })()
        : null);

    if (dateMatch) {
      const schedule = await getDaySchedule(dateMatch);
      const [y, m, d] = dateMatch.split("-");
      if (schedule.length === 0)
        return `📅 *Agenda ${d}/${m}*\n\nNenhum horário cadastrado.`;
      const lines = schedule.map((s) => {
        if (s.status === "agendado") return `🔴 ${s.horario} — ${s.nome}`;
        if (s.status === "bloqueado") return `⚪ ${s.horario} — bloqueado`;
        return `🟢 ${s.horario} — livre`;
      });
      return `📅 *Agenda ${d}/${m}*\n\n${lines.join("\n")}`;
    }
  }

  const hasHelp =
    normalized === "ajuda" ||
    normalized === "help" ||
    normalized === "comandos" ||
    normalized.includes("o que posso fazer") ||
    normalized.includes("como usar");

  if (hasHelp) {
    return `🛠️ *Comandos disponíveis*\n\n*📅 Ver agenda:*\n"agenda hoje"\n"agenda amanhã"\n"agenda 15/06"\n\n*🔒 Bloquear:*\n"bloqueia 15/06"\n"bloqueia 16h do dia 15/06"\n"bloqueia 15/06 ao 22/06"\n\n*🔓 Desbloquear:*\n"desbloqueia 15/06"\n"desbloqueia 16h do dia 15/06"\n\n*👤 Agendar cliente:*\n"marca João dia 15/06 às 14h"\n\n*❌ Cancelar:*\n"cancela 15/06 às 14h"\n\n*🔄 Reagendar:*\n"passa João de 15/06 14h para 16/06 10h"\n\n*🗑️ Zerar mês atual:*\n"zerar agenda" → confirmar reset\n\n*🗑️🗑️ Zerar tudo:*\n"zerar tudo" → confirmar tudo\n\n*🤝 Encerrar atendimento direto:*\n"encerrar João" ou "encerrar 5511999999999"`;
  }

  // Barbeiro encerra handoff: "encerrar 5511999999999" ou "encerrar João"
  const encerrarMatch = text.match(/^encerrar\s+(.+)$/i);
  if (encerrarMatch) {
    const termo = encerrarMatch[1].trim();
    let clientPhone = null;
    if (/^\d+$/.test(termo)) {
      clientPhone = humanHandoff.has(termo) ? termo : null;
    } else {
      for (const [p, { name: n }] of humanHandoff.entries()) {
        if (n.toLowerCase().includes(termo.toLowerCase())) {
          clientPhone = p;
          break;
        }
      }
    }
    if (!clientPhone) return `❌ Nenhum atendimento ativo encontrado para "${termo}".`;
    humanHandoff.delete(clientPhone);
    await sendMessage(clientPhone, tr(clientPhone, "handoffEnd"));
    return `✅ Atendimento encerrado. Bot retomado para ${clientPhone}.`;
  }

  if (normalized === "zerar agenda") {
    return `⚠️ *Vai apagar todos os agendamentos do mês atual e recriar do zero.*\n\nManda *confirmar reset* pra prosseguir.`;
  }

  if (normalized === "zerar tudo") {
    return `⚠️ *Vai apagar TODOS os agendamentos de todos os meses e recriar do zero.*\n\nManda *confirmar tudo* pra prosseguir.`;
  }

  if (normalized === "confirmar reset" || normalized === "confirmar tudo") {
    const scope = normalized === "confirmar tudo" ? "tudo" : "mes";
    try {
      const { apagados } = await resetSlots(scope);
      let msg = `✅ Agenda ${scope === "tudo" ? "completa" : "do mês"} zerada e recriada.\n`;
      if (apagados.length === 0) {
        msg += "Nenhum agendamento foi apagado.";
      } else {
        msg += `\n*Agendamentos apagados (${apagados.length}):*\n`;
        msg += apagados
          .map((a) => {
            const [, m, d] = a.data.split("-");
            return `👤 ${a.nome} — ${d}/${m} às ${a.horario} — 📞 ${a.telefone}`;
          })
          .join("\n");
      }
      return msg;
    } catch (e) {
      return `❌ Erro ao zerar: ${e.message}`;
    }
  }

  const pareceComando =
    hasBlock ||
    hasUnblock ||
    hasReschedule ||
    hasCancel ||
    hasAgenda;
  if (pareceComando)
    return `❓ Não entendi. Digite *ajuda* para ver os comandos disponíveis.`;

  return null;
}

async function processAccumulatedMessages(phone, name) {
  const messages = pendingMessages.get(phone) || [];
  pendingMessages.delete(phone);
  debounceTimers.delete(phone);

  if (messages.length === 0) return;

  // Se o nome do WhatsApp não for válido, busca no histórico do sheet
  if (!isValidName(name)) {
    const savedName = await getClientName(phone);
    if (savedName) name = savedName;
  }

  const combinedText = messages.join(" ");
  console.log(
    `Processando ${messages.length} mensagem(ns) de ${name} (${phone}): ${combinedText}`,
  );

  if (phone === BARBERSHOP_PHONE) {
    if (waitingForClientPhone.has(phone)) {
      const { data, horario, nome } = waitingForClientPhone.get(phone);
      const digits = combinedText.replace(/\D/g, "");
      const num = digits.length <= 11 && !digits.startsWith("55") ? "55" + digits : digits;
      if (num.length >= 10 && num.length <= 13) {
        waitingForClientPhone.delete(phone);
        const updated = await updateClientPhone(data, horario, num);
        const [, m, d] = data.split("-");
        await sendMessage(phone, updated
          ? `✅ Número registrado para *${nome}* — ${d}/${m} às ${horario}.\n📞 ${num}`
          : `❌ Não encontrei o agendamento de ${nome} em ${d}/${m} às ${horario}.`
        );
        return;
      }
      await sendMessage(phone, "Número inválido. Envia só os dígitos, ex: *21999991234*");
      return;
    }

    const commandResponse = await processBarberCommand(combinedText);
    if (commandResponse) {
      await sendMessage(phone, commandResponse);
      return;
    }
  }

  // Verifica se está aguardando nome para confirmar agendamento pendente
  if (waitingForNameToBook.has(phone)) {
    const trimmed = combinedText.trim();
    const words = trimmed
      .split(/\s+/)
      .filter((w) => /^[a-záàãâéêíóôõúçA-Z]+$/i.test(w));
    const blockedWords = [
      "bom",
      "boa",
      "dia",
      "tarde",
      "noite",
      "oi",
      "ola",
      "hey",
      "opa",
      "sim",
      "nao",
      "ok",
      "ate",
      "tchau",
      "obrigado",
      "obrigada",
      "quero",
      "preciso",
    ];

    const hasBlocked = words.some((w) =>
      blockedWords.includes(w.toLowerCase()),
    );

    if (
      !hasBlocked &&
      words.length >= 1 &&
      words.length <= 4 &&
      trimmed.length >= 3
    ) {
      const nomeLimpo = words
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
      const { data, horario } = waitingForNameToBook.get(phone);
      waitingForNameToBook.delete(phone);
      const booked = await bookSlot(data, horario, nomeLimpo, phone);
      if (!booked) {
        await sendMessage(
          phone,
          tr(phone, "slotTaken"),
        );
      } else {
        await sendMessage(phone, tr(phone, "bookingConfirm", nomeLimpo, horario));
        const lang1 = clientLanguages.get(phone) || "pt";
        if (lang1 !== "pt") await sendMessage(phone, tr(phone, "langNote"));
        await notifyBarber(
          `✅ *Novo agendamento*\n👤 ${nomeLimpo}\n📅 ${fmtDate(data)}\n🕐 ${horario}`,
        );
      }
      return;
    }

    // Não parece nome — pede de novo
    await sendMessage(phone, tr(phone, "invalidName"));
    return;
  }

  // Handoff humano ativo — barbeiro está respondendo direto, bot não interfere
  if (humanHandoff.has(phone)) return;

  // Verifica se está aguardando motivo de cancelamento
  if (waitingForCancelReason.has(phone)) {
    const { data, horario } = waitingForCancelReason.get(phone);
    const motivo = combinedText.trim();
    waitingForCancelReason.delete(phone);
    const cancelled = await cancelSlot(data, horario, phone);
    if (cancelled === "bloqueado_tempo") {
      await sendMessage(phone, tr(phone, "cancelTooLate"));
      await notifyBarber(`⚠️ *Tentativa de cancelamento tardio*\n👤 ${name}\n📞 ${phone}\n📅 ${fmtDate(data)} às ${horario}\n📝 Motivo: ${motivo}`);
    } else if (!cancelled) {
      await sendMessage(phone, tr(phone, "slotNotFound"));
    } else {
      await sendMessage(phone, tr(phone, "cancelSuccess"));
      await notifyBarber(`❎ *Cancelamento*\n👤 ${name}\n📅 ${fmtDate(data)}\n🕐 ${horario}\n📝 Motivo: ${motivo}`);
    }
    return;
  }

  // Comandos de ajuda e contato do barbeiro (somente clientes)
  if (phone !== BARBERSHOP_PHONE) {
    const norm = combinedText
      .toLowerCase()
      .trim()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");

    const isHelp =
      norm === "ajuda" ||
      norm === "help" ||
      norm === "comandos" ||
      norm.includes("como funciona") ||
      norm.includes("o que voce faz") ||
      norm.includes("o que voce pode");

    if (isHelp) {
      await sendMessage(
        phone,
        tr(phone, "help"),
      );
      return;
    }

    const wantsBarbeiro =
      norm === "barbeiro" ||
      norm.includes("falar com barbeiro") ||
      norm.includes("falar com atendente") ||
      norm.includes("quero o barbeiro") ||
      norm.includes("chamar barbeiro") ||
      norm.includes("atendimento humano");

    if (wantsBarbeiro) {
      humanHandoff.set(phone, { name });
      await sendMessage(phone, tr(phone, "barberNotified"));
      await notifyBarber(
        `📞 *${name} quer falar diretamente*\n📞 ${phone}\n\nAbra o outro número e responda direto.\nQuando terminar: *encerrar ${phone}*`,
      );
      return;
    }
  }

  try {
    const slots = await getAvailableSlots();
    const result = await interpretMessage(combinedText, slots, name, phone);

    console.log("Intenção identificada:", result);

    if (result.acao === "agendar" && result.data && result.horario) {
      const count = await countClientAppointmentsOnDay(phone, result.data);
      if (count >= 2) {
        await sendMessage(phone, tr(phone, "maxBookings"));
      } else if (!isValidName(name)) {
        waitingForNameToBook.set(phone, { data: result.data, horario: result.horario });
        await sendMessage(phone, tr(phone, "waitingName"));
      } else {
        const booked = await bookSlot(result.data, result.horario, name, phone);
        if (!booked) {
          await sendMessage(
            phone,
            tr(phone, "slotTaken"),
          );
        } else {
          await sendMessage(phone, result.resposta);
          const lang2 = clientLanguages.get(phone) || "pt";
          if (lang2 !== "pt") await sendMessage(phone, tr(phone, "langNote"));
          await notifyBarber(
            `✅ *Novo agendamento*\n👤 ${name}\n📅 ${fmtDate(result.data)}\n🕐 ${result.horario}`,
          );
        }
      }
    } else if (result.acao === "cancelar" && result.data && result.horario) {
      const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
      if (result.data === hoje) {
        waitingForCancelReason.set(phone, { data: result.data, horario: result.horario });
        await sendMessage(phone, tr(phone, "cancelReasonPrompt"));
      } else {
        const cancelled = await cancelSlot(result.data, result.horario, phone);
        if (!cancelled) {
          await sendMessage(phone, tr(phone, "slotNotFound"));
        } else {
          await sendMessage(phone, result.resposta);
          await notifyBarber(`❎ *Cancelamento*\n👤 ${name}\n📅 ${fmtDate(result.data)}\n🕐 ${result.horario}`);
        }
      }
    } else if (result.acao === "confirmar_presenca") {
      await sendMessage(phone, result.resposta);
      const timeInfo = result.horario ? ` às ${result.horario}` : "";
      const dateInfo = result.data ? ` — ${fmtDate(result.data)}` : "";
      await notifyBarber(`✅ *Presença confirmada*\n👤 ${name}${dateInfo}${timeInfo}`);
    } else if (
      result.acao === "reagendar" &&
      result.data &&
      result.horario &&
      result.data_nova &&
      result.horario_novo
    ) {
      const rescheduled = await rescheduleSlot(
        result.data,
        result.horario,
        result.data_nova,
        result.horario_novo,
        name,
        phone,
      );
      if (rescheduled === "bloqueado_tempo") {
        await sendMessage(
          phone,
          tr(phone, "rescheduleTooLate"),
        );
        await notifyBarber(
          `⚠️ *Tentativa de reagendamento tardio*\n👤 ${name}\n📞 ${phone}\n📅 ${fmtDate(result.data)} às ${result.horario}`,
        );
      } else if (rescheduled === "rollback_failed") {
        await sendMessage(
          phone,
          tr(phone, "rollbackFailed"),
        );
        await notifyBarber(
          `⚠️ *Erro no reagendamento*\n👤 ${name}\n📞 ${phone}\nHorário original ${fmtDate(result.data)} às ${result.horario} foi liberado mas o novo ${fmtDate(result.data_nova)} às ${result.horario_novo} não foi reservado. Verificar manualmente.`,
        );
      } else if (!rescheduled) {
        await sendMessage(
          phone,
          tr(phone, "rescheduleConflict"),
        );
      } else {
        await sendMessage(phone, result.resposta);
        await notifyBarber(
          `🔄 *Reagendamento*\n👤 ${name}\n📅 ${fmtDate(result.data)} às ${result.horario}\n➡️ ${fmtDate(result.data_nova)} às ${result.horario_novo}`,
        );
      }
    } else if (result.acao === "listar") {
      const now = new Date(
        new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
      );

      let targetDates = Array.isArray(result.datas) && result.datas.length
        ? result.datas
        : result.data
        ? [result.data]
        : null;

      // Sem data específica (ex: "essa semana"): calcula dias até o próximo domingo
      if (!targetDates) {
        const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
        const nextSunday = new Date(now);
        nextSunday.setDate(now.getDate() + daysUntilSunday);
        targetDates = [];
        const cursor = new Date(now);
        cursor.setDate(now.getDate() + 1);
        while (cursor <= nextSunday) {
          if (cursor.getDay() !== 0) {
            const yyyy = cursor.getFullYear();
            const mm = String(cursor.getMonth() + 1).padStart(2, "0");
            const dd = String(cursor.getDate()).padStart(2, "0");
            targetDates.push(`${yyyy}-${mm}-${dd}`);
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      }

      const parts = [];
      for (const data of targetDates) {
        const daySchedule = await getDaySchedule(data);
        if (daySchedule.length === 0) continue;
        const [year, month, day] = data.split("-").map(Number);
        const [, m, d] = data.split("-");
        const lines = daySchedule
          .filter((s) => {
            const [h, min] = s.horario.split(":").map(Number);
            return new Date(year, month - 1, day, h, min) > now;
          })
          .map((s) => {
            if (s.status === "livre") return `🟢 ${s.horario} — ${tr(phone, "livre")}`;
            if (s.status === "bloqueado") return `⚪ ${s.horario} — ${tr(phone, "bloqueado")}`;
            return `🔴 ${s.horario} — ${tr(phone, "ocupado")}`;
          });
        if (lines.length === 0) continue;
        parts.push(`${tr(phone, "agendaHeader", d, m)}\n\n${lines.join("\n")}`);
      }

      if (parts.length === 0) {
        await sendMessage(phone, result.resposta || tr(phone, "noSlots"));
      } else {
        const isWeekMode = !result.data && !(Array.isArray(result.datas) && result.datas.length);
        const intro = !isWeekMode && result.resposta ? `${result.resposta}\n\n` : "";
        const msg = `${intro}${parts.join("\n\n")}`;
        await sendMessage(phone, msg);
        addToHistory(phone, "assistant", `[Agenda exibida para: ${targetDates.join(", ")}]\n${msg}`);
      }
    } else {
      await sendMessage(phone, result.resposta);
    }
  } catch (error) {
    console.error("Erro ao processar mensagem:", error.message);
    await sendMessage(
      phone,
      tr(phone, "generalError"),
    );
    await notifyBarber(
      `⚠️ *Atenção manual*\n👤 ${name}\n📞 ${phone}\nCliente pode precisar de ajuda.`,
    );
  }
}

app.post("/api/book", async (req, res) => {
  const { date, horario, nome, telefone } = req.body;
  if (!date || !horario || !nome || !telefone) {
    return res.status(400).json({ error: "Preencha todos os campos." });
  }

  const digits = String(telefone).replace(/\D/g, "");
  let phone = digits;
  if (digits.startsWith("595") && digits.length === 12) {
    phone = digits; // Paraguay com código: 595XXXXXXXXX
  } else if (digits.startsWith("09") && digits.length === 10) {
    phone = "595" + digits.slice(1); // Paraguay: 0994123456 → 595994123456
  } else if (digits.startsWith("9") && digits.length === 9) {
    phone = "595" + digits; // Paraguay: 994123456 → 595994123456
  } else if (digits.startsWith("55") && digits.length >= 12) {
    phone = digits; // Brasil com código
  } else if (digits.length === 11) {
    phone = "55" + digits; // Brasil: 21999991234
  } else if (digits.length === 10) {
    phone = "55" + digits; // Brasil fixo
  }
  if (phone.length < 11 || phone.length > 13) {
    return res.status(400).json({ error: "Número de WhatsApp inválido." });
  }

  const slot = await getSlotInfo(date, horario);
  if (!slot || slot.status !== "livre") {
    return res.status(409).json({ error: "Esse horário acabou de ser ocupado. Escolha outro." });
  }

  const already = await countClientAppointmentsOnDay(phone, date);
  if (already > 0) {
    return res.status(409).json({ error: "Você já tem um agendamento neste dia." });
  }

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = horario.split(":").map(Number);
  const slotTime = new Date(y, m - 1, d, h, min);
  const diffMin = (slotTime - now) / (1000 * 60);
  const [, mm, dd] = date.split("-");

  if (diffMin < 60) {
    await notifyBarber(
      `⚡ *Pedido urgente (site)*\n👤 ${nome}\n📞 ${phone}\n📅 ${dd}/${mm} às ${horario}\n\nPara confirmar: *agenda ${nome} ${phone} dia ${dd}/${mm} ${horario}*`
    );
    return res.json({ ok: true, tipo: "pendente" });
  }

  const booked = await bookSlot(date, horario, nome, phone);
  if (!booked) {
    return res.status(409).json({ error: "Esse horário acabou de ser ocupado. Escolha outro." });
  }

  await notifyBarber(
    `✅ *Novo agendamento (site)*\n👤 ${nome}\n📞 ${phone}\n📅 ${dd}/${mm} às ${horario}`
  );

  // Registra no histórico para o bot reconhecer o cliente em futuras mensagens
  addToHistory(phone, "user", `quero marcar ${dd}/${mm} às ${horario}`);
  addToHistory(phone, "assistant", `Valeu, ${nome}! Horário confirmado para ${dd}/${mm} às ${horario}.`);

  // Confirmação para o cliente (pula se já está dentro da janela do lembrete 2h)
  if (diffMin >= 150) {
    const barbearia = process.env.BARBERSHOP_NAME || "Soul Black";
    await sendMessage(phone,
      `Valeu, ${nome}! 🖤✂️\nHorário confirmado para *${dd}/${mm} às ${horario}* na ${barbearia}.\nVocê receberá um lembrete antes do horário. Até lá!`
    );
  }

  return res.json({ ok: true, tipo: "confirmado" });
});

app.get("/api/slots", async (req, res) => {
  const { view = "dia", date } = req.query;
  const PAD = (n) => String(n).padStart(2, "0");
  const FMT = (d) => `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );

  let dates = [];

  if (view === "dia") {
    const d = date ? new Date(date + "T12:00:00") : now;
    if (d.getDay() !== 0) dates = [FMT(d)];
  } else if (view === "semana") {
    const cursor = new Date(now);
    while (dates.length < 6) {
      if (cursor.getDay() !== 0) dates.push(FMT(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (view === "mes" || view === "proximo") {
    const offset = view === "proximo" ? 1 : 0;
    const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const last = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0) dates.push(FMT(new Date(d)));
    }
  }

  try {
    const data = await getSlotsForDates(dates);
    res.json(data);
  } catch (e) {
    console.error("Erro /api/slots:", e.message);
    res.status(500).json({ error: "Erro ao buscar agenda" });
  }
});


app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.fromMe) return res.sendStatus(200);

  const phone = body.phone;
  const name = body.senderName;
  let text = null;

  if (body.text?.message) {
    text = body.text.message;
    console.log(`Texto de ${name} (${phone}): ${text}`);
  } else if (body.audio?.audioUrl) {
    console.log(`Áudio recebido de ${name} (${phone}), transcrevendo...`);
    try {
      text = await transcribeAudio(body.audio.audioUrl);
      console.log(`Transcrição: ${text}`);
    } catch (error) {
      console.error("Erro ao transcrever áudio:", error.message);
      await sendMessage(
        phone,
        "Não consegui entender o áudio. Digita pf? 😅",
      );
      await notifyBarber(
        `⚠️ Problema ao processar áudio de ${name} (${phone})`,
      );
      return res.sendStatus(200);
    }
  }

  if (!text) return res.sendStatus(200);

  if (!pendingMessages.has(phone)) pendingMessages.set(phone, []);
  pendingMessages.get(phone).push(text);

  if (debounceTimers.has(phone)) clearTimeout(debounceTimers.get(phone));

  const debounceTime = phone === BARBERSHOP_PHONE ? 3000 : 30 * 1000;
  const timer = setTimeout(() => {
    processAccumulatedMessages(phone, name);
  }, debounceTime);

  debounceTimers.set(phone, timer);

  res.sendStatus(200);
});

const CRONS_ENABLED = process.env.CRONS_ENABLED !== "false";

if (CRONS_ENABLED) {
  schedule.schedule(
    "0 1 * * *",
    () => {
      console.log("Limpando histórico de conversas...");
      clearAllHistories();
      waitingForNameToBook.clear();
      waitingForClientPhone.clear();
      console.log("Histórico limpo!");
    },
    { timezone: "America/Sao_Paulo" },
  );

  schedule.schedule("0 10 * * *", () => sendReminders(24), {
    timezone: "America/Sao_Paulo",
  });
  schedule.schedule("0 * * * *", () => sendReminders(2), {
    timezone: "America/Sao_Paulo",
  });

  schedule.schedule("0 12 * * *", () => sendUnconfirmedNotifications("24h", 120), {
    timezone: "America/Sao_Paulo",
  });
  schedule.schedule("20 * * * *", () => sendUnconfirmedNotifications("2h", 20), {
    timezone: "America/Sao_Paulo",
  });

  schedule.schedule("0 12 * * 0", () => sendWeeklySummary(), {
    timezone: "America/Sao_Paulo",
  });

  schedule.schedule(
    "0 0 * * *",
    () => {
      console.log("Verificando e gerando horários...");
      generateWeeklySlots()
        .then(() => console.log("Horários verificados com sucesso!"))
        .catch((err) => console.error("Erro ao gerar horários:", err.message));
    },
    { timezone: "America/Sao_Paulo" },
  );

  console.log("Crons ativos.");
} else {
  console.log("Crons desativados (CRONS_ENABLED=false).");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  generateWeeklySlots()
    .then(() => console.log("Horários verificados no startup!"))
    .catch((err) => console.error("Erro ao gerar horários no startup:", err.message));
});
