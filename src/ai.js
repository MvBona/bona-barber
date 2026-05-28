const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Memória de conversas por cliente { telefone: [mensagens] }
const conversations = new Map();

function getHistory(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });

  // Mantém só as últimas 10 mensagens pra não explodir o contexto
  if (history.length > 10) {
    conversations.set(phone, history.slice(-10));
  }
}

async function interpretMessage(message, availableSlots, clientName, phone) {
  const slotsText = availableSlots
    .map((s) => `${s.data} às ${s.horario}`)
    .join("\n");

  const systemPrompt = `Você é o assistente virtual de uma barbearia chamada "${process.env.BARBERSHOP_NAME || "Barbearia"}". 
Seu papel é ajudar clientes a agendar, cancelar e reagendar horários de forma simpática e informal.

O cliente se chama ${clientName}.

Horários disponíveis para agendamento:
${slotsText || "Nenhum horário disponível no momento."}

Você deve responder APENAS com um JSON válido neste formato, sem texto adicional:
{
  "acao": "agendar" | "cancelar" | "reagendar" | "listar" | "conversa",
  "data": "2026-05-29" ou null,
  "horario": "14:00" ou null,
  "data_nova": "2026-05-29" ou null,
  "horario_novo": "14:00" ou null,
  "resposta": "mensagem amigável para o cliente"
}

Regras importantes:
- Analise TODO o histórico da conversa para identificar a intenção correta.
- Se o cliente disse "quero reagendar" e depois informou o horário atual, use acao "reagendar".
- Se o cliente disse "quero cancelar" e depois informou o horário, use acao "cancelar".
- Se o cliente disse "quero agendar" e depois informou o horário, use acao "agendar".
- NUNCA perca o contexto da intenção original — se o cliente estava reagendando e informou o horário atual, mantenha acao "reagendar".
- Se tiver o horário atual mas faltar o novo horário, use acao "reagendar" com horario_novo null e peça o novo horário na resposta.
- Se o cliente disser "acho que estou às 11h" durante um reagendamento, interprete como horario: "11:00".
- "agendar": cliente quer marcar. Se tiver data e horário claros, confirme diretamente SEM pedir confirmação extra.
- "cancelar": cliente quer cancelar. Preencha data e horario se especificou.
- "reagendar": cliente quer mudar horário. Preencha os campos atuais e novos.
- "listar": cliente quer ver horários disponíveis.
- "conversa": SOMENTE para saudações ou dúvidas que não envolvem agendamento.
- Datas sempre no formato YYYY-MM-DD e horários HH:MM.
- Resposta curta e informal — é WhatsApp. Use emojis com moderação.`;

  addToHistory(phone, "user", message);

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemPrompt,
    messages: getHistory(phone),
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, "").trim();
  const result = JSON.parse(clean);

  addToHistory(phone, "assistant", text);

  return result;
}

function clearHistory(phone) {
  conversations.delete(phone);
}

function clearAllHistories() {
  conversations.clear();
}

module.exports = { interpretMessage, clearHistory, clearAllHistories };
