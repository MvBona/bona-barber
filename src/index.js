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
} = require("./sheets");

console.log("carregando ai...");
const { interpretMessage, clearAllHistories } = require("./ai");

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
    // Trata "hoje" e "amanhã"
    if (str.includes("hoje")) {
      return `${currentYear}-${currentMonth}-${String(now.getDate()).padStart(2, "0")}`;
    }
    if (str.includes("amanha") || str.includes("amanhã")) {
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
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
    const match = str.match(
      /(?:as?\s+|as\s+|horario\s+(?:das?\s+)?)?(\d{1,2})(?:h|:00)?(?!\d)/,
    );
    if (!match) return null;
    return match[1].padStart(2, "0") + ":00";
  }

  // Aceita texto entre os horários
  function extractTwoTimes(str) {
    const match = str.match(/(\d{1,2})h?\s+(?:para|pro|pra).+?(\d{1,2})h/);
    if (!match) return null;
    return {
      de: match[1].padStart(2, "0") + ":00",
      para: match[2].padStart(2, "0") + ":00",
    };
  }

  // Trata "depois de amanhã" explicitamente
  function extractTwoDates(str) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const dayAfter = new Date(now);
    dayAfter.setDate(now.getDate() + 2);

    const fmt = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const fromMatch = str.match(/(?:de\s+)?(.+?)\s+(?:para|pro|pra)\s+(.+)/);
    if (!fromMatch) return null;

    const fromStr = fromMatch[1];
    const toStr = fromMatch[2];

    function parseDateStr(s) {
      if (s.includes("depois de amanha") || s.includes("depois de amanha"))
        return fmt(dayAfter);
      if (s.includes("amanha")) return fmt(tomorrow);
      if (s.includes("hoje")) return fmt(now);
      return extractDate(s);
    }

    const from = parseDateStr(fromStr);
    const to = parseDateStr(toStr);
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

  // ─── DESBLOQUEIO ───
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
        ? `✅ Horário ${timeMatch} do dia ${d}/${m} desbloqueado.`
        : `Não encontrei o horário ${timeMatch} bloqueado em ${d}/${m}.`;
    }

    const period = extractPeriod(normalized);
    if (period) {
      const count = await unblockPeriod(period.inicio, period.fim);
      return count > 0
        ? `✅ Período desbloqueado. ${count} horário(s) liberado(s).`
        : `Não encontrei horários bloqueados nesse período.`;
    }

    if (dateMatch) {
      const count = await unblockDay(dateMatch);
      const [y, m, d] = dateMatch.split("-");
      return count > 0
        ? `✅ Dia ${d}/${m} desbloqueado. ${count} horário(s) liberado(s).`
        : `Não encontrei horários bloqueados em ${d}/${m}.`;
    }

    const onlyDay = normalized.match(/(?:dia\s+)?(\d{1,2})(?!\s*[\/h:])/);
    if (onlyDay) {
      const day = onlyDay[1].padStart(2, "0");
      const data = `${currentYear}-${currentMonth}-${day}`;
      const count = await unblockDay(data);
      return count > 0
        ? `✅ Dia ${day}/${currentMonth} desbloqueado. ${count} horário(s) liberado(s).`
        : `Não encontrei horários bloqueados em ${day}/${currentMonth}.`;
    }
  }

  // ─── BLOQUEIO ───
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
        ? `✅ Horário ${timeMatch} do dia ${d}/${m} bloqueado.`
        : `Não encontrei o horário ${timeMatch} em ${d}/${m}.`;
    }

    const period = extractPeriod(normalized);
    if (period) {
      const count = await blockPeriod(period.inicio, period.fim);
      return count > 0
        ? `✅ Período bloqueado. ${count} horário(s) bloqueado(s).`
        : `Não encontrei horários disponíveis nesse período.`;
    }

    if (dateMatch) {
      const count = await blockDay(dateMatch);
      const [y, m, d] = dateMatch.split("-");
      return count > 0
        ? `✅ Dia ${d}/${m} bloqueado. ${count} horário(s) bloqueado(s).`
        : `Não encontrei horários disponíveis em ${d}/${m}.`;
    }
  }

  // ─── REAGENDAMENTO ADMIN ───
  // "Passa Juliana de hoje 19h para amanhã 11h"
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
      // Busca info do cliente no horário original
      const slotInfo = await getSlotInfo(dates.de, times.de);

      if (!slotInfo) {
        const [y, m, d] = dates.de.split("-");
        return `Não encontrei agendamento em ${d}/${m} às ${times.de}.`;
      }

      // Verifica se o horário novo já está ocupado
      const newSlotInfo = await getSlotInfo(dates.para, times.para);
      if (newSlotInfo && newSlotInfo.status === "agendado") {
        const [y, m, d] = dates.para.split("-");
        // C — conflito: pergunta se quer realocar
        return `⚠️ O horário ${times.para} de ${d}/${m} já está com *${newSlotInfo.nome}*.\nQuer realocar esse cliente também? Responda "sim, realoca ${newSlotInfo.nome} para [novo horário]" ou escolha outro horário para ${slotInfo.nome}.`;
      }

      // Cancela o horário atual e agenda no novo
      await cancelSlotAdmin(dates.de, times.de);
      const booked = await bookSlotAdmin(
        dates.para,
        times.para,
        slotInfo.nome,
        slotInfo.telefone,
      );

      if (!booked) {
        const [y, m, d] = dates.para.split("-");
        return `Não consegui agendar no dia ${d}/${m} às ${times.para}. Verifique se o horário existe.`;
      }

      // A — notifica o cliente
      const [yd, md, dd] = dates.de.split("-");
      const [yp, mp, dp] = dates.para.split("-");
      await sendMessage(
        slotInfo.telefone,
        `Olá ${slotInfo.nome}! Seu horário foi alterado de ${dd}/${md} às ${times.de} para ${dp}/${mp} às ${times.para} pela barbearia.`,
      );

      await notifyBarber(
        `🔄 *Reagendamento admin*\n👤 ${slotInfo.nome}\n📅 ${dd}/${md} às ${times.de} → ${dp}/${mp} às ${times.para}`,
      );

      return `✅ ${slotInfo.nome} reagendado de ${dd}/${md} às ${times.de} para ${dp}/${mp} às ${times.para}. Cliente notificado.`;
    }
  }

  // ─── CANCELAMENTO ADMIN ───
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
        // ✅ A — notifica o cliente
        await sendMessage(
          cancelled.clientPhone,
          `Olá ${cancelled.clientName}! Seu horário do dia ${d}/${m} às ${timeMatch} foi cancelado pela barbearia. Entre em contato para reagendar.`,
        );
        return `✅ Horário ${d}/${m} às ${timeMatch} cancelado. Cliente notificado.`;
      }
      return `Não encontrei agendamento em ${d}/${m} às ${timeMatch}.`;
    }
  }

  // ─── AGENDAMENTO ADMIN ───
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

      // ✅ Verifica conflito antes de agendar
      const existing = await getSlotInfo(dateMatch, timeMatch);
      if (existing && existing.status === "agendado") {
        const [y, m, d] = dateMatch.split("-");
        return `⚠️ Horário ${d}/${m} às ${timeMatch} já está com *${existing.nome}*. Quer outro horário para ${clientName}?`;
      }

      const booked = await bookSlotAdmin(
        dateMatch,
        timeMatch,
        clientName,
        BARBERSHOP_PHONE,
      );
      const [y, m, d] = dateMatch.split("-");

      if (booked) {
        // ✅ A — notifica o barbeiro (já que agendou por ele)
        await notifyBarber(
          `✅ *Agendamento admin*\n👤 ${clientName}\n📅 ${d}/${m}\n🕐 ${timeMatch}`,
        );
        return `✅ Agendado: ${clientName} — ${d}/${m} às ${timeMatch}.`;
      }
      return `Não consegui agendar ${clientName} em ${d}/${m} às ${timeMatch}.`;
    }
  }

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

  try {
    const slots = await getAvailableSlots();
    const result = await interpretMessage(combinedText, slots, name, phone);

    console.log("Intenção identificada:", result);

    if (result.acao === "agendar" && result.data && result.horario) {
      const count = await countClientAppointmentsOnDay(phone, result.data);
      if (count >= 2) {
        await sendMessage(
          phone,
          "Você já tem 2 horários marcados nesse dia, que é o limite. Cancela um se quiser trocar.",
        );
      } else {
        const booked = await bookSlot(result.data, result.horario, name, phone);
        if (!booked) {
          await sendMessage(
            phone,
            `Ops! O horário ${result.horario} não está mais disponível. Escolhe outro? 😅`,
          );
          // D — aciona barbeiro em caso de conflito persistente
          await notifyBarber(
            `⚠️ *Conflito de horário*\n👤 ${name}\n📞 ${phone}\nTentou marcar ${result.data} às ${result.horario} mas já estava ocupado. Pode precisar de ajuda.`,
          );
        } else {
          await sendMessage(phone, result.resposta);
          await notifyBarber(
            `✅ *Novo agendamento*\n👤 ${name}\n📅 ${result.data}\n🕐 ${result.horario}`,
          );
        }
      }
    } else if (result.acao === "cancelar" && result.data && result.horario) {
      const cancelled = await cancelSlot(result.data, result.horario, phone);
      if (!cancelled) {
        await sendMessage(
          phone,
          `Não encontrei esse agendamento. Confirma o horário? 🤔`,
        );
      } else {
        await sendMessage(phone, result.resposta);
        await notifyBarber(
          `❌ *Cancelamento*\n👤 ${name}\n📅 ${result.data}\n🕐 ${result.horario}`,
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
      if (!rescheduled) {
        await sendMessage(
          phone,
          `Não consegui reagendar. Confirma os horários? 🤔`,
        );
        // D — aciona barbeiro em conflito de reagendamento
        await notifyBarber(
          `⚠️ *Conflito de reagendamento*\n👤 ${name}\n📞 ${phone}\nTentou reagendar para ${result.data_nova} às ${result.horario_novo} mas não conseguiu.`,
        );
      } else {
        await sendMessage(phone, result.resposta);
        await notifyBarber(
          `🔄 *Reagendamento*\n👤 ${name}\n📅 ${result.data} às ${result.horario}\n➡️ ${result.data_nova} às ${result.horario_novo}`,
        );
      }
    } else {
      await sendMessage(phone, result.resposta);
    }
  } catch (error) {
    console.error("Erro ao processar mensagem:", error.message);
    await sendMessage(
      phone,
      "Desculpe, tive um problema. Tenta de novo em instantes!",
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
        "Desculpe, não consegui entender o áudio. Pode digitar sua mensagem? 😅",
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

  const timer = setTimeout(() => {
    processAccumulatedMessages(phone, name);
  }, 30 * 1000);

  debounceTimers.set(phone, timer);

  res.sendStatus(200);
});

schedule.schedule(
  "0 1 * * *",
  () => {
    console.log("Limpando histórico de conversas...");
    clearAllHistories();
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
