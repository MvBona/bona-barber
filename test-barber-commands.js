require("dotenv").config();

const WEBHOOK_URL = "http://localhost:3000/webhook";
const BARBER = { phone: process.env.BARBERSHOP_PHONE, name: "Barbeiro" };

async function sendMsg(phone, name, message, delay = 0) {
  if (delay) await new Promise((r) => setTimeout(r, delay));

  fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromMe: false,
      phone,
      senderName: name,
      text: { message },
    }),
  }).then((res) => console.log(`[${name}] "${message}" → ${res.status}`));

  await new Promise((r) => setTimeout(r, 200));
}

async function test() {
  console.log("🚀 Iniciando teste de comandos do barbeiro...\n");

  // ─── 1. Ver ajuda ───
  await sendMsg(BARBER.phone, BARBER.name, "ajuda");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 2. Ver agenda hoje ───
  await sendMsg(BARBER.phone, BARBER.name, "agenda hoje");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 3. Ver agenda 15/06 ───
  await sendMsg(BARBER.phone, BARBER.name, "agenda 15/06");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 4. Bloquear horário específico ───
  await sendMsg(BARBER.phone, BARBER.name, "bloqueia 17h do dia 15/06");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 5. Ver agenda 15/06 após bloqueio ───
  await sendMsg(BARBER.phone, BARBER.name, "agenda 15/06");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 6. Desbloquear horário ───
  await sendMsg(BARBER.phone, BARBER.name, "desbloqueia 17h do dia 15/06");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 7. Agendar cliente ───
  await sendMsg(BARBER.phone, BARBER.name, "marca Rafael dia 15/06 às 17h");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 8. Reagendar cliente ───
  await sendMsg(
    BARBER.phone,
    BARBER.name,
    "passa Rafael de 15/06 17h para 15/06 18h",
  );

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 9. Tentar reagendar para horário ocupado ───
  await sendMsg(
    BARBER.phone,
    BARBER.name,
    "passa Rafael de 15/06 18h para 15/06 19h",
  );
  // 19h já tem Lucas Pereira

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 10. Cancelar horário com notificação ───
  await sendMsg(BARBER.phone, BARBER.name, "cancela 15/06 às 18h");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 11. Comando não reconhecido ───
  await sendMsg(BARBER.phone, BARBER.name, "bloqueia isso ai");

  await new Promise((r) => setTimeout(r, 35000));

  // ─── 12. Cliente pedindo ajuda ───
  await sendMsg("5545991110099", "Cliente Novo", "ajuda");

  console.log("\n✅ Teste concluído!");
}

test().catch(console.error);
