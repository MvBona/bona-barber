const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function interpretMessage(message, availableSlots, clientName) {
  const slotsText = availableSlots
    .map((s) => `${s.data} às ${s.horario}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: message,
      },
    ],
    system: `Você é o assistente virtual de uma barbearia. Interprete a mensagem do cliente e responda com um JSON.

Horários disponíveis:
${slotsText}

Responda APENAS com um JSON válido neste formato, sem texto adicional:
{
  "acao": "agendar" | "cancelar" | "reagendar" | "listar" | "conversa",
  "data": "2026-05-29" ou null,
  "horario": "14:00" ou null,
  "data_nova": "2026-05-29" ou null,
  "horario_novo": "14:00" ou null,
  "resposta": "mensagem amigável para o cliente"
}

Regras:
- "agendar": cliente quer marcar horário. Preencha data e horario se especificou.
- "cancelar": cliente quer cancelar. Preencha data e horario do agendamento atual.
- "reagendar": cliente quer mudar de horário. Preencha data/horario do atual e data_nova/horario_novo do novo.
- "listar": cliente quer ver horários disponíveis.
- "conversa": saudação, dúvida, ou qualquer outra mensagem.
- Se faltar informação para completar a ação, use "conversa" e peça o que falta na resposta.
- Resposta sempre em português informal e curta — é WhatsApp.
- Use emojis com moderação.
- Datas sempre no formato YYYY-MM-DD e horários no formato HH:MM.`,
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

module.exports = { interpretMessage };
