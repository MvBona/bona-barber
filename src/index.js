console.log("=== INICIANDO ===");

process.on("uncaughtException", (err) => { console.error("ERRO FATAL:", err.message, err.stack); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("PROMISE REJEITADA:", err.message, err.stack); process.exit(1); });

require("dotenv").config();

const express = require("express");
const path = require("path");
const schedule = require("node-cron");
const config = require("../config");
const { tr, clientLanguages } = require("./i18n");
const { initBaileys, sendMessage, downloadMediaMessage, jidToPhone } = require("./whatsapp");
const {
  getAvailableSlots, getProfissionaisDisponibilidade, bookSlot, bookSlotAdmin,
  cancelSlot, cancelSlotAdmin, rescheduleSlot, getAppointmentsForReminder,
  markReminderSent, appendLembretes, getUnconfirmedReminders,
  countClientAppointmentsOnDay, getSlotInfo, getDaySchedule,
  updateClientPhone, getClientName, getWeeklySummary, getSlotsForDates,
  setCustomHours, getProfissionais, isMultiProfessional,
} = require("./sheets");
const { interpretMessage, interpretAdminMessage, addToHistory, clearAllHistories } = require("./ai");
const { transcribeAudio } = require("./transcribe");
const {
  generateWeeklySlots, resetSlots, blockDay, blockSlot, blockPeriod,
  unblockDay, unblockSlot, unblockPeriod,
} = require("./scheduler");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const ADMIN_PHONE = config.telefoneAdmin;
const TZ = config.timezone;

const debounceTimers = new Map();
const pendingMessages = new Map();
const waitingForNameToBook = new Map();      // phone → { data, horario, profId, servico }
const waitingForProfissional = new Map();    // phone → { data, horario, servico, nomePendente, disponibilidade }
const humanHandoff = new Map();
const waitingForCancelReason = new Map();
const waitingForClientPhone = new Map();
const waitingForMassBooking = new Set();
const waitingForCustomHours = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
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

// Retorna o perfil de quem enviou a mensagem
function getCallerProfile(phone) {
  if (phone === ADMIN_PHONE) {
    const prof = config.profissionais?.find((p) => p.telefone === phone) || null;
    return { tipo: "admin", isProf: !!prof, prof };
  }
  if (config.adminsPorProfissional) {
    const prof = config.profissionais?.find((p) => p.telefone === phone) || null;
    if (prof) return { tipo: "profissional", isProf: true, prof };
  }
  return { tipo: "cliente", isProf: false, prof: null };
}

// Busca um profissional pelo nome no texto normalizado
function findProfInText(normalized) {
  if (!config.profissionais?.length) return null;
  for (const prof of config.profissionais) {
    const n = prof.nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (normalized.includes(n)) return prof;
  }
  return null;
}

// Determina o profId alvo para comandos de AÇÃO (bloquear, cancelar, agendar)
// Retorna { profId } ou { error: "mensagem" }
function getActionProfId(callerProfile, targetProf, isTudo) {
  if (targetProf) {
    if (callerProfile.tipo === "profissional" && targetProf.id !== callerProfile.prof.id) {
      return { error: "Você só pode modificar sua própria agenda." };
    }
    return { profId: targetProf.id };
  }
  if (isTudo) {
    if (callerProfile.tipo === "profissional") {
      return { error: "Você só pode bloquear sua própria agenda. Para fechar tudo, fale com o responsável." };
    }
    return { profId: null };
  }
  if (callerProfile.tipo === "profissional") return { profId: callerProfile.prof.id };
  if (callerProfile.tipo === "admin" && callerProfile.isProf) return { profId: callerProfile.prof.id };
  return { profId: null }; // dono puro → todos
}

// Determina o profId alvo para comandos de VISUALIZAÇÃO (agenda)
function getViewProfId(callerProfile, targetProf) {
  if (targetProf) return targetProf.id;
  if (callerProfile.tipo === "profissional") return callerProfile.prof.id;
  if (callerProfile.tipo === "admin" && callerProfile.isProf) return callerProfile.prof.id;
  return null; // dono puro → todos
}

// Formata a agenda do dia para admins/profissionais
function formatDaySchedule(daySchedule, scopeProfId, dd, mm) {
  const header = `📅 *Agenda ${dd}/${mm}*\n\n`;
  if (!daySchedule.length) return `${header}Nenhum horário cadastrado.`;

  const multi = isMultiProfessional() && !scopeProfId;
  if (!multi) {
    const lines = daySchedule.map((s) => {
      if (s.status === "agendado") return `🔴 ${s.horario} — ${s.nome}`;
      if (s.status === "bloqueado") return `⚪ ${s.horario} — bloqueado`;
      return `🟢 ${s.horario} — livre`;
    });
    return header + lines.join("\n");
  }

  const profissionais = getProfissionais();
  const byProf = {};
  for (const slot of daySchedule) {
    if (!byProf[slot.profissional]) byProf[slot.profissional] = [];
    byProf[slot.profissional].push(slot);
  }
  const parts = profissionais
    .filter((p) => byProf[p.id]?.length)
    .map((p) => {
      const lines = byProf[p.id].map((s) => {
        if (s.status === "agendado") return `🔴 ${s.horario} — ${s.nome}`;
        if (s.status === "bloqueado") return `⚪ ${s.horario} — bloqueado`;
        return `🟢 ${s.horario} — livre`;
      });
      return `👤 *${p.nome}:*\n${lines.join("\n")}`;
    });
  return header + parts.join("\n\n");
}

// Agrega slots por horário para view do cliente (oculta multi-prof)
function aggregateByHorario(slots) {
  const byTime = new Map();
  for (const slot of slots) {
    if (!byTime.has(slot.horario)) byTime.set(slot.horario, []);
    byTime.get(slot.horario).push(slot);
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([horario, profs]) => {
      const disponiveis = profs.filter((p) => p.status === "livre");
      return {
        horario,
        status: disponiveis.length > 0 ? "livre" : profs.every((p) => p.status === "bloqueado") ? "bloqueado" : "agendado",
      };
    });
}

async function notifyAdmin(message) {
  if (!ADMIN_PHONE) return;
  try { await sendMessage(ADMIN_PHONE, message); } catch (e) { console.error("Erro ao notificar admin:", e.message); }
}

async function notifyProfissional(profId, message) {
  const prof = config.profissionais?.find((p) => p.id === profId);
  if (!prof?.telefone || prof.telefone === ADMIN_PHONE) return;
  try { await sendMessage(prof.telefone, message); } catch (e) { console.error(`Erro ao notificar prof ${profId}:`, e.message); }
}

// ── Mensagem de seleção de profissional ─────────────────────────────────────

async function sendProfissionalSelection(phone, data, horario, disponibilidade) {
  const [, mm, dd] = data.split("-");
  const h = horario;
  const disponiveis = disponibilidade.filter((p) => p.disponivelNoHorario);
  const indisponiveis = disponibilidade.filter((p) => !p.disponivelNoHorario);

  let msg = `Com quem você prefere marcar?\n\n📅 ${dd}/${mm} às ${h}:\n`;
  for (const p of disponiveis) msg += `• ${p.nome} ✅ disponível\n`;
  for (const p of indisponiveis) {
    if (p.proximo) {
      const [, pm, pd] = p.proximo.data.split("-");
      msg += `• ${p.nome} — próximo: ${pd}/${pm} às ${p.proximo.horario}\n`;
    } else {
      msg += `• ${p.nome} — sem horários disponíveis\n`;
    }
  }
  return msg.trim();
}

// ── Resumo semanal ───────────────────────────────────────────────────────────

