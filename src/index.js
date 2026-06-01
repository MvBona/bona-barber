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
const schedule = require("node-cron");

console.log("carregando sheets...");
const {
  getAvailableSlots,
  bookSlot,
  bookSlotAdmin,
  cancelSlot,
  cancelSlotAdmin,
  rescheduleSlot,
  getAppointmentsForReminder,
  countClientAppointmentsOnDay,
  getSlotInfo,
  getDaySchedule,
} = require("./sheets");

console.log("carregando ai...");
const { interpretMessage, addToHistory, clearAllHistories } = require("./ai");

console.log("carregando transcribe...");
const { transcribeAudio } = require("./transcribe");

console.log("carregando scheduler...");
const {
  generateWeeklySlots,
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

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const BARBERSHOP_PHONE = process.env.BARBERSHOP_PHONE;

const debounceTimers = new Map();
const pendingMessages = new Map();
// Agendamento pendente aguardando nome válido: phone → { data, horario }
const waitingForNameToBook = new Map();

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

async function sendReminders(horasAntes) {
  try {
    const appointments = await getAppointmentsForReminder(horasAntes);
    console.log(
      `Lembretes ${horasAntes}h: ${appointments.length} agendamento(s) encontrado(s)`,
    );
    for (const appt of appointments) {
      const msg =
        horasAntes === 24
          ? `Lembrete: você tem horário amanhã às ${appt.horario} na ${process.env.BARBERSHOP_NAME || "barbearia"}.`
          : `Seu horário é em 2 horas, às ${appt.horario} na ${process.env.BARBERSHOP_NAME || "barbearia"}.`;
      await sendMessage(appt.telefone, msg);
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
        ? `⚪ ${timeMatch} de ${d}/${m} liberado.`
        : `❌ Horário ${timeMatch} de ${d}/${m} não estava bloqueado.`;
    }
    const period = extractPeriod(normalized);
    if (period) {
      const count = await unblockPeriod(period.inicio, period.fim);
      return count > 0
        ? `⚪ Período liberado — ${count} horário(s) desbloqueado(s).`
        : `❌ Nenhum horário bloqueado encontrado nesse período.`;
    }
    if (dateMatch) {
      const count = await unblockDay(dateMatch);
      const [y, m, d] = dateMatch.split("-");
      return count > 0
        ? `⚪ ${d}/${m} liberado — ${count} horário(s) desbloqueado(s).`
        : `❌ Nenhum horário bloqueado em ${d}/${m}.`;
    }
    const onlyDay = normalized.match(/(?:dia\s+)?(\d{1,2})(?!\s*[\/h:])/);
    if (onlyDay) {
      const day = onlyDay[1].padStart(2, "0");
      const count = await unblockDay(`${currentYear}-${currentMonth}-${day}`);
      return count > 0
        ? `⚪ ${day}/${currentMonth} liberado — ${count} horário(s) desbloqueado(s).`
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
      const nameMatch = normalized.match(
        /(?:agenda|marca|reserva)\s+(?:pra?\s+|para\s+)?([a-záàãâéêíóôõúç\s]+?)(?:\s+dia|\s+hoje|\s+amanha|\s+\d{1,2}[\/h])/,
      );
      const clientName = nameMatch
        ? nameMatch[1].trim().replace(/\b\w/g, (c) => c.toUpperCase())
        : "Cliente";
      const existing = await getSlotInfo(dateMatch, timeMatch);
      if (existing && existing.status === "agendado") {
        const [y, m, d] = dateMatch.split("-");
        return `⚠️ ${d}/${m} às ${timeMatch} já está com *${existing.nome}*.`;
      }
      const booked = await bookSlotAdmin(
        dateMatch,
        timeMatch,
        clientName,
        BARBERSHOP_PHONE,
      );
      const [y, m, d] = dateMatch.split("-");
      if (booked)
        return `✅ Agendado *${clientName}* — ${d}/${m} às ${timeMatch}.`;
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
        if (s.status === "agendado") return `🟢 ${s.horario} — ${s.nome}`;
        if (s.status === "bloqueado") return `🔴 ${s.horario} — bloqueado`;
        return `⚪ ${s.horario} — livre`;
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
    return `🛠️ *Comandos disponíveis*\n\n*📅 Ver agenda:*\n"agenda hoje"\n"agenda amanhã"\n"agenda 15/06"\n\n*🔒 Bloquear:*\n"bloqueia 15/06"\n"bloqueia 16h do dia 15/06"\n"bloqueia 15/06 ao 22/06"\n\n*🔓 Desbloquear:*\n"desbloqueia 15/06"\n"desbloqueia 16h do dia 15/06"\n\n*👤 Agendar cliente:*\n"marca João dia 15/06 às 14h"\n\n*❌ Cancelar:*\n"cancela 15/06 às 14h"\n\n*🔄 Reagendar:*\n"passa João de 15/06 14h para 16/06 10h"`;
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

  const combinedText = messages.join(" ");
  console.log(
    `Processando ${messages.length} mensagem(ns) de ${name} (${phone}): ${combinedText}`,
  );

  if (phone === BARBERSHOP_PHONE) {
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
          `Esse horário já foi. Dá uma olhada nos livres? Se quiser um específico, manda *barbeiro*. 👍🏼`,
        );
      } else {
        await sendMessage(
          phone,
          `Valeu, ${nomeLimpo}! Tá marcado pras ${horario}. Até lá! ✂️`,
        );
        await notifyBarber(
          `✅ *Novo agendamento*\n👤 ${nomeLimpo}\n📅 ${fmtDate(data)}\n🕐 ${horario}`,
        );
      }
      return;
    }

    // Não parece nome — pede de novo
    await sendMessage(
      phone,
      `Não entendi não. Me fala seu nome aí.`,
    );
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
        `✂️ *Tô aqui pra te ajudar:*\n\n📅 *Ver horários:*\n"tem vaga hoje?"\n"quais horários amanhã?"\n\n📌 *Agendar:*\n"quero marcar às 14h amanhã"\n\n❌ *Cancelar:*\n"quero cancelar meu horário"\n\n🔄 *Reagendar:*\n"muda meu horário de sexta pra sábado"\n\n📞 *Falar com o barbeiro:*\nManda *barbeiro* que a gente chama ele`,
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
      await sendMessage(
        phone,
        `Já avisei o barb! Ele te chama em breve. 📞`,
      );
      await notifyBarber(
        `📞 *Cliente quer falar diretamente*\n👤 ${name}\n📞 ${phone}`,
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
        await sendMessage(
          phone,
          "Vc já tem 2 horários nesse dia — é o máximo. Cancela um se quiser trocar.",
        );
      } else if (!isValidName(name)) {
        waitingForNameToBook.set(phone, { data: result.data, horario: result.horario });
        await sendMessage(
          phone,
          `Pera, qual é o seu nome pra eu marcar?`,
        );
      } else {
        const booked = await bookSlot(result.data, result.horario, name, phone);
        if (!booked) {
          await sendMessage(
            phone,
            `Esse horário já foi. Dá uma olhada nos livres? Se quiser um específico, manda *barbeiro*. 👍🏼`,
          );
        } else {
          await sendMessage(phone, result.resposta);
          await notifyBarber(
            `✅ *Novo agendamento*\n👤 ${name}\n📅 ${fmtDate(result.data)}\n🕐 ${result.horario}`,
          );
        }
      }
    } else if (result.acao === "cancelar" && result.data && result.horario) {
      const cancelled = await cancelSlot(result.data, result.horario, phone);
      if (cancelled === "bloqueado_tempo") {
        await sendMessage(
          phone,
          "Não rola cancelar com menos de 2h de antecedência. Se precisar, manda *barbeiro* pra resolver.",
        );
        await notifyBarber(
          `⚠️ *Tentativa de cancelamento tardio*\n👤 ${name}\n📞 ${phone}\n📅 ${fmtDate(result.data)} às ${result.horario}`,
        );
      } else if (!cancelled) {
        await sendMessage(
          phone,
          `Não achei esse horário não. Confirma pra mim? 🤔`,
        );
      } else {
        await sendMessage(phone, result.resposta);
        await notifyBarber(
          `❌ *Cancelamento*\n👤 ${name}\n📅 ${fmtDate(result.data)}\n🕐 ${result.horario}`,
        );
      }
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
          "Não rola reagendar com menos de 2h de antecedência. Se precisar, manda *barbeiro* pra resolver.",
        );
        await notifyBarber(
          `⚠️ *Tentativa de reagendamento tardio*\n👤 ${name}\n📞 ${phone}\n📅 ${fmtDate(result.data)} às ${result.horario}`,
        );
      } else if (!rescheduled) {
        await sendMessage(
          phone,
          `Não consegui reagendar não. Confirma os horários pra mim? 🤔`,
        );
        await notifyBarber(
          `⚠️ *Conflito de reagendamento*\n👤 ${name}\n📞 ${phone}\nTentou reagendar para ${fmtDate(result.data_nova)} às ${result.horario_novo} mas não conseguiu.`,
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
            if (s.status === "livre") return `⚪ ${s.horario} — livre`;
            if (s.status === "bloqueado") return `🔴 ${s.horario} — bloqueado`;
            return `🟢 ${s.horario} — ocupado`;
          });
        if (lines.length === 0) continue;
        parts.push(`📅 *Agenda ${d}/${m}*\n\n${lines.join("\n")}`);
      }

      if (parts.length === 0) {
        await sendMessage(phone, result.resposta || "Não tem mais vaga pra essa data não.");
      } else {
        const intro = result.resposta ? `${result.resposta}\n\n` : "";
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
      "Deu um erro aqui. Espera um pouquinho e tenta dnv!💪🏼",
    );
    await notifyBarber(
      `⚠️ *Atenção manual*\n👤 ${name}\n📞 ${phone}\nCliente pode precisar de ajuda.`,
    );
  }
}

app.get("/", (req, res) => {
  res.send("Bot da barbearia rodando!");
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

schedule.schedule(
  "0 1 * * *",
  () => {
    console.log("Limpando histórico de conversas...");
    clearAllHistories();
    waitingForNameToBook.clear();
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
