const Anthropic = require('@anthropic-ai/sdk')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function interpretMessage(message, availableSlots) {
  const slotsText = availableSlots
    .map(s => `${s.data} às ${s.horario}`)
    .join('\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: message
      }
    ],
    system: `Você é o assistente virtual de uma barbearia. Seu papel é identificar a intenção do cliente e responder de forma simpática e informal.

Horários disponíveis para agendamento:
${slotsText}

Regras:
- Se o cliente quiser AGENDAR, identifique o horário desejado e confirme. Se não especificou horário, mostre os disponíveis.
- Se o cliente quiser CANCELAR, peça confirmação do horário.
- Se o cliente quiser VER HORÁRIOS, liste os disponíveis.
- Se não entender, peça para reformular.
- Responda sempre em português informal e amigável, como um atendente humano.
- Mantenha respostas curtas — é uma conversa de WhatsApp.

Responda APENAS com o texto da mensagem para o cliente, sem explicações adicionais.`
  })

  return response.content[0].text
}

module.exports = { interpretMessage }