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
const {
  interpretMessage,
  clearAllHistories,
  getValidatedName,
  setValidatedName,
} = require("./ai");

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
      const count = await unblockDay(`${currentYear}-${currentMonth}-${day}`);
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
        return `Não encontrei agendamento em ${d}/${m} às ${times.de}.`;
      }

      // Verifica se horário novo existe ANTES de cancelar
      const newSlotInfo = await getSlotInfo(dates.para, times.para);
      if (!newSlotInfo) {
        const [y, m, d] = dates.para.split("-");
        return `O horário ${times.para} não existe na agenda de ${d}/${m}. Verifique a data e horário.`;
      }

      if (newSlotInfo.status === "agendado") {
        const [y, m, d] = dates.para.split("-");
        return `⚠️ O horário ${times.para} de ${d}/${m} já está com *${newSlotInfo.nome}*.\nEscolha outro horário para ${slotInfo.nome} ou use "cancela ${d}/${m} às ${times.para}" primeiro.`;
      }

      // Só cancela depois de confirmar que o novo existe
      await cancelSlotAdmin(dates.de, times.de);
      const booked = await bookSlotAdmin(
        dates.para,
        times.para,
        slotInfo.nome,
        slotInfo.telefone,
      );

      if (!booked) {
        // Reverte
        await bookSlotAdmin(
          dates.de,
          times.de,
          slotInfo.nome,
          slotInfo.telefone,
        );
        const [y, m, d] = dates.para.split("-");
        return `Não consegui agendar em ${d}/${m} às ${times.para}. Horário revertido.`;
      }

      const [yd, md, dd] = dates.de.split("-");
      const [yp, mp, dp] = dates.para.split("-");

      // Notifica só o cliente, não o barbeiro (ele fez o comando)
      await sendMessage(
        slotInfo.telefone,
        `Olá ${slotInfo.nome}! Seu horário foi alterado de ${dd}/${md} às ${times.de} para ${dp}/${mp} às ${times.para} pela barbearia.`,
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
        // ✅ MUDANÇA: notifica só o cliente
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
      if (booked)
        return `✅ Agendado: ${clientName} — ${d}/${m} às ${timeMatch}.`;
      return `Não consegui agendar ${clientName} em ${d}/${m} às ${timeMatch}.`;
    }
  }

  // ─── AGENDA DO DIA ───
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
        return `Nenhum horário cadastrado para ${d}/${m}.`;
      const lines = schedule.map((s) => {
        if (s.status === "agendado") return `🟢 ${s.horario} — ${s.nome}`;
        if (s.status === "bloqueado") return `🔴 ${s.horario} — bloqueado`;
        return `⚪ ${s.horario} — livre`;
      });
      return `📅 *Agenda ${d}/${m}*\n\n${lines.join("\n")}`;
    }
  }

  // ─── AJUDA ───
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
    hasBook ||
    hasAgenda;
  if (pareceComando)
    return `Não entendi. Digite *ajuda* para ver os comandos disponíveis.`;

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

  // Valida nome antes de processar
  const validName = getValidatedName(phone, name);
  if (!validName) {
    await sendMessage(
      phone,
      `Olá! Para te atender, preciso do seu nome completo. Como posso te chamar?`,
    );
    return;
  }

  try {
    const slots = await getAvailableSlots();
    const result = await interpretMessage(
      combinedText,
      slots,
      validName,
      phone,
    );

    console.log("Intenção identificada:", result);

    // Trata informar_nome
    if (result.acao === "informar_nome" && result.nome_informado) {
      const nomeInformado = result.nome_informado.trim();
      setValidatedName(phone, nomeInformado);
      await sendMessage(phone, result.resposta);
      return;
    }

    if (result.acao === "agendar" && result.data && result.horario) {
      const count = await countClientAppointmentsOnDay(phone, result.data);
      if (count >= 2) {
        await sendMessage(
          phone,
          "Você já tem 2 horários marcados nesse dia, que é o limite. Cancela um se quiser trocar.",
        );
      } else {
        const booked = await bookSlot(
          result.data,
          result.horario,
          validName,
          phone,
        );
        if (!booked) {
          await sendMessage(
            phone,
            `Ops! O horário ${result.horario} não está mais disponível. Escolhe outro? 😅`,
          );
          await notifyBarber(
            `⚠️ *Conflito de horário*\n👤 ${validName}\n📞 ${phone}\nTentou marcar ${result.data} às ${result.horario} mas já estava ocupado.`,
          );
        } else {
          await sendMessage(phone, result.resposta);
          await notifyBarber(
            `✅ *Novo agendamento*\n👤 ${validName}\n📅 ${result.data}\n🕐 ${result.horario}`,
          );
        }
      }
    } else if (result.acao === "cancelar" && result.data && result.horario) {
      const cancelled = await cancelSlot(result.data, result.horario, phone);
      if (cancelled === "bloqueado_tempo") {
        // Bloqueio de cancelamento a menos de 2h
        await sendMessage(
          phone,
          "Não é possível cancelar com menos de 2h de antecedência. Entre em contato direto com a barbearia.",
        );
        await notifyBarber(
          `⚠️ *Tentativa de cancelamento tardio*\n👤 ${validName}\n📞 ${phone}\n📅 ${result.data} às ${result.horario}`,
        );
      } else if (!cancelled) {
        await sendMessage(
          phone,
          `Não encontrei esse agendamento. Confirma o horário? 🤔`,
        );
      } else {
        await sendMessage(phone, result.resposta);
        await notifyBarber(
          `❌ *Cancelamento*\n👤 ${validName}\n📅 ${result.data}\n🕐 ${result.horario}`,
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
        validName,
        phone,
      );
      if (rescheduled === "bloqueado_tempo") {
        await sendMessage(
          phone,
          "Não é possível reagendar com menos de 2h de antecedência. Entre em contato direto com a barbearia.",
        );
        await notifyBarber(
          `⚠️ *Tentativa de reagendamento tardio*\n👤 ${validName}\n📞 ${phone}\n📅 ${result.data} às ${result.horario}`,
        );
      } else if (!rescheduled) {
        await sendMessage(
          phone,
          `Não consegui reagendar. Confirma os horários? 🤔`,
        );
        await notifyBarber(
          `⚠️ *Conflito de reagendamento*\n👤 ${validName}\n📞 ${phone}\nTentou reagendar para ${result.data_nova} às ${result.horario_novo} mas não conseguiu.`,
        );
      } else {
        await sendMessage(phone, result.resposta);
        await notifyBarber(
          `🔄 *Reagendamento*\n👤 ${validName}\n📅 ${result.data} às ${result.horario}\n➡️ ${result.data_nova} às ${result.horario_novo}`,
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
      `⚠️ *Atenção manual*\n👤 ${validName || name}\n📞 ${phone}\nCliente pode precisar de ajuda.`,
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

  // Barbeiro 3s, clientes 30s
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
