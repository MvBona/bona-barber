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
  cancelSlot,
  rescheduleSlot,
  getAppointmentsForReminder,
  countClientAppointmentsOnDay,
} = require("./sheets");

console.log("carregando ai...");
const { interpretMessage, clearAllHistories } = require("./ai");

console.log("carregando transcribe...");
const { transcribeAudio } = require("./transcribe");

console.log("carregando scheduler...");
const {
  generateWeeklySlots,
  blockDay,
  blockPeriod,
  unblockDay,
} = require("./scheduler");

console.log("todos os módulos carregados!");
const app = express();

app.use(express.json());

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const BARBERSHOP_PHONE = process.env.BARBERSHOP_PHONE;

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

// ✅ MUDANÇA: aceita linguagem natural nos comandos
async function processBarberCommand(text) {
  const normalized = text
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // remove acentos

  // Extrai números do texto
  const numbers = normalized.match(/\d+/g) || [];

  const hasBlock =
    normalized.includes("bloquear") ||
    normalized.includes("bloqueia") ||
    normalized.includes("bloqueie") ||
    normalized.includes("fechar") ||
    normalized.includes("fecha") ||
    normalized.includes("cancelar dia") ||
    normalized.includes("folga");

  if (!hasBlock) return null;

  const hasUnblock =
    normalized.includes("desbloquear") ||
    normalized.includes("desbloqueia") ||
    normalized.includes("desbloqueie") ||
    normalized.includes("abrir dia") ||
    normalized.includes("abre dia") ||
    normalized.includes("liberar") ||
    normalized.includes("libera");

  if (hasUnblock) {
    const singleUnblock = normalized.match(
      /(?:dia\s+)?(\d{1,2})[\/\s](?:do\s+|de\s+)?(\d{1,2}|janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?/,
    );

    // Se não achou data completa, tenta só o dia (assume mês atual)
    const onlyDay = !singleUnblock && normalized.match(/(?:dia\s+)?(\d{1,2})/);

    if (singleUnblock) {
      const day = singleUnblock[1].padStart(2, "0");
      const month = parseMonth(singleUnblock[2]);
      const year = singleUnblock[3] || currentYear;
      if (!month) return null;
      const data = `${year}-${month}-${day}`;
      const count = await unblockDay(data);
      return count > 0
        ? `✅ Dia ${day}/${month} desbloqueado. ${count} horário(s) liberado(s).`
        : `Não encontrei horários bloqueados em ${day}/${month}.`;
    }

    if (onlyDay) {
      const day = onlyDay[1].padStart(2, "0");
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const year = now.getFullYear();
      const data = `${year}-${month}-${day}`;
      const count = await unblockDay(data);
      return count > 0
        ? `✅ Dia ${day}/${month} desbloqueado. ${count} horário(s) liberado(s).`
        : `Não encontrei horários bloqueados em ${day}/${month}.`;
    }
  }

  if (!hasBlock) return null;

  const currentYear = new Date().getFullYear();

  // Tenta extrair período: "10 ao 22 de junho", "10/06 ao 22/06"
  const periodMatch = normalized.match(
    /(\d{1,2})[\/\s](?:ao?|até|a)\s*(\d{1,2})[\/\s](?:do\s+)?(\d{1,2}|janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?/,
  );

  // Tenta extrair dia único: "dia 10 do 6", "10/06", "dia 10 de junho"
  const singleMatch = normalized.match(
    /(?:dia\s+)?(\d{1,2})[\/\s](?:do\s+|de\s+)?(\d{1,2}|janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?/,
  );

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

  if (singleMatch) {
    const day = singleMatch[1].padStart(2, "0");
    const month = parseMonth(singleMatch[2]);
    const year = singleMatch[3] || currentYear;
    if (!month) return null;
    const data = `${year}-${month}-${day}`;
    const count = await blockDay(data);
    return count > 0
      ? `✅ Dia ${day}/${month} bloqueado. ${count} horário(s) bloqueado(s).`
      : `Não encontrei horários disponíveis em ${day}/${month}.`;
  }

  return null;
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

  if (phone === BARBERSHOP_PHONE) {
    const commandResponse = await processBarberCommand(text);
    if (commandResponse) {
      await sendMessage(phone, commandResponse);
      return res.sendStatus(200);
    }
  }

  try {
    const slots = await getAvailableSlots();
    const result = await interpretMessage(text, slots, name, phone);

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
