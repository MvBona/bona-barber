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
const { generateWeeklySlots } = require("./scheduler");

console.log("todos os módulos carregados!");
const app = express();

app.use(express.json());

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

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
      return res.sendStatus(200);
    }
  }

  if (!text) return res.sendStatus(200);

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
  "0 0 * * 0",
  () => {
    console.log("Gerando horários da semana seguinte...");
    generateWeeklySlots()
      .then(() => console.log("Horários gerados com sucesso!"))
      .catch((err) => console.error("Erro ao gerar horários:", err.message));
  },
  { timezone: "America/Sao_Paulo" },
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
