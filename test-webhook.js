require("dotenv").config();

const WEBHOOK_URL = "http://localhost:3000/webhook";
const BARBER = { phone: process.env.BARBERSHOP_PHONE, name: "Barbeiro" };

async function sendMsg(message, phone = BARBER.phone, name = BARBER.name) {
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

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function test() {
  console.log("🚀 Reorganizando agenda...\n");

  // ─── Desbloqueia 15/06 20h ───
  await sendMsg("desbloqueia 20h do dia 15/06");
  await wait(5000);

  // ─── Bloqueia 15/06 10h ───
  await sendMsg("bloqueia 10h do dia 15/06");
  await wait(5000);

  // ─── Reagenda Fernanda Costa de 01/06 11h para 10/06 14h ───
  await sendMsg("passa Fernanda Costa de 01/06 11h para 10/06 14h");
  await wait(5000);

  // ─── Reagenda Cliente Teste de 02/06 11h para 11/06 16h ───
  await sendMsg("passa Cliente Teste de 02/06 11h para 11/06 16h");
  await wait(5000);

  // ─── Reagenda Fernanda Costa de 04/06 15h para 12/06 15h ───
  await sendMsg("passa Fernanda Costa de 04/06 15h para 12/06 15h");
  await wait(5000);

  // ─── Reagenda Juliana Ferreira de 04/06 19h para 13/06 17h ───
  await sendMsg("passa Juliana Ferreira de 04/06 19h para 13/06 17h");
  await wait(5000);

  // ─── Reagenda Juliana Ferreira de 04/06 20h para 16/06 19h ───
  await sendMsg("passa Juliana Ferreira de 04/06 20h para 16/06 19h");
  await wait(5000);

  // ─── Reagenda Pedro Alves de 15/06 11h para 10/06 11h ───
  await sendMsg("passa Pedro Alves de 15/06 11h para 10/06 11h");
  await wait(5000);

  // ─── Reagenda Carlos Mendes de 15/06 13h para 13/06 13h ───
  await sendMsg("passa Carlos Mendes de 15/06 13h para 13/06 13h");
  await wait(5000);

  // ─── Reagenda Lucas Pereira de 15/06 19h para 12/06 19h ───
  await sendMsg("passa Lucas Pereira de 15/06 19h para 12/06 19h");
  await wait(5000);

  // ─── Reagenda Barbeiro de 11/06 10h para 15/06 20h ───
  await sendMsg("passa Barbeiro de 11/06 10h para 15/06 20h");
  await wait(5000);

  console.log("\n✅ Reorganização concluída! Verifique o Sheets.");
}

test().catch(console.error);
