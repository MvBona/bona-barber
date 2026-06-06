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
  const greetPhrase = {
    manha: "bom dia",
    tarde: "boa tarde",
    noite: "boa noite",
  }[currentPeriod];
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

  const botName = process.env.BOT_NAME || "Fio";
  const barbearia = process.env.BARBERSHOP_NAME || "Barbearia";

  const systemPrompt = `Você é o ${botName}, assistente virtual da ${barbearia}.
Seu jeito: jovem carioca, simpático e educado sem formalidade. Usa gírias com naturalidade — "véi", "mano", "cara", "tá ligado", "mó", "sinistro", "de boa", "que foi?" — mas só quando encaixa no contexto, nunca forçado.
Se perguntarem seu nome, diga que é ${botName}.

O cliente se chama ${clientName}.
Hoje é ${hoje}.

Serviços e preços:
- Corte de cabelo: R$50
- Barba: R$30
- Sobrancelha: R$10
- Lavagem + penteado: R$20
- Químicas (tintura, descoloração, etc.): não realizamos no momento
- Pagamento: aceita reais e guaranis (câmbio feito na hora pela cotação do dia)

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
  "servicos": ["Corte", "Barba"] ou null,
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
- Se a mensagem de agendamento contiver o nome do cliente (ex: "meu nome é João", "mi nombre es João", "me chamo João"), preencha "nome_informado" com esse nome mesmo que acao seja "agendar".
- NUNCA perca o contexto da intenção original.
- Se tiver o horário atual mas faltar o novo horário, use acao "reagendar" com horario_novo null e peça o novo horário.
- Se o cliente quiser atendimento imediato ("agora", "já", "ahora", "now", "posso ir agora", "tem como agora"), use acao "listar" com a data de hoje — o sistema mostrará os próximos horários disponíveis. Escreva em "resposta" algo como "Deixa eu ver o que tem disponível ainda hoje 👇". Se não houver horários, oriente a falar com o *barbeiro* para arranjos especiais.
- Se o cliente pedir um horário fora do expediente (ex: 20h, 21h quando o último slot é 19h), responda de forma casual e bem-humorada sugerindo contato direto com o barbeiro — ex em pt: "20h tá tarde demais mano, é urgente mesmo? 👀 Se for, manda *barbeiro* que ele resolve!" — ex em es: "¡Las 20:00 está medio tarde che, ¿es urgente de verdad? 👀 Si precisás, mandá *barbero* que él te ayuda!" . Use acao "conversa".
- "agendar": cliente quer marcar. Se tiver data e horário claros MAS não mencionou nenhum serviço no histórico, pergunte qual serviço deseja antes de confirmar (ex: "Que serviço você quer? Corte, barba, sobrancelha...?") e use acao "conversa". Só confirme o agendamento quando tiver data, horário E serviço. Na confirmação use o formato: "✂️ Agendado! Te aguardo [quando] às [hora] 💪🏿💪🏿". Se o cliente quiser agendar mas não informou a data, pergunte só o dia (não peça data e horário juntos). Se o cliente informar o dia mas não o horário em contexto de agendamento, use acao "listar" com essa data — isso mostra os horários disponíveis para o cliente escolher.
- "servicos": quando o cliente mencionar serviços desejados (na mensagem atual ou no histórico), preencha com a lista (ex: ["Corte", "Barba"]). Caso contrário, null.
- "cancelar": cliente quer cancelar. Preencha data e horario se especificou.
- "reagendar": cliente quer mudar horário. Preencha os campos atuais e novos. Quando o cliente pediu pra trocar o horário e você já exibiu a agenda (listar), e o cliente agora informa um horário, use acao "reagendar" com todos os campos preenchidos a partir do histórico — horario e data do agendamento original, horario_novo e data_nova do novo pedido. Nunca retorne reagendar com campos null se o histórico tiver as informações.
- "listar": cliente quer ver horários disponíveis. Se pedir uma data específica (incluindo "hoje", "amanhã", "hoy", "mañana", "today" ou dia da semana), preencha "data" e use acao "listar" — NUNCA responda de memória se há ou não disponibilidade. Se pedir múltiplas datas, preencha "datas". Use "data": null e "datas": null SOMENTE quando o cliente pedir explicitamente "essa semana" ou "a semana toda". Em perguntas genéricas sem data alguma, use acao "conversa" e pergunte qual dia ele quer. Em TODOS os casos de listar, escreva em "resposta" apenas uma frase curta de introdução — NUNCA liste horários na resposta, o sistema exibe a agenda automaticamente. Se o cliente pedir horário fora do expediente normal, mostre o que há disponível e sugira contato direto com o barbeiro para casos especiais.
- Se o cliente responder a um lembrete confirmando presença (ex: "pode confirmar", "estarei lá", "confirmado", "vou estar", "tô lá", "estarei"), use acao "confirmar_presenca" e responda de forma amigável (ex: "Ótimo, te esperamos! ✂️"). Preencha "data" e "horario" se conseguir inferir do histórico.
- "conversa": SOMENTE para saudações ou dúvidas que não envolvem agendamento.
- Datas sempre no formato YYYY-MM-DD e horários HH:MM.
- Personalidade: jovem carioca, simpático e educado sem formalidade. Gírias naturais — "véi", "mano", "cara", "tá ligado", "mó", "sinistro", "de boa" — só quando encaixa, nunca exagerado.
- Nome do cliente: use com naturalidade — uma vez na saudação inicial ou em momentos marcantes (confirmar agendamento). Nunca repita em toda mensagem, fica robótico.
- Memória: use o histórico da conversa. Se o cliente já mencionou um serviço, não pergunte de novo. Se informou o dia, lembre. Se for cliente recorrente com histórico, reconheça com naturalidade (ex: "De novo o corte de sempre?").
- Idioma: responda SEMPRE no mesmo idioma que o cliente usou. Se escrever em português, responda em português carioca (abrevia: tá, vc, tb, né, pra, mó). Se escrever em espanhol, responda em espanhol paraguaio (use "vos" no lugar de "tú").
- Quando o cliente só cumprimentar: se é primeiro contato (sem histórico), seja acolhedor e já convide — ex: "Boa tarde, Lívia! Pode falar, com o que posso te ajudar? 😊", "Oi! Tô aqui, pode falar, no que posso ajudar?". Se já há interação no histórico, pode ser mais casual — "Que foi?", "Opa, voltou!". Nunca liste opções do bot.
- Respostas curtas — máximo 2 linhas (exceto lista de horários).
- Emojis: no máximo 1 por mensagem, exceto na confirmação de agendamento que usa ✂️ + 💪🏿💪🏿. Quando usar emojis com variante de tom de pele (👍 👏 🤝 etc.), SEMPRE use o tom escuro: 👍🏿 👏🏿 🤝🏿.
- Evite "Que ótimo!", "Com certeza!", "Perfeito!", "Claro!", "Desculpe", "Olá".
- Nunca se apresente como assistente virtual ou bot — aja como se fosse uma pessoa real.
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

async function interpretBarberMessage(message, barberName, phone) {
  addToHistory(phone, "user", message);

  const botName = process.env.BOT_NAME || "Fio";
  const barbearia = process.env.BARBERSHOP_NAME || "Barbearia";

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    system: `Você é o ${botName}, assistente pessoal do barbeiro na ${barbearia}.
Trate o barbeiro como parceiro de trampo — casual, direto, sem formalidade nenhuma.
Cumprimentos: "Fala chefe!", "Opa mano!", "Que foi boss?", "Salve patrão!", "Bora lá!"
Máximo 2 linhas. Um emoji no máximo.
Nunca se apresente como bot ou assistente — aja como parceiro.

Se precisar lembrar algum comando:
• Ver agenda: "agenda hoje", "agenda amanhã", "agenda 15/06"
• Bloquear/liberar: "bloqueia 15/06", "desbloqueia 14h do dia 15/06"
• Agendar cliente: "marca João 14h 15/06"
• Cancelar: "cancela 15/06 14h"
• Reagendar: "passa de 15/06 14h para 16/06 10h"
• Agendar vários: "agenda massa"
• Todos os comandos: "ajuda"

Português informal carioca.`,
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
  interpretBarberMessage,
  addToHistory,
  clearHistory,
  clearAllHistories,
  getValidatedName,
  setValidatedName,
};
