const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();
const lastGreetingPeriod = new Map();
// Armazena nomes validados por telefone
const validatedNames = new Map();

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

// Verifica se o nome parece real
function isValidName(name) {
  if (!name || name.trim().length < 3) return false;
  // Contém emoji
  if (/\p{Emoji}/u.test(name)) return false;
  // Contém números
  if (/\d/.test(name)) return false;
  // Palavras suspeitas de apelido de conta
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
  const lower = name.toLowerCase();
  if (suspicious.some((w) => lower.includes(w))) return false;
  // Só maiúsculas e curto (sigla)
  if (name === name.toUpperCase() && name.replace(/\s/g, "").length <= 4)
    return false;
  return true;
}

//Retorna nome validado ou null se precisar perguntar
function getValidatedName(phone, whatsappName) {
  if (validatedNames.has(phone)) return validatedNames.get(phone);
  if (isValidName(whatsappName)) {
    validatedNames.set(phone, whatsappName);
    return whatsappName;
  }
  return null;
}

function setValidatedName(phone, name) {
  validatedNames.set(phone, name);
}

async function interpretMessage(message, availableSlots, clientName, phone) {
  const slotsText = availableSlots
    .map((s) => `${s.data} às ${s.horario}`)
    .join("\n");

  const greetInstruction = shouldGreet(phone)
    ? `- Cumprimente brevemente com bom dia/tarde/noite.`
    : `- NÃO cumprimente — já houve interação neste período. Vá direto ao ponto.`;

  const hoje = new Date().toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const systemPrompt = `Você é o assistente virtual de uma barbearia chamada "${process.env.BARBERSHOP_NAME || "Barbearia"}". 
Ajude clientes a agendar, cancelar e reagendar horários.

O cliente se chama ${clientName}.
Hoje é ${hoje}.

Horários disponíveis:
${slotsText || "Nenhum horário disponível no momento."}

Responda APENAS com um JSON válido neste formato, sem texto adicional:
{
  "acao": "agendar" | "cancelar" | "reagendar" | "listar" | "conversa" | "informar_nome",
  "data": "2026-05-29" ou null,
  "horario": "14:00" ou null,
  "data_nova": "2026-05-29" ou null,
  "horario_novo": "14:00" ou null,
  "nome_informado": null,
  "resposta": "mensagem para o cliente"
}

Regras importantes:
- Analise TODO o histórico da conversa para identificar a intenção correta.
- Se o cliente disse "quero reagendar" e depois informou o horário atual, use acao "reagendar".
- Se o cliente disse "quero cancelar" e depois informou o horário, use acao "cancelar".
- Se o cliente disse "quero agendar" e depois informou o horário, use acao "agendar".
- Se o cliente pedir "ajuda", "help" ou "como funciona", use acao "conversa" e explique: "Posso te ajudar a *agendar*, *cancelar* ou *reagendar* um horário. É só me dizer o que precisa!"
- Se o cliente estiver respondendo com seu nome (após ser pedido), use acao "informar_nome" e coloque o nome em "nome_informado".
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
- Sobre saudações: ${greetInstruction}
- Interpretação de datas:
  * Se o cliente mencionar dia da semana E número do dia, use SEMPRE o número do dia.
  * Se mencionar só o dia da semana sem número, calcule a próxima ocorrência.
  * "amanhã" = dia seguinte ao hoje.
  * "hoje" = data de hoje.
  * Se só mencionar o número do dia sem mês, assuma o mês atual ou o próximo se já passou.`;

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
  validatedNames.clear();
}

module.exports = {
  interpretMessage,
  clearHistory,
  clearAllHistories,
  getValidatedName,
  setValidatedName,
};
