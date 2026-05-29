const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();
const lastGreetingPeriod = new Map();

function getPeriod() {
  const hora = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hour12: false,
  });
  const h = parseInt(hora);
  if (h >= 5 && h < 12) return "manha";
  if (h >= 12 && h < 18) return "tarde";
  return "noite";
}

function shouldGreet(phone) {
  const current = getPeriod();
  const last = lastGreetingPeriod.get(phone);
  if (current !== last) {
    lastGreetingPeriod.set(phone, current);
    return true;
  }
  return false;
}

function getHistory(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  if (history.length > 10) {
    conversations.set(phone, history.slice(-10));
  }
}

async function interpretMessage(message, availableSlots, clientName, phone) {
  const slotsText = availableSlots
    .map((s) => `${s.data} às ${s.horario}`)
    .join("\n");

  const greetInstruction = shouldGreet(phone)
    ? `- Cumprimente brevemente com bom dia/tarde/noite.`
    : `- NÃO cumprimente — já houve interação neste período. Vá direto ao ponto.`;

  const systemPrompt = `Você é o assistente virtual de uma barbearia chamada "${process.env.BARBERSHOP_NAME || "Barbearia"}". 
Ajude clientes a agendar, cancelar e reagendar horários.

O cliente se chama ${clientName}.

Horários disponíveis:
${slotsText || "Nenhum horário disponível no momento."}

Responda APENAS com um JSON válido neste formato, sem texto adicional:
{
  "acao": "agendar" | "cancelar" | "reagendar" | "listar" | "conversa",
  "data": "2026-05-29" ou null,
  "horario": "14:00" ou null,
  "data_nova": "2026-05-29" ou null,
  "horario_novo": "14:00" ou null,
  "resposta": "mensagem para o cliente"
}

Regras importantes:
- Analise TODO o histórico da conversa para identificar a intenção correta.
- Se o cliente disse "quero reagendar" e depois informou o horário atual, use acao "reagendar".
- Se o cliente disse "quero cancelar" e depois informou o horário, use acao "cancelar".
- Se o cliente disse "quero agendar" e depois informou o horário, use acao "agendar".
- NUNCA perca o contexto da intenção original.
- Se tiver o horário atual mas faltar o novo horário, use acao "reagendar" com horario_novo null e peça o novo horário.
- "agendar": cliente quer marcar. Se tiver data e horário claros, confirme diretamente SEM pedir confirmação extra.
- "cancelar": cliente quer cancelar. Preencha data e horario se especificou.
- "reagendar": cliente quer mudar horário. Preencha os campos atuais e novos.
- "listar": cliente quer ver horários disponíveis.
- "conversa": SOMENTE para saudações ou dúvidas que não envolvem agendamento.
- Datas sempre no formato YYYY-MM-DD e horários HH:MM.
- Tom: direto e informal. Máximo 2 linhas na resposta.
- Emojis: no máximo 1 por mensagem, só quando fizer sentido.
- Evite frases como "Que ótimo!", "Com certeza!", "Perfeito!".
- Não repita o nome do cliente em toda mensagem.
- Sobre saudações: ${greetInstruction}`;

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
  lastGreetingPeriod.clear();
}

module.exports = { interpretMessage, clearHistory, clearAllHistories };
