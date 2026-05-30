require("dotenv").config();

const WEBHOOK_URL = "http://localhost:3000/webhook";

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

async function runClient(clientFn) {
  try {
    await clientFn();
  } catch (e) {
    console.error("Erro no cliente:", e.message);
  }
}

async function test() {
  console.log("🚀 Iniciando stress test 2 — reagendamentos para 15/06...\n");

  // ─── BARBEIRO bloqueia 20h do dia 15 ───
  runClient(async () => {
    await sendMsg(
      process.env.BARBERSHOP_PHONE,
      "Barbeiro",
      "bloqueia o horario das 20h do dia 15/06",
      500,
    );
  });

  // ─── FERNANDA — reagenda de 04/06 15h para 15/06 ───
  runClient(async () => {
    await sendMsg(
      "5545991110004",
      "Fernanda Costa",
      "oi, preciso remarcar meu horário",
      1000,
    );
    await sendMsg(
      "5545991110004",
      "Fernanda Costa",
      "tô agendada pra quinta passada às 15h",
      1300,
    );
    await sendMsg(
      "5545991110004",
      "Fernanda Costa",
      "quero ir no dia 15 no mesmo horário",
      1600,
    );
  });

  // ─── MARIANA — reagenda formal ───
  runClient(async () => {
    await sendMsg(
      "5545991110006",
      "Mariana Souza",
      "Olá! Preciso reagendar meu horário das 16h do dia 04/06 para o dia 15/06 às 16h por favor",
      1500,
    );
  });

  // ─── JULIANA — reagenda 19h, tenta manter 20h mas está bloqueado ───
  runClient(async () => {
    await sendMsg(
      "5545991110008",
      "Juliana Ferreira",
      "oi quero mudar meus horários pro dia 15",
      2000,
    );
    await sendMsg(
      "5545991110008",
      "Juliana Ferreira",
      "tenho 19h e 20h no dia 4",
      2300,
    );
    await sendMsg(
      "5545991110008",
      "Juliana Ferreira",
      "quero os mesmos horários no 15",
      2600,
    );
  });

  // ─── JOÃO — reagenda direto ───
  runClient(async () => {
    await sendMsg(
      "5545991110001",
      "João Silva",
      "preciso mudar meu horário",
      2500,
    );
    await sendMsg(
      "5545991110001",
      "João Silva",
      "estava marcado dia 12 às 10h",
      2800,
    );
    await sendMsg(
      "5545991110001",
      "João Silva",
      "quero ir no dia 15 de junho às 10h",
      3100,
    );
  });

  // ─── CARLOS — reagenda com linguagem casual ───
  runClient(async () => {
    await sendMsg(
      "5545991110003",
      "Carlos Mendes",
      "salve, muda meu horário das 13h do dia 12 pro dia 15 às 13h",
      3000,
    );
  });

  // ─── BRUNO — reagenda ───
  runClient(async () => {
    await sendMsg("5545991110009", "Bruno Castro", "opa, quero remarcar", 3500);
    await sendMsg(
      "5545991110009",
      "Bruno Castro",
      "tô marcado no dia 4 às 14h",
      3800,
    );
    await sendMsg(
      "5545991110009",
      "Bruno Castro",
      "muda pro 15/06 às 14h",
      4100,
    );
  });

  // ─── PEDRO — cancelou antes, agora quer marcar de novo ───
  runClient(async () => {
    await sendMsg(
      "5545991110005",
      "Pedro Alves",
      "ei, quero marcar de novo",
      4000,
    );
    await sendMsg(
      "5545991110005",
      "Pedro Alves",
      "pode ser dia 15 às 11h?",
      4300,
    );
  });

  // ─── RAFAEL — não conseguiu marcar antes, tenta agora ───
  runClient(async () => {
    await sendMsg(
      "5545991110007",
      "Rafael Nunes",
      "opa, quero marcar dois horários no dia 15",
      4500,
    );
    await sendMsg("5545991110007", "Rafael Nunes", "17h e 18h", 4800);
  });

  // ─── NOVO CLIENTE — Lucas, agenda direto ───
  runClient(async () => {
    await sendMsg(
      "5545991110011",
      "Lucas Pereira",
      "bom dia! tem horário no dia 15/06 às 19h?",
      5000,
    );
  });

  console.log("\n⏳ Aguardando ~40s para o debounce processar tudo...\n");
}

test().catch(console.error);
