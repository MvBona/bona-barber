const config = require("../config");
const clientLanguages = new Map();
const alias = config.adminAlias;

const translations = {
  pt: {
    livre: "livre",
    ocupado: "ocupado",
    bloqueado: "bloqueado",
    agendaHeader: (d, m) => `📅 *Agenda ${d}/${m}*`,
    noSlots: "Não tem mais vaga pra essa data não.",
    reminder24h: (hora, nome, profNome) =>
      profNome
        ? `Lembrete: você tem horário com ${profNome} amanhã às ${hora} em ${nome}.`
        : `Lembrete: você tem horário amanhã às ${hora} em ${nome}.`,
    reminder2h: (hora, nome, profNome) =>
      profNome
        ? `Seu horário com ${profNome} é em 1 hora, às ${hora} em ${nome}.`
        : `Seu horário é em 1 hora, às ${hora} em ${nome}.`,
    waitingName: "Pera, qual é o seu nome pra eu marcar?",
    invalidName: "Não entendi não. Me fala seu nome aí.",
    bookingConfirm: (nome, horario, profNome, servico) =>
      profNome
        ? `Valeu, ${nome}! Tá marcado com ${profNome} pras ${horario}${servico ? ` — ${servico}` : ''}. Até lá! ✅`
        : `Valeu, ${nome}! Tá marcado pras ${horario}${servico ? ` — ${servico}` : ''}. Até lá! ✅`,
    maxBookings: `Vc já tem ${config.maxAgendamentosPorDia} horários nesse dia — é o máximo. Cancela um se quiser trocar.`,
    slotTaken: `Esse horário já foi. Dá uma olhada nos livres? Se quiser um específico, manda *${alias}*. 👍`,
    cancelTooLate: `Não rola cancelar com menos de ${config.cancelamentoMinHoras}h de antecedência. Se precisar, manda *${alias}* pra resolver.`,
    cancelReasonPrompt: `Entendido. Me conta o motivo do cancelamento pra eu passar pro ${alias}:`,
    cancelSuccess: "Cancelado! Qualquer coisa é só chamar. 👍",
    slotNotFound: "Não achei esse horário não. Confirma pra mim? 🤔",
    rescheduleTooLate: `Não rola reagendar com menos de ${config.cancelamentoMinHoras}h de antecedência. Se precisar, manda *${alias}* pra resolver.`,
    rescheduleConflict: "Esse horário já tá ocupado. Escolhe outro livre! 👍",
    rollbackFailed: `Deu um problema aqui — manda *${alias}* pra resolver, tá? 🙏`,
    generalError: "Deu um erro aqui. Espera um pouquinho e tenta dnv! 💪",
    barberNotified: `Já avisei o ${alias}, daqui a pouco ele já te responde aqui mesmo 📲`,
    handoffEnd: `O ${alias} encerrou o atendimento. Qualquer coisa é só chamar! ✅`,
    cantCancel: `Entre em contato com o ${alias} para cancelar agendamentos.`,
    help: `✅ *Tô aqui pra te ajudar:*\n\n📅 *Ver horários:*\n"tem vaga hoje?"\n"quais horários amanhã?"\n\n📌 *Agendar:*\n"quero marcar às 14h amanhã"\n\n❌ *Cancelar:*\n"quero cancelar meu horário"\n\n🔄 *Reagendar:*\n"muda meu horário de sexta pra sábado"\n\n📞 *Falar com o ${alias}:*\nManda *${alias}* que a gente chama`,
  },
  es: {
    livre: "libre",
    ocupado: "ocupado",
    bloqueado: "bloqueado",
    agendaHeader: (d, m) => `📅 *Agenda ${d}/${m}*`,
    noSlots: "No hay más turnos disponibles para esa fecha.",
    reminder24h: (hora, nome, profNome) =>
      profNome
        ? `Recordatorio: tenés turno con ${profNome} mañana a las ${hora} en ${nome}.`
        : `Recordatorio: tenés turno mañana a las ${hora} en ${nome}.`,
    reminder2h: (hora, nome, profNome) =>
      profNome
        ? `Tu turno con ${profNome} es en 1 hora, a las ${hora} en ${nome}.`
        : `Tu turno es en 1 hora, a las ${hora} en ${nome}.`,
    waitingName: "Esperá, ¿cuál es tu nombre para anotar el turno?",
    invalidName: "No entendí. Decime tu nombre.",
    bookingConfirm: (nome, horario, profNome, servico) =>
      profNome
        ? `¡Listo, ${nome}! Turno con ${profNome} confirmado a las ${horario}${servico ? ` — ${servico}` : ''}. ¡Te esperamos! ✅`
        : `¡Listo, ${nome}! Turno confirmado a las ${horario}${servico ? ` — ${servico}` : ''}. ¡Te esperamos! ✅`,
    langNote: "Ah, una cosita — nuestro negocio habla portugués principalmente, pero nos arreglamos en español 😄",
    maxBookings: `Ya tenés ${config.maxAgendamentosPorDia} turnos ese día — es el máximo. Cancelá uno si querés cambiar.`,
    slotTaken: `Ese horario ya fue. ¿Querés ver los disponibles? Si querés uno específico, mandá *${alias}*. 👍`,
    cancelTooLate: `No se puede cancelar con menos de ${config.cancelamentoMinHoras} horas de anticipación. Si necesitás, mandá *${alias}*.`,
    cancelReasonPrompt: `Entendido. Contame el motivo de la cancelación para avisarle al ${alias}:`,
    cancelSuccess: "¡Cancelado! Cualquier cosa avisá. 👍",
    slotNotFound: "No encontré ese horario. ¿Me confirmás? 🤔",
    rescheduleTooLate: `No se puede reprogramar con menos de ${config.cancelamentoMinHoras} horas de anticipación. Si necesitás, mandá *${alias}*.`,
    rescheduleConflict: "Ese horario ya está ocupado. ¡Elegí otro libre! 👍",
    rollbackFailed: `Hubo un problema — mandá *${alias}* para resolverlo. 🙏`,
    generalError: "Hubo un error. ¡Esperá un momento y volvé a intentar! 💪",
    barberNotified: `¡Ya avisé al ${alias}, en un momento te responde por aquí mismo! 📲`,
    handoffEnd: `El ${alias} cerró la atención. ¡Cualquier cosa avisá! ✅`,
    cantCancel: `Contactá al ${alias} para cancelar turnos.`,
    help: `✅ *Estoy aquí para ayudarte:*\n\n📅 *Ver horarios:*\n"¿hay lugar hoy?"\n"¿qué horarios hay mañana?"\n\n📌 *Reservar:*\n"quiero reservar a las 14h mañana"\n\n❌ *Cancelar:*\n"quiero cancelar mi turno"\n\n🔄 *Reprogramar:*\n"cambiá mi turno del viernes al sábado"\n\n📞 *Hablar con el ${alias}:*\nMandá *${alias}* y lo llamamos`,
  },
  en: {
    livre: "available",
    ocupado: "booked",
    bloqueado: "blocked",
    agendaHeader: (d, m) => `📅 *Schedule ${d}/${m}*`,
    noSlots: "No more slots available for that date.",
    reminder24h: (hora, nome, profNome) =>
      profNome
        ? `Reminder: you have an appointment with ${profNome} tomorrow at ${hora} at ${nome}.`
        : `Reminder: you have an appointment tomorrow at ${hora} at ${nome}.`,
    reminder2h: (hora, nome, profNome) =>
      profNome
        ? `Your appointment with ${profNome} is in 1 hour, at ${hora} at ${nome}.`
        : `Your appointment is in 1 hour, at ${hora} at ${nome}.`,
    waitingName: "Hold on — what's your name so I can book it?",
    invalidName: "Didn't get that. Tell me your name.",
    bookingConfirm: (nome, horario, profNome, servico) =>
      profNome
        ? `Done, ${nome}! Booked with ${profNome} for ${horario}${servico ? ` — ${servico}` : ''}. See you then! ✅`
        : `Done, ${nome}! Booked for ${horario}${servico ? ` — ${servico}` : ''}. See you then! ✅`,
    langNote: `Quick heads up — our ${alias} speaks Portuguese mainly, but we'll figure it out! 💪`,
    maxBookings: `You already have ${config.maxAgendamentosPorDia} appointments that day — that's the max.`,
    slotTaken: `That slot is taken. Want to check the available ones? If you need a specific time, send *${alias}*. 👍`,
    cancelTooLate: `Can't cancel with less than ${config.cancelamentoMinHoras} hours notice. If you need to, send *${alias}*.`,
    cancelReasonPrompt: `Understood. Tell me the reason for the cancellation:`,
    cancelSuccess: "Cancelled! Let me know if you need anything. 👍",
    slotNotFound: "Couldn't find that slot. Can you confirm? 🤔",
    rescheduleTooLate: `Can't reschedule with less than ${config.cancelamentoMinHoras} hours notice. If you need to, send *${alias}*.`,
    rescheduleConflict: "That slot is already taken. Choose another available one! 👍",
    rollbackFailed: `Something went wrong — send *${alias}* to fix it. 🙏`,
    generalError: "An error occurred. Wait a moment and try again! 💪",
    barberNotified: `I've notified the ${alias}, they'll get back to you here shortly! 📲`,
    handoffEnd: `The ${alias} has ended the chat. Feel free to reach out anytime! ✅`,
    cantCancel: `Contact the ${alias} to cancel appointments.`,
    help: `✅ *I'm here to help:*\n\n📅 *Check availability:*\n"any slots today?"\n"what times are available tomorrow?"\n\n📌 *Book:*\n"I want to book at 2pm tomorrow"\n\n❌ *Cancel:*\n"I want to cancel my appointment"\n\n🔄 *Reschedule:*\n"move my Friday to Saturday"\n\n📞 *Talk to the ${alias}:*\nSend *${alias}* and we'll get them`,
  },
};

function tr(phone, key, ...args) {
  const lang = clientLanguages.get(phone) || "pt";
  const t = translations[lang] || translations.pt;
  const val = t[key] !== undefined ? t[key] : translations.pt[key];
  if (typeof val === "function") return val(...args);
  return val || key;
}

module.exports = { tr, clientLanguages };