async function sendWeeklySummary() {
  try {
    const { semanaPassada, proximaSemana } = await getWeeklySummary();
    const total = semanaPassada.length;
    const nomes = [...new Set(semanaPassada.map((s) => s.nome))];
    const listaClientes = nomes.length ? nomes.map((n) => `• ${n}`).join("\n") : "• Nenhum atendimento registrado";
    const msg =
      `📊 *Resumo da semana*\n\n` +
      `✅ *Semana passada — ${total} atendimento${total !== 1 ? "s" : ""}*\n${listaClientes}\n\n` +
      `📅 *Semana que vem — ${proximaSemana.length} agendamento${proximaSemana.length !== 1 ? "s" : ""} confirmado${proximaSemana.length !== 1 ? "s" : ""}*\n\nBom descanso! 🙌`;
    await notifyAdmin(msg);
  } catch (e) { console.error("Erro ao enviar resumo semanal:", e.message); }
}

async function sendUnconfirmedNotifications(tipo, minutosGraca) {
  try {
    const appointments = await getUnconfirmedReminders(tipo, minutosGraca);
    if (!appointments.length) return;
    const linhas = appointments.map(
      (a) => `👤 ${a.nome || "Cliente"} — ${fmtDate(a.data)} às ${a.horario} — 📞 ${a.telefone}`,
    );
    const msg =
      `⚠️ *Sem resposta ao lembrete de ${tipo} — ${appointments.length} cliente${appointments.length !== 1 ? "s" : ""}*\n\n` +
      linhas.join("\n") + `\n\nJá faz ${minutosGraca}min desde o lembrete, nenhuma resposta.`;
    await notifyAdmin(msg);
    for (const appt of appointments) await appendLembretes(appt.sheetName, appt.rowIndex, appt.lembretes, `${tipo}-aviso`);
  } catch (e) { console.error(`Erro ao verificar sem-resposta ${tipo}:`, e.message); }
}

async function sendReminders(horasAntes) {
  try {
    const appointments = await getAppointmentsForReminder(horasAntes);
    for (const appt of appointments) {
      const profNome = isMultiProfessional()
        ? (config.profissionais?.find((p) => p.id === appt.profissional)?.nome || null)
        : null;
      const msg = horasAntes === 24
        ? tr(appt.telefone, "reminder24h", appt.horario, config.nome, profNome)
        : tr(appt.telefone, "reminder2h", appt.horario, config.nome, profNome);
      await markReminderSent(appt.sheetName, appt.rowIndex, appt.lembretes, `${horasAntes}h`);
      await sendMessage(appt.telefone, msg);
      addToHistory(appt.telefone, "assistant", msg);
    }
  } catch (e) { console.error(`Erro ao enviar lembretes ${horasAntes}h:`, e.message); }
}

// ── Processamento de comandos admin ─────────────────────────────────────────

