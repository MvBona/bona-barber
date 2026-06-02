const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { clientLanguages } = require("./i18n");
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

  const currentPeriod = getPeriod();
  const greetPhrase = { manha: "bom dia", tarde: "boa tarde", noite: "boa noite" }[currentPeriod];
  const greetInstruction = shouldGreet(phone)
    ? `- Cumprimente brevemente com "${greetPhrase}". Não use outra saudação de período.`
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
  "acao": "agendar" | "cancelar" | "reagendar" | "listar" | "conversa" | "informar_nome" | "confirmar_presenca",
  "data": "2026-05-29" ou null,
  "datas": ["2026-05-29", "2026-05-30"] ou null,
  "horario": "14:00" ou null,
  "data_nova": "2026-05-29" ou null,
  "horario_novo": "14:00" ou null,
  "nome_informado": null,
  "idioma": "pt" | "es" | "en",
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
- "agendar": cliente quer marcar. Se tiver data e horário claros, confirme diretamente SEM pedir confirmação extra. Na confirmação use o formato: "✂️ Agendado! Te aguardo [quando] às [hora] 💪🏼💪🏼" (ex: "✂️ Agendado! Te aguardo hoje às 15h 💪🏼💪🏼" ou "✂️ Agendado! Te aguardo dia 05/06 às 14h 💪🏼💪🏼"). Se o cliente quiser agendar mas não informou a data, pergunte só o dia (não peça data e horário juntos). Se o cliente informar o dia mas não o horário em contexto de agendamento, use acao "listar" com essa data — isso mostra os horários disponíveis para o cliente escolher.
- "cancelar": cliente quer cancelar. Preencha data e horario se especificou.
- "reagendar": cliente quer mudar horário. Preencha os campos atuais e novos. Quando o cliente pediu pra trocar o horário e você já exibiu a agenda (listar), e o cliente agora informa um horário, use acao "reagendar" com todos os campos preenchidos a partir do histórico — horario e data do agendamento original, horario_novo e data_nova do novo pedido. Nunca retorne reagendar com campos null se o histórico tiver as informações.
- "listar": cliente quer ver horários disponíveis. Se pedir uma data específica, preencha "data". Se pedir múltiplas datas, preencha "datas" com o array e deixe "data" null. Use "data": null e "datas": null SOMENTE quando o cliente pedir explicitamente "essa semana" ou "a semana toda" — nunca para perguntas genéricas como "quais horários?" ou "tem vaga?". Em perguntas genéricas sem data, use acao "conversa" e pergunte qual dia ele quer. Em TODOS os casos de listar, escreva em "resposta" apenas uma frase curta de introdução — NUNCA liste horários na resposta, o sistema exibe a agenda automaticamente.
- Se o cliente responder a um lembrete confirmando presença (ex: "pode confirmar", "estarei lá", "confirmado", "vou estar", "tô lá", "estarei"), use acao "confirmar_presenca" e responda de forma amigável (ex: "Ótimo, te esperamos! ✂️"). Preencha "data" e "horario" se conseguir inferir do histórico.
- "conversa": SOMENTE para saudações ou dúvidas que não envolvem agendamento.
- Datas sempre no formato YYYY-MM-DD e horários HH:MM.
- Personalidade: jovem, informal e descontraído. Sem formalidade, sem frufru, mas sempre educado.
- Idioma: responda SEMPRE no mesmo idioma que o cliente usou. Se escrever em português, responda em português (estilo carioca, abrevia: tá, vc, tb, né, pra). Se escrever em espanhol, responda em espanhol (estilo paraguaio, use "vos" no lugar de "tú").
- Quando o cliente só cumprimentar, use o cumprimento do período e convide-o a falar (ex: "Opa, boa tarde! Como posso te ajudar?"). Sem listar opções do bot.
- Respostas curtas — máximo 2 linhas (exceto lista de horários).
- Emojis: no máximo 1 por mensagem, exceto na confirmação de agendamento que usa ✂️ + 💪🏼💪🏼.
- Evite "Que ótimo!", "Com certeza!", "Perfeito!", "Claro!", "Desculpe", "Olá".
- Não repita o nome do cliente em toda mensagem.
- Sobre saudações: ${greetInstruction}
- Interpretação de datas:
  * Se o cliente mencionar dia da semana E número do dia, use SEMPRE o número do dia.
  * Se mencionar só o dia da semana sem número, calcule a próxima ocorrência.
  * "amanhã" = dia seguinte ao hoje.
  * "hoje" = data de hoje.
  * Se só mencionar o número do dia sem mês, assuma o mês atual ou o próximo se já passou.
- Detecte o idioma do cliente e preencha "idioma": "pt" para português, "es" para espanhol, "en" para inglês.`;

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

  if (result.idioma) clientLanguages.set(phone, result.idioma);

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
  addToHistory,
  clearHistory,
  clearAllHistories,
  getValidatedName,
  setValidatedName,
};
