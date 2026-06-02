const clientLanguages = new Map();

const translations = {
  pt: {
    livre: "livre",
    ocupado: "ocupado",
    bloqueado: "bloqueado",
    agendaHeader: (d, m) => `📅 *Agenda ${d}/${m}*`,
    noSlots: "Não tem mais vaga pra essa data não.",
    reminder24h: (hora, nome) => `Lembrete: você tem horário amanhã às ${hora} na ${nome}.`,
    reminder2h: (hora, nome) => `Seu horário é em 2 horas, às ${hora} na ${nome}.`,
    waitingName: "Pera, qual é o seu nome pra eu marcar?",
    invalidName: "Não entendi não. Me fala seu nome aí.",
    bookingConfirm: (nome, horario) => `Valeu, ${nome}! Tá marcado pras ${horario}. Até lá! ✂️`,
    maxBookings: "Vc já tem 2 horários nesse dia — é o máximo. Cancela um se quiser trocar.",
    slotTaken: "Esse horário já foi. Dá uma olhada nos livres? Se quiser um específico, manda *barbeiro*. 👍🏿",
    cancelTooLate: "Não rola cancelar com menos de 2h de antecedência. Se precisar, manda *barbeiro* pra resolver.",
    cancelReasonPrompt: "Entendido. Me conta o motivo do cancelamento pra eu passar pro barbeiro:",
    cancelSuccess: "Cancelado! Qualquer coisa é só chamar. 👍🏿",
    slotNotFound: "Não achei esse horário não. Confirma pra mim? 🤔",
    rescheduleTooLate: "Não rola reagendar com menos de 2h de antecedência. Se precisar, manda *barbeiro* pra resolver.",
    rescheduleConflict: "Esse horário já tá ocupado. Escolhe outro livre! 👍🏿",
    rollbackFailed: "Deu um problema aqui — manda *barbeiro* pra resolver, tá? 🙏",
    generalError: "Deu um erro aqui. Espera um pouquinho e tenta dnv! 💪🏿",
    barberNotified: "Já avisei o barb! Ele te chama em breve. 📞",
    help: "✂️ *Tô aqui pra te ajudar:*\n\n📅 *Ver horários:*\n\"tem vaga hoje?\"\n\"quais horários amanhã?\"\n\n📌 *Agendar:*\n\"quero marcar às 14h amanhã\"\n\n❌ *Cancelar:*\n\"quero cancelar meu horário\"\n\n🔄 *Reagendar:*\n\"muda meu horário de sexta pra sábado\"\n\n📞 *Falar com o barbeiro:*\nManda *barbeiro* que a gente chama ele",
  },
  es: {
    livre: "libre",
    ocupado: "ocupado",
    bloqueado: "bloqueado",
    agendaHeader: (d, m) => `📅 *Agenda ${d}/${m}*`,
    noSlots: "No hay más turnos disponibles para esa fecha.",
    reminder24h: (hora, nome) => `Recordatorio: tenés turno mañana a las ${hora} en ${nome}.`,
    reminder2h: (hora, nome) => `Tu turno es en 2 horas, a las ${hora} en ${nome}.`,
    waitingName: "Esperá, ¿cuál es tu nombre para anotar el turno?",
    invalidName: "No entendí. Decime tu nombre.",
    bookingConfirm: (nome, horario) => `¡Listo, ${nome}! Turno confirmado a las ${horario}. ¡Te esperamos! ✂️`,
    langNote: "Ah, una cosita — nuestro barba habla portugués y se maneja bien en español, así que va a estar todo bien 😄✌🏿",
    maxBookings: "Ya tenés 2 turnos ese día — es el máximo. Cancelá uno si querés cambiar.",
    slotTaken: "Ese horario ya fue. ¿Querés ver los disponibles? Si querés uno específico, mandá *barbero*. 👍🏿",
    cancelTooLate: "No se puede cancelar con menos de 2 horas de anticipación. Si necesitás, mandá *barbero*.",
    cancelReasonPrompt: "Entendido. Contame el motivo de la cancelación para avisarle al barbero:",
    cancelSuccess: "¡Cancelado! Cualquier cosa avisá. 👍🏿",
    slotNotFound: "No encontré ese horario. ¿Me confirmás? 🤔",
    rescheduleTooLate: "No se puede reprogramar con menos de 2 horas de anticipación. Si necesitás, mandá *barbero*.",
    rescheduleConflict: "Ese horario ya está ocupado. ¡Elegí otro libre! 👍🏿",
    rollbackFailed: "Hubo un problema — mandá *barbero* para resolverlo. 🙏",
    generalError: "Hubo un error. ¡Esperá un momento y volvé a intentar! 💪🏿",
    barberNotified: "¡Ya avisé al barbero! Te llama en breve. 📞",
    help: "✂️ *Estoy aquí para ayudarte:*\n\n📅 *Ver horarios:*\n\"¿hay lugar hoy?\"\n\"¿qué horarios hay mañana?\"\n\n📌 *Reservar:*\n\"quiero reservar a las 14h mañana\"\n\n❌ *Cancelar:*\n\"quiero cancelar mi turno\"\n\n🔄 *Reprogramar:*\n\"cambiá mi turno del viernes al sábado\"\n\n📞 *Hablar con el barbero:*\nMandá *barbero* y lo llamamos",
  },
  en: {
    livre: "available",
    ocupado: "booked",
    bloqueado: "blocked",
    agendaHeader: (d, m) => `📅 *Schedule ${d}/${m}*`,
    noSlots: "No more slots available for that date.",
    reminder24h: (hora, nome) => `Reminder: you have an appointment tomorrow at ${hora} at ${nome}.`,
    reminder2h: (hora, nome) => `Your appointment is in 2 hours, at ${hora} at ${nome}.`,
    waitingName: "Hold on — what's your name so I can book it?",
    invalidName: "Didn't get that. Tell me your name.",
    bookingConfirm: (nome, horario) => `Done, ${nome}! Booked for ${horario}. See you then! ✂️`,
    langNote: "Quick heads up — our barber speaks Portuguese and can get by in Spanish, but English is a stretch 😅 Hope that's okay, we'll figure it out! 💪🏿",
    maxBookings: "You already have 2 appointments that day — that's the max. Cancel one if you want to change.",
    slotTaken: "That slot is taken. Want to check the available ones? If you need a specific time, send *barber*. 👍🏿",
    cancelTooLate: "Can't cancel with less than 2 hours notice. If you need to, send *barber*.",
    cancelReasonPrompt: "Understood. Tell me the reason for the cancellation so I can pass it to the barber:",
    cancelSuccess: "Cancelled! Let me know if you need anything. 👍🏿",
    slotNotFound: "Couldn't find that slot. Can you confirm? 🤔",
    rescheduleTooLate: "Can't reschedule with less than 2 hours notice. If you need to, send *barber*.",
    rescheduleConflict: "That slot is already taken. Choose another available one! 👍🏿",
    rollbackFailed: "Something went wrong — send *barber* to fix it. 🙏",
    generalError: "An error occurred. Wait a moment and try again! 💪🏿",
    barberNotified: "I've notified the barber! He'll reach out soon. 📞",
    help: "✂️ *I'm here to help:*\n\n📅 *Check availability:*\n\"any slots today?\"\n\"what times are available tomorrow?\"\n\n📌 *Book:*\n\"I want to book at 2pm tomorrow\"\n\n❌ *Cancel:*\n\"I want to cancel my appointment\"\n\n🔄 *Reschedule:*\n\"move my Friday to Saturday\"\n\n📞 *Talk to the barber:*\nSend *barber* and we'll get him",
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
