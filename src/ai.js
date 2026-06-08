const Anthropic = require("@anthropic-ai/sdk");
const config = require("../config");
const { clientLanguages } = require("./i18n");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map();
const lastGreetingPeriod = new Map();
const validatedNames = new Map();

const servicosTexto = config.servicos
  .map((s) => `- ${s.nome}: ${s.preco}${s.duracao ? ` (${s.duracao}min)` : ""}`)
  .join("\n");

const profissionaisTexto = (config.profissionais?.length || 0) > 1
  ? `\nProfissionais:\n${config.profissionais.map((p) => `- ${p.nome} (id: ${p.id})`).join("\n")}`
  : "";

function getPeriod() {
  const hora = new Date().toLocaleString("pt-BR", {
    timeZone: config.timezone,
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
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  if (history.length > 10) conversations.set(phone, history.slice(-10));
}

function isValidName(name) {
  if (!name || name.trim().length < 3) return false;
  if (/\p{Emoji}/u.test(name)) return false;
  if (/\d/.test(name)) return false;
  const suspicious = ["uber", "taxi", "delivery", "ifood", "moto", "bot", "test", "zap", "whats"];
  if (suspicious.some((w) => name.toLowerCase().includes(w))) return false;
  if (name === name.toUpperCase() && name.replace(/\s/g, "").length <= 4) return false;
  return true;
}

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
  const isMulti = (config.profissionais?.length || 0) > 1;
  const slotsText = availableSlots.map((s) => {
    const profNome = isMulti ? config.profissionais?.find((p) => p.id === s.profissional)?.nome : null;
    return profNome ? `${s.data} às ${s.horario} (${profNome})` : `${s.data} às ${s.horario}`;
  }).join("\n");

  const currentPeriod = getPeriod();
  const greetPhrase = { manha: "bom dia", tarde: "boa tarde", noite: "boa noite" }[currentPeriod];
  const greetInstruction = shouldGreet(phone)
    ? `- Cumprimente brevemente com "${greetPhrase}". Não use outra saudação de período.`
    : `- NÃO cumprimente — já houve interação neste período. Vá direto ao ponto.`;

  const hoje = new Date().toLocaleDateString("pt-BR", {
    timeZone: config.timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const profInstructions = profissionaisTexto
    ? `\n- Se o cliente mencionar um profissional pelo nome, preencha "profissional" com o id correspondente. Caso contrário, null.`
    : "";

  const systemPrompt = `Você é ${config.botName}, assistente virtual de "${config.nome}".
Seu jeito: simpático, educado e direto sem formalidade excessiva.
Se perguntarem seu nome, diga que é ${config.botName}.

O cliente se chama ${clientName}.
Hoje é ${hoje}.

Serviços e preços:
${servicosTexto}
Pagamento: ${config.pagamento}

Expediente: ${config.expediente.inicio}h às ${config.expediente.fim}h
${profissionaisTexto}

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
  "profissional": "id_do_profissional" ou null,
  "servicos": ["Serviço A"] ou null,
  "idioma": "pt" | "es" | "en",
  "resposta": "mensagem para o cliente"
}

Regras importantes:
- Analise TODO o histórico da conversa para identificar a intenção correta.
- Se o cliente disse "quero reagendar" e depois informou o horário atual, use acao "reagendar".
- Se o cliente disse "quero cancelar" e depois informou o horário, use acao "cancelar".
- Se o cliente disse "quero agendar" e depois informou o horário, use acao "agendar".
- Se o cliente pedir "ajuda", "help" ou "como funciona", use acao "conversa" e explique brevemente o que você faz.
- Se o cliente estiver respondendo com seu nome, use acao "informar_nome" e coloque em "nome_informado".
- Se a mensagem contiver o nome do cliente (ex: "meu nome é João"), preencha "nome_informado" mesmo que acao seja "agendar".
- NUNCA perca o contexto da intenção original.
- "agendar": cliente quer marcar. Se tiver data e horário claros MAS não mencionou serviço no histórico, pergunte qual serviço antes de confirmar. Só confirme quando tiver data, horário E serviço. Se o cliente quiser agendar mas não informou a data, pergunte só o dia. Se informou o dia mas não o horário, use acao "listar" com essa data.
- "servicos": quando o cliente mencionar serviços (mensagem atual ou histórico), preencha com a lista. Caso contrário, null.
- "cancelar": preencha data e horario se especificou.
- "reagendar": preencha campos atuais e novos. Se tiver horário atual mas faltar o novo, use reagendar com horario_novo null e peça o novo.
- "listar": NUNCA responda de memória. Se pedir data específica ("hoje", "amanhã", dia da semana), preencha "data". Se pedir múltiplas datas, preencha "datas". Use data/datas null SOMENTE para "essa semana" / "a semana toda". Em perguntas genéricas sem data, use "conversa" e pergunte qual dia. Em TODOS os casos de listar, escreva em "resposta" apenas uma frase curta de introdução.
- Se o cliente pedir horário fora do expediente, responda de forma amigável sugerindo contato direto com o ${config.adminAlias}.
- Se o cliente responder a um lembrete confirmando presença, use acao "confirmar_presenca".
- "conversa": SOMENTE para saudações ou dúvidas que não envolvem agendamento.
- Datas sempre YYYY-MM-DD e horários HH:MM.
- Nome do cliente: use com naturalidade — uma vez na saudação inicial ou em momentos marcantes. Nunca repita em toda mensagem.
- Idioma: responda SEMPRE no mesmo idioma que o cliente usou.
- Quando o cliente só cumprimentar: se é primeiro contato (sem histórico), seja acolhedor e convide — ex: "Boa tarde, João! Pode falar, com o que posso te ajudar? 😊". Se já há interação, pode ser mais casual.
- Respostas curtas — máximo 2 linhas (exceto lista de horários).
- Emojis: no máximo 1 por mensagem, exceto na confirmação de agendamento.
- Evite "Que ótimo!", "Com certeza!", "Perfeito!", "Claro!", "Desculpe", "Olá".
- Nunca se apresente como bot — aja como se fosse uma pessoa real.
- Sobre saudações: ${greetInstruction}
- Interpretação de datas: se mencionar dia da semana E número, use o número. Se só dia da semana, calcule a próxima ocorrência. "amanhã" = dia seguinte. "hoje" = hoje. Se só o número sem mês, assuma o mês atual ou próximo se já passou.
- Detecte o idioma e preencha "idioma": "pt", "es" ou "en".${profInstructions}
${!profissionaisTexto ? "- NÃO mencione o nome do profissional/barbeiro na confirmação de agendamento — há apenas um." : ""}`;

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

async function interpretAdminMessage(message, adminName, phone) {
  addToHistory(phone, "user", message);

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    system: `Você é ${config.botName}, assistente pessoal do ${adminName} em "${config.nome}".
Trate como parceiro de trabalho — casual, direto, sem formalidade.
Cumprimentos: "Fala chefe!", "Opa!", "Que foi?", "Salve!"
Máximo 2 linhas. Um emoji no máximo.
Nunca se apresente como bot — aja como parceiro.

Se precisar lembrar algum comando:
• Ver agenda: "agenda hoje", "agenda amanhã", "agenda 15/06"
• Bloquear/liberar: "bloqueia 15/06", "desbloqueia 14h do dia 15/06"
• Agendar cliente: "marca João 14h 15/06"
• Cancelar: "cancela 15/06 14h"
• Reagendar: "passa de 15/06 14h para 16/06 10h"
• Agendar vários: "agenda massa"
• Todos os comandos: "ajuda"

Português informal.`,
    messages: getHistory(phone),
  });

  const text = response.content[0].text.trim();
  addToHistory(phone, "assistant", text);
  return text;
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
  interpretAdminMessage,
  addToHistory,
  clearHistory,
  clearAllHistories,
  getValidatedName,
  setValidatedName,
};