async function processAdminCommand(text, callerProfile) {
  const normalized = text
    .toLowerCase().trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\bhj\b/g, "hoje")
    .replace(/\bamh[aã]\b|\bamha\b/g, "amanha");

  const n = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const currentYear = n.getFullYear();
  const currentMonth = String(n.getMonth() + 1).padStart(2, "0");

  const monthNames = { janeiro:"01",fevereiro:"02",marco:"03",abril:"04",maio:"05",junho:"06",julho:"07",agosto:"08",setembro:"09",outubro:"10",novembro:"11",dezembro:"12" };

  function parseMonth(m) {
    if (/^\d+$/.test(m)) return m.padStart(2, "0");
    return monthNames[m] || null;
  }

  function extractDate(str) {
    if (str.includes("hoje")) return `${currentYear}-${currentMonth}-${String(n.getDate()).padStart(2, "0")}`;
    if (str.includes("amanha")) {
      const t = new Date(n); t.setDate(n.getDate() + 1);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    }
    const match = str.match(/(?:dia\s+)?(\d{1,2})[\/\s](?:do\s+|de\s+)?(\d{1,2}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?/);
    if (!match) return null;
    const day = match[1].padStart(2, "0");
    const month = parseMonth(match[2]);
    const year = match[3] || currentYear;
    return month ? `${year}-${month}-${day}` : null;
  }

  function extractTime(str) {
    const periodMatch = str.match(/(\d{1,2})\s+da\s+(manha|tarde|noite)/);
    if (periodMatch) {
      let hour = parseInt(periodMatch[1]);
      if (periodMatch[2] === "tarde" && hour < 12) hour += 12;
      if (periodMatch[2] === "noite" && hour < 12) hour += 12;
      return String(hour).padStart(2, "0") + ":00";
    }
    const match = str.match(/\b(\d{1,2})(?:h|:00)\b/);
    return match ? match[1].padStart(2, "0") + ":00" : null;
  }

  function extractTwoTimes(str) {
    const match = str.match(/(\d{1,2})h?\s+(?:para|pro|pra).+?(\d{1,2})h/);
    return match ? { de: match[1].padStart(2, "0") + ":00", para: match[2].padStart(2, "0") + ":00" } : null;
  }

  function extractTwoDates(str) {
    const tomorrow = new Date(n); tomorrow.setDate(n.getDate() + 1);
    const dayAfter = new Date(n); dayAfter.setDate(n.getDate() + 2);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const fromMatch = str.match(/(?:de\s+)?(.+?)\s+(?:para|pro|pra)\s+(.+)/);
    if (!fromMatch) return null;
    function parseDateStr(s) {
      if (s.includes("depois de amanha")) return fmt(dayAfter);
      if (s.includes("amanha")) return fmt(tomorrow);
      if (s.includes("hoje")) return fmt(n);
      return extractDate(s);
    }
    const from = parseDateStr(fromMatch[1]);
    const to = parseDateStr(fromMatch[2]);
    return from && to ? { de: from, para: to } : null;
  }

  function extractPeriod(str) {
    const match = str.match(/(?:dia\s+)?(\d{1,2})[\/\s](?:do\s+|de\s+)?(\d{1,2}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?\s+a[o]?\s+(?:dia\s+)?(\d{1,2})[\/\s](?:do\s+|de\s+)?(\d{1,2}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:[\/\s](\d{4}))?/);
    if (!match) return null;
    const month1 = parseMonth(match[2]);
    const month2 = parseMonth(match[5]);
    return month1 && month2 ? {
      inicio: `${match[3] || currentYear}-${month1}-${match[1].padStart(2, "0")}`,
      fim: `${match[6] || currentYear}-${month2}-${match[4].padStart(2, "0")}`,
    } : null;
  }

  const isTudo = normalized.includes("tudo") || normalized.includes("todos");
  const targetProf = findProfInText(normalized);

  // ── DESBLOQUEAR ───────────────────────────────────────────────────────────
  const hasUnblock = normalized.includes("desbloquear") || normalized.includes("desbloqueia") ||
    normalized.includes("desbloqueie") || normalized.includes("abrir dia") ||
    normalized.includes("abre dia") || normalized.includes("liberar") || normalized.includes("libera");

  if (hasUnblock) {
    const { profId, error } = getActionProfId(callerProfile, targetProf, isTudo);
    if (error) return error;

    const timeMatch = extractTime(normalized);
    const dateMatch = extractDate(normalized);
    if (timeMatch && dateMatch) {
      const count = await unblockSlot(dateMatch, timeMatch, profId || getProfissionais()[0].id);
      const [, m, d] = dateMatch.split("-");
      const profLabel = profId && isMultiProfessional() ? ` (${config.profissionais.find((p) => p.id === profId)?.nome || profId})` : "";
      return count > 0 ? `🟢 ${timeMatch} de ${d}/${m} liberado${profLabel}.` : `❌ ${timeMatch} de ${d}/${m} não estava bloqueado.`;
    }
    const period = extractPeriod(normalized);
    if (period) {
      const count = await unblockPeriod(period.inicio, period.fim, profId);
      return count > 0 ? `🟢 Período liberado — ${count} horário(s) desbloqueado(s).` : `❌ Nenhum horário bloqueado nesse período.`;
    }
    if (dateMatch) {
      const count = await unblockDay(dateMatch, profId);
      const [, m, d] = dateMatch.split("-");
      return count > 0 ? `🟢 ${d}/${m} liberado — ${count} horário(s).` : `❌ Nenhum horário bloqueado em ${d}/${m}.`;
    }
  }

  // ── BLOQUEAR ──────────────────────────────────────────────────────────────
  const hasBlock = normalized.includes("bloquear") || normalized.includes("bloqueia") ||
    normalized.includes("bloqueie") || normalized.includes("fechar") ||
    normalized.includes("fecha") || normalized.includes("cancelar dia") || normalized.includes("folga");

  if (hasBlock) {
    const { profId, error } = getActionProfId(callerProfile, targetProf, isTudo);
    if (error) return error;

    const timeMatch = extractTime(normalized);
    const dateMatch = extractDate(normalized);
    if (timeMatch && dateMatch) {
      const pid = profId || getProfissionais()[0].id;
      const count = await blockSlot(dateMatch, timeMatch, pid);
      const [, m, d] = dateMatch.split("-");
      const profLabel = isMultiProfessional() ? ` (${config.profissionais?.find((p) => p.id === pid)?.nome || pid})` : "";
      return count > 0 ? `🔴 ${timeMatch} de ${d}/${m} bloqueado${profLabel}.` : `❌ Horário ${timeMatch} não encontrado em ${d}/${m}.`;
    }
    const period = extractPeriod(normalized);
    if (period) {
      const count = await blockPeriod(period.inicio, period.fim, profId);
      return count > 0 ? `🔴 Período bloqueado — ${count} horário(s).` : `❌ Nenhum horário disponível nesse período.`;
    }
    if (dateMatch) {
      const count = await blockDay(dateMatch, profId);
      const [, m, d] = dateMatch.split("-");
      return count > 0 ? `🔴 ${d}/${m} bloqueado — ${count} horário(s).` : `❌ Nenhum horário disponível em ${d}/${m}.`;
    }
  }

  // ── REAGENDAR ─────────────────────────────────────────────────────────────
  const hasReschedule = normalized.includes("passa") || normalized.includes("muda") ||
    normalized.includes("move") || normalized.includes("transfere") || normalized.includes("reagenda");

  if (hasReschedule && callerProfile.tipo === "admin") {
    const times = extractTwoTimes(normalized);
    const dates = extractTwoDates(normalized);
    if (times && dates) {
      const slotInfo = await getSlotInfo(dates.de, times.de, targetProf?.id || null);
      if (!slotInfo || slotInfo.status !== "agendado") {
        const [, m, d] = dates.de.split("-");
        return `❌ Nenhum agendamento em ${d}/${m} às ${times.de}.`;
      }
      const newSlotInfo = await getSlotInfo(dates.para, times.para, slotInfo.profissional);
      if (!newSlotInfo) {
        const [, m, d] = dates.para.split("-");
        return `❌ Horário ${times.para} não existe na agenda de ${d}/${m}.`;
      }
      if (newSlotInfo.status === "agendado") {
        const [, m, d] = dates.para.split("-");
        return `⚠️ ${times.para} de ${d}/${m} já está com *${newSlotInfo.nome}*.`;
      }
      await cancelSlotAdmin(dates.de, times.de, slotInfo.profissional);
      const booked = await bookSlotAdmin(dates.para, times.para, slotInfo.profissional, slotInfo.nome, slotInfo.telefone);
      if (!booked) {
        await bookSlotAdmin(dates.de, times.de, slotInfo.profissional, slotInfo.nome, slotInfo.telefone);
        return `❌ Não consegui reagendar. Horário mantido em ${fmtDate(dates.de)}.`;
      }
      const [yd, md, dd] = dates.de.split("-");
      const [yp, mp, dp] = dates.para.split("-");
      await sendMessage(slotInfo.telefone, `Olá ${slotInfo.nome}! Seu horário foi alterado de ${dd}/${md} às ${times.de} para ${dp}/${mp} às ${times.para}.`);
      return `✅ *${slotInfo.nome}* reagendado\n${dd}/${md} às ${times.de} → ${dp}/${mp} às ${times.para}\n📲 Cliente notificado.`;
    }
  }

  // ── CANCELAR ──────────────────────────────────────────────────────────────
  const hasCancel = normalized.includes("cancela") || normalized.includes("cancelar") ||
    normalized.includes("remove") || normalized.includes("apaga");

  if (hasCancel) {
    const timeMatch = extractTime(normalized);
    const dateMatch = extractDate(normalized);
    if (timeMatch && dateMatch) {
      const { profId, error } = getActionProfId(callerProfile, targetProf, false);
      if (error) return error;

      // Contratado sem permissão de cancelar
      if (callerProfile.tipo === "profissional" && !config.permissoesContratado?.cancelar) {
        return `❌ Entre em contato com o responsável para cancelar agendamentos.`;
      }

      const cancelled = await cancelSlotAdmin(dateMatch, timeMatch, profId);
      const [, m, d] = dateMatch.split("-");
      if (cancelled) {
        await sendMessage(cancelled.clientPhone, `Olá ${cancelled.clientName}! Seu horário do dia ${d}/${m} às ${timeMatch} foi cancelado. Entre em contato para reagendar.`);
        return `❎ *${cancelled.clientName}* — ${d}/${m} às ${timeMatch} cancelado\n📲 Cliente notificado.`;
      }
      return `❌ Nenhum agendamento em ${d}/${m} às ${timeMatch}.`;
    }
  }

  // ── AGENDAMENTO EM MASSA (somente admin total) ────────────────────────────
  const hasMassBooking = (normalized.includes("agenda massa") || normalized.includes("em massa") ||
    normalized.includes("agendamento em massa")) && callerProfile.tipo === "admin";

  if (hasMassBooking) {
    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const triggerNorm = lines[0].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const defaultDate = extractDate(triggerNorm) || `${currentYear}-${currentMonth}-${String(n.getDate()).padStart(2, "0")}`;
    const bookingLines = lines.slice(1);

    if (!bookingLines.length) {
      waitingForMassBooking.add(ADMIN_PHONE);
      return `📋 *Agendamento em massa*\n\nManda os agendamentos, um por linha:\n\n*Nome Número HHh DD/MM*\n\nExemplo:\nJoão 21999991234 14h 04/06\nMaria 15h 05/06`;
    }

    const defaultProfId = callerProfile.isProf ? callerProfile.prof.id : getProfissionais()[0].id;
    const results = [];
    for (const line of bookingLines) {
      const lineNorm = line.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const lineDate = extractDate(lineNorm) || defaultDate;
      const [, lm, ld] = lineDate.split("-");
      const timeMatch = line.match(/\b(\d{1,2})(?:h|:00)\b/i);
      if (!timeMatch) { results.push(`❓ "${line}" — não entendi o horário`); continue; }
      const horario = timeMatch[1].padStart(2, "0") + ":00";

      const lineProfTarget = findProfInText(lineNorm);
      const lineProfId = lineProfTarget?.id || defaultProfId;

      const semData = line.replace(/\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g, "");
      const phoneMatch = semData.match(/\b(\d{8,13})\b/);
      let clientPhone = ADMIN_PHONE;
      let hasPhone = false;
      if (phoneMatch) {
        let num = phoneMatch[1];
        if (!num.startsWith("55") && num.length <= 11) num = "55" + num;
        if (num.length >= 10 && num.length <= 13) { clientPhone = num; hasPhone = true; }
      }

      const namePart = line
        .replace(/\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g, "").replace(/\b\d{8,13}\b/g, "")
        .replace(/\b\d{1,2}(?:h|:00)\b/gi, "").replace(/\s+/g, " ").trim();
      const clientName = namePart
        ? namePart.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")
        : "Cliente";

      const existing = await getSlotInfo(lineDate, horario, lineProfId);
      if (!existing) { results.push(`❌ ${ld}/${lm} ${horario} — horário não existe`); continue; }
      if (existing.status === "agendado") { results.push(`⚠️ ${ld}/${lm} ${horario} — já com *${existing.nome}*`); continue; }

      const booked = await bookSlotAdmin(lineDate, horario, lineProfId, clientName, clientPhone);
      const profLabel = isMultiProfessional() ? ` — ${config.profissionais?.find((p) => p.id === lineProfId)?.nome || lineProfId}` : "";
      results.push(booked ? `✅ ${ld}/${lm} ${horario}${profLabel} — ${clientName}` : `❌ ${ld}/${lm} ${horario} — falhou`);
    }
    return `📋 *Agendamentos em massa*\n\n${results.join("\n")}`;
  }

  // ── AGENDAR CLIENTE ───────────────────────────────────────────────────────
  const hasBook = normalized.includes("agenda") || normalized.includes("marca") || normalized.includes("reserva");

  if (hasBook) {
    const timeMatch = extractTime(normalized);
    const dateMatch = extractDate(normalized);
    if (timeMatch && dateMatch) {
      const targetBookProf = targetProf || (callerProfile.isProf ? callerProfile.prof : null) || getProfissionais()[0];
      if (!targetBookProf) return `❌ Informe o profissional para agendar.`;

      if (callerProfile.tipo === "profissional" && targetBookProf.id !== callerProfile.prof.id) {
        return `❌ Você só pode agendar na sua própria agenda.`;
      }

      const phoneExtract = (() => {
        const sem_datas = normalized.replace(/\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g, "");
        const m = sem_datas.match(/\b(\d{8,13})\b/);
        if (!m) return null;
        let num = m[1];
        if (!num.startsWith("55") && num.length <= 11) num = "55" + num;
        return num.length >= 10 ? num : null;
      })();
      const clientPhone = phoneExtract || callerProfile.prof?.telefone || ADMIN_PHONE;

      const afterVerb = normalized.replace(/.*?(?:agenda|marca|reserva)\s+(?:pra?\s+|para\s+)?/, "");
      const nameRaw = afterVerb
        .replace(/\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/g, "").replace(/\b\d{8,13}\b/g, "")
        .replace(/\b\d{1,2}\s*h\b/g, "").replace(/\b(?:dia|hoje|amanha|às|as|de|do|da|para|pra|no|na)\b/g, "")
        .replace(/\s+/g, " ").trim();
      const clientName = nameRaw ? nameRaw.replace(/\b\w/g, (c) => c.toUpperCase()) : "Cliente";

      const existing = await getSlotInfo(dateMatch, timeMatch, targetBookProf.id);
      if (existing && existing.status === "agendado") {
        const [, m, d] = dateMatch.split("-");
        return `⚠️ ${d}/${m} às ${timeMatch} já está com *${existing.nome}*.`;
      }
      const booked = await bookSlotAdmin(dateMatch, timeMatch, targetBookProf.id, clientName, clientPhone);
      const [, m, d] = dateMatch.split("-");
      const profLabel = isMultiProfessional() ? ` — ${targetBookProf.nome}` : "";
      if (booked) {
        if (!phoneExtract) {
          waitingForClientPhone.set(callerProfile.prof?.telefone || ADMIN_PHONE, { data: dateMatch, horario: timeMatch, nome: clientName, profId: targetBookProf.id });
          return `✅ Agendado *${clientName}*${profLabel} — ${d}/${m} às ${timeMatch}.\n⚠️ Sem número — cliente não receberá lembretes.\nEnvia o número do cliente.`;
        }
        return `✅ Agendado *${clientName}*${profLabel} — ${d}/${m} às ${timeMatch}.\n📞 ${clientPhone}`;
      }
      return `❌ Não consegui agendar ${clientName} em ${d}/${m} às ${timeMatch}.`;
    }
  }

  // ── VER AGENDA ────────────────────────────────────────────────────────────
  const hasAgenda = normalized.includes("agenda hoje") || normalized.includes("agenda amanha") ||
    normalized.includes("ver agenda") || normalized.includes("agenda do dia") ||
    (normalized.includes("agenda") && (normalized.includes("hoje") || normalized.includes("amanha") || extractDate(normalized)));

  if (hasAgenda) {
    const dateMatch = extractDate(normalized) ||
      (normalized.includes("hoje") ? `${currentYear}-${currentMonth}-${String(n.getDate()).padStart(2, "0")}` : null) ||
      (normalized.includes("amanha") ? (() => { const t = new Date(n); t.setDate(n.getDate() + 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; })() : null);

    if (dateMatch) {
      const scopeProfId = getViewProfId(callerProfile, targetProf);
      const daySchedule = await getDaySchedule(dateMatch, scopeProfId);
      const [, m, d] = dateMatch.split("-");
      return formatDaySchedule(daySchedule, scopeProfId, d, m);
    }
  }

  // ── AJUDA ─────────────────────────────────────────────────────────────────
  const hasHelp = normalized === "ajuda" || normalized === "help" || normalized === "comandos" ||
    normalized.includes("o que posso fazer") || normalized.includes("como usar");

  if (hasHelp) {
    const profCmds = isMultiProfessional()
      ? `\n*👥 Agenda de profissional:*\n"agenda da Ana hoje"\n"bloqueia o Pedro amanhã"\n`
      : "";
    const onlyAdmin = callerProfile.tipo === "admin";
    return `🛠️ *Comandos disponíveis*\n\n*📅 Ver agenda:*\n"agenda hoje"\n"agenda amanhã"\n"agenda 15/06"\n${profCmds}\n*🔒 Bloquear:*\n"bloqueia 15/06"\n"bloqueia 16h do dia 15/06"\n${onlyAdmin ? '"bloqueia tudo amanhã"\n' : ""}\n*🔓 Desbloquear:*\n"desbloqueia 15/06"\n"desbloqueia 16h do dia 15/06"\n${onlyAdmin ? `\n*👤 Agendar cliente:*\n"marca João dia 15/06 às 14h"\n\n*👥 Agendar vários:*\n"agenda massa"\n\n*❌ Cancelar:*\n"cancela 15/06 às 14h"\n\n*🔄 Reagendar:*\n"passa de 15/06 14h para 16/06 10h"\n\n*🗑️ Zerar agenda:*\n"zerar agenda"\n\n*🤝 Encerrar atendimento:*\n"encerrar João"` : ""}`;
  }

  // ── HORÁRIO DIFERENTE (somente admin) ────────────────────────────────────
  const hasDifferentHours = callerProfile.tipo === "admin" && (
    (normalized.includes("horario diferente") || normalized.includes("horario especial") ||
     normalized.includes("abre diferente") || normalized.includes("vai ser diferente")) &&
    (normalized.includes("hoje") || normalized.includes("amanha") || !!extractDate(normalized)));

  if (hasDifferentHours) {
    function extractMultipleDates(str) {
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dates = new Set();
      if (str.includes("depois de amanha")) { const t = new Date(n); t.setDate(n.getDate() + 2); dates.add(fmt(t)); }
      if (str.includes("amanha")) { const t = new Date(n); t.setDate(n.getDate() + 1); dates.add(fmt(t)); }
      if (str.includes("hoje")) dates.add(fmt(n));
      const period = extractPeriod(str);
      if (period) {
        const start = new Date(period.inicio + "T00:00:00");
        const end = new Date(period.fim + "T00:00:00");
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          if (!config.diasFechado.includes(d.getDay())) dates.add(fmt(d));
        }
        return [...dates];
      }
      const dateRegex = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g;
      let m;
      while ((m = dateRegex.exec(str)) !== null) {
        const dy = m[1].padStart(2, "0"), mo = m[2].padStart(2, "0"), y = m[3] || currentYear;
        if (+m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) dates.add(`${y}-${mo}-${dy}`);
      }
      if (dates.size > 0) return [...dates];
      const single = extractDate(str);
      return single ? [single] : [];
    }

    const dates = extractMultipleDates(normalized);
    if (!dates.length) return `❓ Qual dia vai ter horário diferente?\nEx: "Amanhã vai ser horário diferente"`;
    waitingForCustomHours.set(ADMIN_PHONE, dates);
    const labels = dates.map((date) => { const [, m, d] = date.split("-"); return `${d}/${m}`; }).join(", ");
    return dates.length === 1
      ? `🕐 Qual vai ser o horário do dia ${labels}?\n\nEx: "das 8h às 17h"`
      : `🕐 Qual vai ser o horário para esses dias: *${labels}*?\n\nEx: "das 8h às 17h"`;
  }

  // ── ENCERRAR HANDOFF (somente admin) ─────────────────────────────────────
  const encerrarMatch = text.match(/^encerrar\s+(.+)$/i);
  if (encerrarMatch && callerProfile.tipo === "admin") {
    const termo = encerrarMatch[1].trim();
    let clientPhone = null;
    if (/^\d+$/.test(termo)) {
      clientPhone = humanHandoff.has(termo) ? termo : null;
    } else {
      for (const [p, { name: nm }] of humanHandoff.entries()) {
        if (nm.toLowerCase().includes(termo.toLowerCase())) { clientPhone = p; break; }
      }
    }
    if (!clientPhone) return `❌ Nenhum atendimento ativo encontrado para "${termo}".`;
    humanHandoff.delete(clientPhone);
    await sendMessage(clientPhone, tr(clientPhone, "handoffEnd"));
    return `✅ Atendimento encerrado. Bot retomado para ${clientPhone}.`;
  }

  // ── ZERAR AGENDA (somente admin total) ───────────────────────────────────
  if (callerProfile.tipo === "admin") {
    if (normalized === "zerar agenda") return `⚠️ *Vai apagar todos os agendamentos do mês atual.*\n\nManda *confirmar reset* pra prosseguir.`;
    if (normalized === "zerar tudo") return `⚠️ *Vai apagar TODOS os agendamentos de todos os meses.*\n\nManda *confirmar tudo* pra prosseguir.`;
    if (normalized === "confirmar reset" || normalized === "confirmar tudo") {
      const scope = normalized === "confirmar tudo" ? "tudo" : "mes";
      try {
        const { apagados } = await resetSlots(scope);
        let msg = `✅ Agenda ${scope === "tudo" ? "completa" : "do mês"} zerada e recriada.\n`;
        if (!apagados.length) { msg += "Nenhum agendamento foi apagado."; }
        else {
          msg += `\n*Agendamentos apagados (${apagados.length}):*\n`;
          msg += apagados.map((a) => { const [, m, d] = a.data.split("-"); return `👤 ${a.nome} — ${d}/${m} às ${a.horario} — 📞 ${a.telefone}`; }).join("\n");
        }
        return msg;
      } catch (e) { return `❌ Erro ao zerar: ${e.message}`; }
    }
  }

  const pareceComando = hasBlock || hasUnblock || hasReschedule || hasCancel || hasAgenda;
  if (pareceComando) return `❓ Não entendi. Digite *ajuda* para ver os comandos disponíveis.`;

  return null;
}

// ── Processamento de mensagens acumuladas ────────────────────────────────────

async function processAccumulatedMessages(phone, name) {
  const messages = pendingMessages.get(phone) || [];
  pendingMessages.delete(phone);
  debounceTimers.delete(phone);
  if (!messages.length) return;

  if (!isValidName(name)) {
    const savedName = await getClientName(phone);
    if (savedName) name = savedName;
  }

  const combinedText = messages.join(" ");
  console.log(`Processando ${messages.length} mensagem(ns) de ${name} (${phone}): ${combinedText}`);

  const callerProfile = getCallerProfile(phone);

  // ── Admin / Profissional ──────────────────────────────────────────────────
  if (callerProfile.tipo !== "cliente") {
    const adminPhone = phone;

    if (waitingForClientPhone.has(adminPhone)) {
      const { data, horario, nome, profId } = waitingForClientPhone.get(adminPhone);
      const digits = combinedText.replace(/\D/g, "");
      const num = digits.length <= 11 && !digits.startsWith("55") ? "55" + digits : digits;
      if (num.length >= 10 && num.length <= 13) {
        waitingForClientPhone.delete(adminPhone);
        const updated = await updateClientPhone(data, horario, num, profId);
        const [, m, d] = data.split("-");
        await sendMessage(adminPhone, updated
          ? `✅ Número registrado para *${nome}* — ${d}/${m} às ${horario}.\n📞 ${num}`
          : `❌ Não encontrei o agendamento de ${nome} em ${d}/${m} às ${horario}.`);
        return;
      }
      await sendMessage(adminPhone, "Número inválido. Envia só os dígitos, ex: *21999991234*");
      return;
    }

    if (waitingForMassBooking.has(adminPhone)) {
      waitingForMassBooking.delete(adminPhone);
      const massResult = await processAdminCommand("agenda massa\n" + combinedText, callerProfile);
      await sendMessage(adminPhone, massResult || "❌ Não consegui processar. Tenta de novo.");
      return;
    }

    if (waitingForCustomHours.has(adminPhone)) {
      const dates = waitingForCustomHours.get(adminPhone);
      waitingForCustomHours.delete(adminPhone);
      const match = combinedText.match(/(\d{1,2})\s*h?\s*(?:às|as|ate|até|a)\s*(\d{1,2})\s*h?/i);
      if (!match) { await sendMessage(adminPhone, `❌ Não entendi. Manda assim: "das 8h às 17h"`); return; }
      const inicio = parseInt(match[1]);
      const fim = parseInt(match[2]);
      if (inicio >= fim || inicio < 5 || fim > 23) { await sendMessage(adminPhone, `❌ Horário inválido. Ex: "das 8h às 17h"`); return; }
      const lines = [];
      const scopeProfId = callerProfile.isProf ? callerProfile.prof.id : null;
      for (const date of dates) {
        const { warnings } = await setCustomHours(date, inicio, fim, scopeProfId);
        const [, m, d] = date.split("-");
        lines.push(`✅ ${d}/${m} — das ${inicio}h às ${fim}h`);
        lines.push(...warnings);
      }
      await sendMessage(adminPhone, `🕐 *Horário atualizado*\n\n${lines.join("\n")}`);
      return;
    }

    const commandResponse = await processAdminCommand(combinedText, callerProfile);
    if (commandResponse) {
      await sendMessage(adminPhone, commandResponse);
      return;
    }

    try {
      const adminName = callerProfile.prof?.nome || name;
      const adminResponse = await interpretAdminMessage(combinedText, adminName, adminPhone);
      await sendMessage(adminPhone, adminResponse);
    } catch (e) {
      await sendMessage(adminPhone, `Não entendi não 😅 Manda *ajuda* pra ver os comandos.`);
    }
    return;
  }

  // ── Cliente ───────────────────────────────────────────────────────────────

  if (waitingForNameToBook.has(phone)) {
    const trimmed = combinedText.trim();
    const words = trimmed.split(/\s+/).filter((w) => /^[a-záàãâéêíóôõúçA-Z]+$/i.test(w));
    const blockedWords = ["bom","boa","dia","tarde","noite","oi","ola","hey","opa","sim","nao","ok","ate","tchau","obrigado","obrigada","quero","preciso"];
    if (!words.some((w) => blockedWords.includes(w.toLowerCase())) && words.length >= 1 && words.length <= 4 && trimmed.length >= 3) {
      const nomeLimpo = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      const { data, horario, profId, servico } = waitingForNameToBook.get(phone);
      waitingForNameToBook.delete(phone);
      const booked = await bookSlot(data, horario, profId, servico, nomeLimpo, phone);
      if (!booked) {
        await sendMessage(phone, tr(phone, "slotTaken"));
      } else {
        const profNome = isMultiProfessional()
          ? (config.profissionais?.find((p) => p.id === profId)?.nome || null)
          : null;
        const confirmMsg = tr(phone, "bookingConfirm", nomeLimpo, horario, profNome);
        await sendMessage(phone, confirmMsg);
        const profLabel = profNome ? `\n👨 ${profNome}` : "";
        await notifyAdmin(`✅ *Novo agendamento*\n👤 ${nomeLimpo}\n📅 ${fmtDate(data)}\n🕐 ${horario}${profLabel}`);
        await notifyProfissional(profId, `📋 *Novo agendamento*\n👤 ${nomeLimpo}\n📅 ${fmtDate(data)} às ${horario}`);
      }
      return;
    }
    await sendMessage(phone, tr(phone, "invalidName"));
    return;
  }

  if (humanHandoff.has(phone)) return;

  // ── Seleção de profissional ───────────────────────────────────────────────
  if (waitingForProfissional.has(phone)) {
    const state = waitingForProfissional.get(phone);
    const { data, horario, servico, nomePendente, disponibilidade } = state;
    const norm = combinedText.toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, "");

    const profissionais = getProfissionais();
    let profEscolhido = profissionais.find((p) =>
      norm.includes(p.nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")),
    );

    // Aceita número ("1", "2", "primeiro", "segundo")
    if (!profEscolhido) {
      const numMap = { "1": 0, "primeiro": 0, "primeira": 0, "2": 1, "segundo": 1, "segunda": 1, "3": 2, "terceiro": 2, "terceira": 2 };
      for (const [key, idx] of Object.entries(numMap)) {
        if (norm.includes(key) && profissionais[idx]) { profEscolhido = profissionais[idx]; break; }
      }
    }

    if (!profEscolhido) {
      const nomes = profissionais.map((p) => `*${p.nome}*`).join(" ou ");
      await sendMessage(phone, `Não entendi. Escolhe: ${nomes}`);
      return;
    }

    // Verifica se ainda está disponível
    const slot = await getSlotInfo(data, horario, profEscolhido.id);
    if (!slot || slot.status !== "livre") {
      const profDisp = disponibilidade.find((p) => p.id === profEscolhido.id);
      if (profDisp?.proximo) {
        const [, pm, pd] = profDisp.proximo.data.split("-");
        waitingForProfissional.set(phone, { ...state, profEscolhido: profEscolhido.id, alternativa: profDisp.proximo });
        await sendMessage(phone, `${profEscolhido.nome} não está disponível neste horário. Próximo: *${pd}/${pm} às ${profDisp.proximo.horario}*. Pode ser?`);
      } else {
        waitingForProfissional.delete(phone);
        await sendMessage(phone, `${profEscolhido.nome} não tem horários disponíveis no momento.`);
      }
      return;
    }

    waitingForProfissional.delete(phone);

    const count = await countClientAppointmentsOnDay(phone, data);
    if (count >= config.maxAgendamentosPorDia) {
      await sendMessage(phone, tr(phone, "maxBookings"));
      return;
    }

    if (!nomePendente) {
      waitingForNameToBook.set(phone, { data, horario, profId: profEscolhido.id, servico });
      await sendMessage(phone, tr(phone, "waitingName"));
      return;
    }

    const booked = await bookSlot(data, horario, profEscolhido.id, servico, nomePendente, phone);
    if (!booked) {
      await sendMessage(phone, tr(phone, "slotTaken"));
    } else {
      const profNome = isMultiProfessional() ? profEscolhido.nome : null;
      await sendMessage(phone, tr(phone, "bookingConfirm", nomePendente, horario, profNome));
      await notifyAdmin(`✅ *Novo agendamento*\n👤 ${nomePendente}\n📅 ${fmtDate(data)}\n🕐 ${horario}${profNome ? `\n👨 ${profNome}` : ""}`);
      await notifyProfissional(profEscolhido.id, `📋 *Novo agendamento*\n👤 ${nomePendente}\n📅 ${fmtDate(data)} às ${horario}`);
    }
    return;
  }

  if (waitingForCancelReason.has(phone)) {
    const { data, horario } = waitingForCancelReason.get(phone);
    const motivo = combinedText.trim();
    waitingForCancelReason.delete(phone);
    const cancelled = await cancelSlot(data, horario, phone);
    if (cancelled === "bloqueado_tempo") {
      await sendMessage(phone, tr(phone, "cancelTooLate"));
      await notifyAdmin(`⚠️ *Tentativa de cancelamento tardio*\n👤 ${name}\n📞 ${phone}\n📅 ${fmtDate(data)} às ${horario}\n📝 ${motivo}`);
    } else if (!cancelled) {
      await sendMessage(phone, tr(phone, "slotNotFound"));
    } else {
      await sendMessage(phone, tr(phone, "cancelSuccess"));
      await notifyAdmin(`❎ *Cancelamento*\n👤 ${name}\n📅 ${fmtDate(data)}\n🕐 ${horario}\n📝 ${motivo}`);
    }
    return;
  }

  // Comandos rápidos do cliente
  const norm = combinedText.toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const isHelp = norm === "ajuda" || norm === "help" || norm.includes("como funciona") || norm.includes("o que voce faz");
  if (isHelp) { await sendMessage(phone, tr(phone, "help")); return; }

  const alias = config.adminAlias;
  const wantsAdmin = norm === alias || norm.includes(`falar com ${alias}`) ||
    norm.includes(`quero o ${alias}`) || norm.includes("atendimento humano") || norm.includes("falar com atendente");
  if (wantsAdmin) {
    humanHandoff.set(phone, { name });
    await sendMessage(phone, tr(phone, "barberNotified"));
    await notifyAdmin(`📞 *${name} quer falar diretamente*\n📞 ${phone}\n\nResponda direto. Quando terminar: *encerrar ${phone}*`);
    return;
  }

  // ── IA principal ─────────────────────────────────────────────────────────
  try {
    const slots = await getAvailableSlots();
    const result = await interpretMessage(combinedText, slots, name, phone);
    console.log("Intenção identificada:", result);

    if (result.acao === "agendar" && result.data && result.horario) {
      const count = await countClientAppointmentsOnDay(phone, result.data);
      if (count >= config.maxAgendamentosPorDia) {
        await sendMessage(phone, tr(phone, "maxBookings"));
        return;
      }

      const nomeFinal = result.nome_informado || (isValidName(name) ? name : null);

      // Seleção de profissional
      if (isMultiProfessional() && config.distribuicao !== "auto") {
        // Verifica se o cliente já indicou um profissional (via IA)
        const prefProfId = result.profissional;
        const prefProf = prefProfId ? config.profissionais?.find((p) => p.id === prefProfId) : null;

        const disponibilidade = await getProfissionaisDisponibilidade(result.data, result.horario);
        const disponiveis = disponibilidade.filter((p) => p.disponivelNoHorario);

        if (prefProf) {
          const profDisp = disponibilidade.find((p) => p.id === prefProf.id);
          if (!profDisp?.disponivelNoHorario) {
            // Profissional preferido não disponível — mostra alternativas
            const selMsg = await sendProfissionalSelection(phone, result.data, result.horario, disponibilidade);
            waitingForProfissional.set(phone, { data: result.data, horario: result.horario, servico: result.servicos?.[0] || null, nomePendente: nomeFinal, disponibilidade });
            await sendMessage(phone, `${prefProf.nome} não está disponível neste horário.\n\n${selMsg}`);
            return;
          }
          // Profissional preferido disponível — prossegue direto
          if (!nomeFinal) {
            waitingForNameToBook.set(phone, { data: result.data, horario: result.horario, profId: prefProf.id, servico: result.servicos?.[0] || null });
            await sendMessage(phone, tr(phone, "waitingName"));
          } else {
            const booked = await bookSlot(result.data, result.horario, prefProf.id, result.servicos?.[0] || null, nomeFinal, phone);
            if (!booked) {
              await sendMessage(phone, tr(phone, "slotTaken"));
            } else {
              const profNome = isMultiProfessional() ? prefProf.nome : null;
              const lang = clientLanguages.get(phone) || "pt";
              const resposta = lang !== "pt" ? `${result.resposta}\n\n${tr(phone, "langNote")}` : result.resposta;
              await sendMessage(phone, resposta);
              await notifyAdmin(`✅ *Novo agendamento*\n👤 ${nomeFinal}\n📅 ${fmtDate(result.data)}\n🕐 ${result.horario}\n👨 ${prefProf.nome}`);
              await notifyProfissional(prefProf.id, `📋 *Novo agendamento*\n👤 ${nomeFinal}\n📅 ${fmtDate(result.data)} às ${result.horario}`);
            }
          }
          return;
        }

        if (!disponiveis.length) {
          await sendMessage(phone, result.resposta || tr(phone, "slotTaken"));
          return;
        }

        // Nenhum profissional preferido — pede seleção
        const selMsg = await sendProfissionalSelection(phone, result.data, result.horario, disponibilidade);
        waitingForProfissional.set(phone, { data: result.data, horario: result.horario, servico: result.servicos?.[0] || null, nomePendente: nomeFinal, disponibilidade });
        await sendMessage(phone, selMsg);
        return;
      }

      // Modo auto ou single-prof
      const profissionais = getProfissionais();
      let profEscolhido = null;
      if (result.profissional) {
        profEscolhido = profissionais.find((p) => p.id === result.profissional) || null;
      }
      if (!profEscolhido) {
        for (const prof of profissionais) {
          const slot = await getSlotInfo(result.data, result.horario, prof.id);
          if (slot?.status === "livre") { profEscolhido = prof; break; }
        }
      }
      if (!profEscolhido) { await sendMessage(phone, tr(phone, "slotTaken")); return; }

      if (!nomeFinal) {
        waitingForNameToBook.set(phone, { data: result.data, horario: result.horario, profId: profEscolhido.id, servico: result.servicos?.[0] || null });
        await sendMessage(phone, tr(phone, "waitingName"));
      } else {
        const booked = await bookSlot(result.data, result.horario, profEscolhido.id, result.servicos?.[0] || null, nomeFinal, phone);
        if (!booked) {
          await sendMessage(phone, tr(phone, "slotTaken"));
        } else {
          const profNome = isMultiProfessional() ? profEscolhido.nome : null;
          const lang = clientLanguages.get(phone) || "pt";
          const resposta = lang !== "pt" ? `${result.resposta}\n\n${tr(phone, "langNote")}` : result.resposta;
          await sendMessage(phone, resposta);
          const srv = result.servicos?.length ? `\n📋 ${result.servicos.join(", ")}` : "";
          const pfx = profNome ? `\n👨 ${profNome}` : "";
          await notifyAdmin(`✅ *Novo agendamento*\n👤 ${nomeFinal}\n📅 ${fmtDate(result.data)}\n🕐 ${result.horario}${srv}${pfx}`);
          if (profNome) await notifyProfissional(profEscolhido.id, `📋 *Novo agendamento*\n👤 ${nomeFinal}\n📅 ${fmtDate(result.data)} às ${result.horario}`);
        }
      }

    } else if (result.acao === "cancelar" && result.data && result.horario) {
      const hoje = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
      if (result.data === hoje) {
        waitingForCancelReason.set(phone, { data: result.data, horario: result.horario });
        await sendMessage(phone, tr(phone, "cancelReasonPrompt"));
      } else {
        const cancelled = await cancelSlot(result.data, result.horario, phone);
        if (cancelled === "bloqueado_tempo") {
          await sendMessage(phone, tr(phone, "cancelTooLate"));
        } else if (!cancelled) {
          await sendMessage(phone, tr(phone, "slotNotFound"));
        } else {
          await sendMessage(phone, result.resposta);
          await notifyAdmin(`❎ *Cancelamento*\n👤 ${name}\n📅 ${fmtDate(result.data)}\n🕐 ${result.horario}`);
        }
      }

    } else if (result.acao === "confirmar_presenca") {
      await sendMessage(phone, result.resposta);
      const timeInfo = result.horario ? ` às ${result.horario}` : "";
      const dateInfo = result.data ? ` — ${fmtDate(result.data)}` : "";
      await notifyAdmin(`✅ *Presença confirmada*\n👤 ${name}${dateInfo}${timeInfo}`);

    } else if (result.acao === "reagendar" && result.data && result.horario && result.data_nova && result.horario_novo) {
      const rescheduled = await rescheduleSlot(result.data, result.horario, result.data_nova, result.horario_novo, name, phone);
      if (rescheduled === "bloqueado_tempo") {
        await sendMessage(phone, tr(phone, "rescheduleTooLate"));
        await notifyAdmin(`⚠️ *Reagendamento tardio*\n👤 ${name}\n📞 ${phone}`);
      } else if (rescheduled === "rollback_failed") {
        await sendMessage(phone, tr(phone, "rollbackFailed"));
        await notifyAdmin(`⚠️ *Erro no reagendamento*\n👤 ${name}\n📞 ${phone}\nVerificar manualmente.`);
      } else if (!rescheduled) {
        await sendMessage(phone, tr(phone, "rescheduleConflict"));
      } else {
        await sendMessage(phone, result.resposta);
        await notifyAdmin(`🔄 *Reagendamento*\n👤 ${name}\n📅 ${fmtDate(result.data)} às ${result.horario}\n➡️ ${fmtDate(result.data_nova)} às ${result.horario_novo}`);
      }

    } else if (result.acao === "listar") {
      const nowDt = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
      let targetDates = Array.isArray(result.datas) && result.datas.length ? result.datas : result.data ? [result.data] : null;

      if (!targetDates) {
        const daysUntilSunday = (7 - nowDt.getDay()) % 7 || 7;
        targetDates = [];
        const cursor = new Date(nowDt); cursor.setDate(nowDt.getDate() + 1);
        const nextSunday = new Date(nowDt); nextSunday.setDate(nowDt.getDate() + daysUntilSunday);
        while (cursor <= nextSunday) {
          if (!config.diasFechado.includes(cursor.getDay())) {
            targetDates.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`);
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      }

      const parts = [];
      for (const data of targetDates) {
        const rawSlots = await getDaySchedule(data);
        const daySlots = aggregateByHorario(rawSlots);
        if (!daySlots.length) continue;
        const [year, month, day] = data.split("-").map(Number);
        const [, m, d] = data.split("-");
        const lines = daySlots
          .filter((s) => { const [h, min] = s.horario.split(":").map(Number); return new Date(year, month - 1, day, h, min) > nowDt; })
          .map((s) => {
            if (s.status === "livre") return `🟢 ${s.horario} — ${tr(phone, "livre")}`;
            if (s.status === "bloqueado") return `⚪ ${s.horario} — ${tr(phone, "bloqueado")}`;
            return `🔴 ${s.horario} — ${tr(phone, "ocupado")}`;
          });
        if (!lines.length) continue;
        parts.push(`${tr(phone, "agendaHeader", d, m)}\n\n${lines.join("\n")}`);
      }

      if (!parts.length) {
        await sendMessage(phone, result.resposta || tr(phone, "noSlots"));
      } else {
        const isWeekMode = !result.data && !(Array.isArray(result.datas) && result.datas.length);
        const intro = !isWeekMode && result.resposta ? `${result.resposta}\n\n` : "";
        const msg = `${intro}${parts.join("\n\n")}`;
        await sendMessage(phone, msg);
        addToHistory(phone, "assistant", `[Agenda exibida para: ${targetDates.join(", ")}]\n${msg}`);
      }

    } else {
      await sendMessage(phone, result.resposta);
    }
  } catch (error) {
    console.error("Erro ao processar mensagem:", error.message);
    await sendMessage(phone, tr(phone, "generalError"));
    await notifyAdmin(`⚠️ *Atenção manual*\n👤 ${name}\n📞 ${phone}`);
  }
}

// ── Incoming message handler ─────────────────────────────────────────────────

async function handleIncomingMessage(msg) {
  const phone = jidToPhone(msg.key.remoteJid);
  const name = msg.pushName || "";
  let text = null;

  if (msg.message?.conversation) {
    text = msg.message.conversation;
    console.log(`Texto de ${name} (${phone}): ${text}`);
  } else if (msg.message?.extendedTextMessage?.text) {
    text = msg.message.extendedTextMessage.text;
    console.log(`Texto de ${name} (${phone}): ${text}`);
  } else if (msg.message?.audioMessage) {
    console.log(`Áudio recebido de ${name} (${phone}), transcrevendo...`);
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      text = await transcribeAudio(buffer);
      console.log(`Transcrição: ${text}`);
    } catch (error) {
      console.error("Erro ao transcrever áudio:", error.message);
      await sendMessage(phone, "Não consegui entender o áudio. Digita pf? 😅");
      return;
    }
  }

  if (!text) return;

  if (!pendingMessages.has(phone)) pendingMessages.set(phone, []);
  pendingMessages.get(phone).push(text);
  if (debounceTimers.has(phone)) clearTimeout(debounceTimers.get(phone));

  const callerProfile = getCallerProfile(phone);
  const debounceTime = callerProfile.tipo !== "cliente" ? 3000 : 20 * 1000;
  const timer = setTimeout(() => processAccumulatedMessages(phone, name), debounceTime);
  debounceTimers.set(phone, timer);
}

// ── API ──────────────────────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  res.json({
    nome: config.nome,
    botName: config.botName,
    subtitulo: config.subtitulo,
    corPrimaria: config.corPrimaria,
    logo: config.logo,
    servicos: config.servicos,
    expediente: config.expediente,
    pagamento: config.pagamento,
    telefoneAdmin: config.telefoneAdmin,
    profissionais: (config.profissionais || []).map((p) => ({ id: p.id, nome: p.nome })),
    distribuicao: config.distribuicao || "auto",
  });
});

app.post("/api/book", async (req, res) => {
  const { date, horario, nome, telefone, profissional: profIdReq, servico } = req.body;
  if (!date || !horario || !nome || !telefone) {
    return res.status(400).json({ error: "Preencha todos os campos." });
  }

  const digits = String(telefone).replace(/\D/g, "");
  let phone = digits;
  if (digits.startsWith("595") && digits.length === 12) phone = digits;
  else if (digits.startsWith("09") && digits.length === 10) phone = "595" + digits.slice(1);
  else if (digits.startsWith("9") && digits.length === 9) phone = "595" + digits;
  else if (digits.startsWith("55") && digits.length >= 12) phone = digits;
  else if (digits.length === 11) phone = "55" + digits;
  else if (digits.length === 10) phone = "55" + digits;
  if (phone.length < 11 || phone.length > 13) return res.status(400).json({ error: "Número de WhatsApp inválido." });

  const profissionais = getProfissionais();
  let profId = profIdReq && profissionais.find((p) => p.id === profIdReq)?.id;
  if (!profId) {
    // Primeiro disponível
    for (const prof of profissionais) {
      const s = await getSlotInfo(date, horario, prof.id);
      if (s?.status === "livre") { profId = prof.id; break; }
    }
  }
  if (!profId) return res.status(409).json({ error: "Nenhum profissional disponível neste horário." });

  const slot = await getSlotInfo(date, horario, profId);
  if (!slot || slot.status !== "livre") return res.status(409).json({ error: "Esse horário acabou de ser ocupado. Escolha outro." });

  const already = await countClientAppointmentsOnDay(phone, date);
  if (already > 0) return res.status(409).json({ error: "Você já tem um agendamento neste dia." });

  const n = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = horario.split(":").map(Number);
  const slotTime = new Date(y, m - 1, d, h, min);
  const diffMin = (slotTime - n) / (1000 * 60);
  const [, mm, dd] = date.split("-");

  const booked = await bookSlot(date, horario, profId, servico || null, nome, phone);
  if (!booked) return res.status(409).json({ error: "Esse horário acabou de ser ocupado. Escolha outro." });

  const profNome = isMultiProfessional() ? (config.profissionais?.find((p) => p.id === profId)?.nome || "") : "";
  const profLabel = profNome ? `\n👨 ${profNome}` : "";

  await notifyAdmin(diffMin < config.confirmarSeLessDe
    ? `⚡ *Agendamento em cima da hora (site)*\n👤 ${nome}\n📞 ${phone}\n📅 ${dd}/${mm} às ${horario}${profLabel}`
    : `✅ *Novo agendamento (site)*\n👤 ${nome}\n📞 ${phone}\n📅 ${dd}/${mm} às ${horario}${profLabel}`,
  );
  if (profNome) await notifyProfissional(profId, `📋 *Novo agendamento (site)*\n👤 ${nome}\n📅 ${dd}/${mm} às ${horario}`);

  addToHistory(phone, "user", `quero marcar ${dd}/${mm} às ${horario}`);
  addToHistory(phone, "assistant", `Valeu, ${nome}! Horário confirmado para ${dd}/${mm} às ${horario}.`);

  await sendMessage(phone, `Valeu, ${nome}! ✅\nHorário confirmado para *${dd}/${mm} às ${horario}*${profNome ? ` com *${profNome}*` : ""} em ${config.nome}.\nVocê receberá um lembrete antes do horário. Até lá!`);

  return res.json({ ok: true, tipo: "confirmado" });
});

app.get("/api/slots", async (req, res) => {
  const { view = "dia", date, profissional: profIdReq } = req.query;
  const profId = profIdReq && config.profissionais?.find((p) => p.id === profIdReq) ? profIdReq : null;
  const PAD = (n) => String(n).padStart(2, "0");
  const FMT = (d) => `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
  const n = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));

  let dates = [];
  if (view === "dia") {
    const d = date ? new Date(date + "T12:00:00") : n;
    if (!config.diasFechado.includes(d.getDay())) dates = [FMT(d)];
  } else if (view === "semana") {
    const cursor = new Date(n);
    while (dates.length < 7) {
      if (!config.diasFechado.includes(cursor.getDay())) dates.push(FMT(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (view === "mes" || view === "proximo") {
    const offset = view === "proximo" ? 1 : 0;
    const first = new Date(n.getFullYear(), n.getMonth() + offset, 1);
    const last = new Date(n.getFullYear(), n.getMonth() + offset + 1, 0);
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      if (!config.diasFechado.includes(d.getDay())) dates.push(FMT(new Date(d)));
    }
  }

  try {
    const data = await getSlotsForDates(dates, profId);
    if (view === "semana") {
      const nowMinutes = n.getHours() * 60 + n.getMinutes();
      const todayStr = FMT(n);
      data.dates = data.dates.filter((d) => {
        if (d.date !== todayStr) return true;
        return d.slots.some((s) => { const [h, m] = s.horario.split(":").map(Number); return s.status === "livre" && (h * 60 + m) > nowMinutes; });
      }).slice(0, 6);
    }
    res.json(data);
  } catch (e) {
    console.error("Erro /api/slots:", e.message);
    res.status(500).json({ error: "Erro ao buscar agenda" });
  }
});

// ── Crons ────────────────────────────────────────────────────────────────────

const CRONS_ENABLED = process.env.CRONS_ENABLED !== "false";

if (CRONS_ENABLED) {
  schedule.schedule("0 1 * * *", () => {
    clearAllHistories();
    waitingForNameToBook.clear();
    waitingForProfissional.clear();
    waitingForClientPhone.clear();
    waitingForMassBooking.clear();
    waitingForCustomHours.clear();
    console.log("Histórico limpo!");
  }, { timezone: TZ });

  schedule.schedule("0 10 * * *", () => sendReminders(24), { timezone: TZ });
  schedule.schedule("0 * * * *", () => sendReminders(1), { timezone: TZ });
  schedule.schedule("0 12 * * *", () => sendUnconfirmedNotifications("24h", 120), { timezone: TZ });
  schedule.schedule("20 * * * *", () => sendUnconfirmedNotifications("1h", 20), { timezone: TZ });
  schedule.schedule("0 12 * * 0", () => sendWeeklySummary(), { timezone: TZ });
  schedule.schedule("0 0 * * *", () => {
    generateWeeklySlots()
      .then(() => console.log("Horários verificados com sucesso!"))
      .catch((err) => console.error("Erro ao gerar horários:", err.message));
  }, { timezone: TZ });

  console.log("Crons ativos.");
} else {
  console.log("Crons desativados (CRONS_ENABLED=false).");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  generateWeeklySlots()
    .then(() => console.log("Horários verificados no startup!"))
    .catch((err) => console.error("Erro ao gerar horários no startup:", err.message));
});

console.log("Iniciando conexão com WhatsApp via Baileys...");
initBaileys(handleIncomingMessage).catch((err) => {
  console.error("Erro ao iniciar Baileys:", err.message);
  process.exit(1);
});
