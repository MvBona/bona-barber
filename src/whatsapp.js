const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const AUTH_FOLDER = process.env.BAILEYS_AUTH_FOLDER || "auth_info_baileys";
const JID_CACHE_FILE = path.join(AUTH_FOLDER, "jid_cache.json");

const silentLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: (...args) => console.error("[Baileys erro]", ...args),
  fatal: (...args) => console.error("[Baileys fatal]", ...args),
  child: function () { return this; },
};

const lastMessageTime = new Map();
const jidCache = new Map();        // phone → jid
const reverseJidCache = new Map(); // jid → phone
let sock = null;

// Carrega mapeamentos salvos na sessão anterior
function loadJidCache() {
  // Carrega do arquivo de sessão anterior
  try {
    const data = JSON.parse(fs.readFileSync(JID_CACHE_FILE, "utf8"));
    for (const [phone, jid] of Object.entries(data)) {
      jidCache.set(phone, jid);
      reverseJidCache.set(jid, phone);
    }
    if (jidCache.size > 0) console.log(`JID cache carregado: ${jidCache.size} entrada(s)`);
  } catch {}

  // Aplica mapeamento explícito do .env (tem precedência sobre o arquivo)
  const envPhone = process.env.BARBERSHOP_PHONE;
  const envJid   = process.env.BARBERSHOP_JID;
  if (envPhone && envJid) {
    jidCache.set(envPhone, envJid);
    reverseJidCache.set(envJid, envPhone);
    console.log(`Barbeiro mapeado via .env: ${envPhone} → ${envJid}`);
  }
}

function saveJidCache() {
  try {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    fs.writeFileSync(JID_CACHE_FILE, JSON.stringify(Object.fromEntries(jidCache)));
  } catch {}
}

loadJidCache();

function jidToPhone(jid) {
  if (!jid) return jid;
  if (reverseJidCache.has(jid)) return reverseJidCache.get(jid);
  if (jid.includes("@s.whatsapp.net")) return jid.replace("@s.whatsapp.net", "");
  return jid; // LID não resolvido — retorna como está
}

async function phoneToJid(phone) {
  if (jidCache.has(phone)) return jidCache.get(phone);

  try {
    const results = await sock.onWhatsApp(phone);
    if (results && results.length > 0 && results[0].exists) {
      const jid = results[0].jid;
      jidCache.set(phone, jid);
      reverseJidCache.set(jid, phone);
      saveJidCache();
      console.log(`JID resolvido: ${phone} → ${jid}`);
      return jid;
    }
  } catch (e) {}

  // Fallback: formato padrão
  const jid = `${phone}@s.whatsapp.net`;
  jidCache.set(phone, jid);
  reverseJidCache.set(jid, phone);
  return jid;
}

async function initBaileys(onMessage) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    logger: silentLogger,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\n📱 Escaneie o QR Code com o WhatsApp (Dispositivos vinculados):\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        console.error("⚠️  Sessão encerrada (logout). Apague auth_info_baileys/ e reinicie.");
      } else {
        console.log(`🔄 WhatsApp desconectado (código: ${codigo}), reconectando...`);
        await initBaileys(onMessage);
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado!");
      // Resolve o JID do barbeiro ANTES de começar a processar mensagens
      const barberPhone = process.env.BARBERSHOP_PHONE;
      if (barberPhone && !jidCache.has(barberPhone)) {
        await phoneToJid(barberPhone).catch(() => {});
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      try {
        await onMessage(msg);
      } catch (err) {
        console.error("Erro ao processar mensagem:", err.message);
      }
    }
  });
}

async function sendMessage(phone, message) {
  if (!sock) throw new Error("WhatsApp não inicializado");

  const last = lastMessageTime.get(phone);
  if (last) {
    const wait = 2500 - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  lastMessageTime.set(phone, Date.now());

  const jid = phone.includes("@") ? phone : await phoneToJid(phone);
  await sock.sendMessage(jid, { text: message });
  console.log("Mensagem enviada para", phone);
}

module.exports = { initBaileys, sendMessage, downloadMediaMessage, jidToPhone };
