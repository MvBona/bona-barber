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

  await new Promise((r) => setTimeout(r, 300));
}

async function runClient(clientFn) {
  try {
    await clientFn();
  } catch (e) {
    console.error("Erro no cliente:", e.message);
  }
}

async function test() {
  console.log("🚀 Iniciando teste de stress...\n");

  // ─── CLIENTE 1 — João, direto ao ponto ───
  runClient(async () => {
    await sendMsg(
      "5545991110001",
      "João Silva",
      "Oi, quero marcar pra quinta dia 12",
    );
    await sendMsg("5545991110001", "João Silva", "pode ser as 10h?", 2000);
  });

  // ─── CLIENTE 2 — Ana, bem informal ───
  runClient(async () => {
    await sendMsg("5545991110002", "Ana Lima", "oii", 500);
    await sendMsg("5545991110002", "Ana Lima", "vc atende quinta?", 800);
    await sendMsg("5545991110002", "Ana Lima", "quero ir la cortar", 1100);
  });

  // ─── CLIENTE 3 — Carlos, manda tudo de uma vez ───
  runClient(async () => {
    await sendMsg(
      "5545991110003",
      "Carlos Mendes",
      "Bom dia! Gostaria de agendar um horário para quinta-feira dia 12/06 às 13h se possível",
      1000,
    );
  });

  // ─── CLIENTE 4 — Fernanda, indecisa ───
  runClient(async () => {
    await sendMsg("5545991110004", "Fernanda Costa", "oi tudo bem", 1500);
    await sendMsg(
      "5545991110004",
      "Fernanda Costa",
      "quais horarios tem na quinta",
      1800,
    );
    await sendMsg("5545991110004", "Fernanda Costa", "pode ser as 14h", 35000); // após debounce
    await sendMsg(
      "5545991110004",
      "Fernanda Costa",
      "na verdade muda pra 15h",
      70000,
    ); // reagenda
  });

  // ─── CLIENTE 5 — Pedro, agenda e cancela ───
  runClient(async () => {
    await sendMsg(
      "5545991110005",
      "Pedro Alves",
      "salve, tem vaga quinta as 11?",
      2000,
    );
    await sendMsg("5545991110005", "Pedro Alves", "pode marcar", 35000); // após debounce
    await sendMsg(
      "5545991110005",
      "Pedro Alves",
      "ei preciso cancelar o horario das 11 quinta",
      75000,
    ); // cancela
  });

  // ─── CLIENTE 6 — Mariana, educada e formal ───
  runClient(async () => {
    await sendMsg(
      "5545991110006",
      "Mariana Souza",
      "Olá, boa tarde! Gostaria de verificar a disponibilidade para quinta-feira",
      2500,
    );
    await sendMsg(
      "5545991110006",
      "Mariana Souza",
      "Poderia me informar os horários disponíveis?",
      2700,
    );
    await sendMsg(
      "5545991110006",
      "Mariana Souza",
      "Vou ficar com as 16h então, obrigada!",
      38000,
    );
  });

  // ─── CLIENTE 7 — Rafael, quer 2 horários ───
  runClient(async () => {
    await sendMsg(
      "5545991110007",
      "Rafael Nunes",
      "opa tem horario quinta",
      3000,
    );
    await sendMsg(
      "5545991110007",
      "Rafael Nunes",
      "quero marcar 2 horarios",
      3300,
    );
    await sendMsg("5545991110007", "Rafael Nunes", "as 17 e as 18", 3600);
  });

  // ─── CLIENTE 8 — Juliana, tenta o 3º horário ───
  runClient(async () => {
    await sendMsg(
      "5545991110008",
      "Juliana Ferreira",
      "oi quero marcar quinta as 19h",
      4000,
    );
    await sendMsg(
      "5545991110008",
      "Juliana Ferreira",
      "e tambem as 20h",
      38000,
    );
    await sendMsg(
      "5545991110008",
      "Juliana Ferreira",
      "e as 13h tambem por favor",
      75000,
    ); // deve bloquear — limite 2
  });

  // ─── CLIENTE 9 — Bruno, agenda e remarca ───
  runClient(async () => {
    await sendMsg(
      "5545991110009",
      "Bruno Castro",
      "e ai, marca pra mim quinta as 11h",
      4500,
    );
    await sendMsg(
      "5545991110009",
      "Bruno Castro",
      "cara esquece, muda pra quinta as 14h",
      75000,
    );
  });

  // ─── CLIENTE 10 — Lucia, só consulta ───
  runClient(async () => {
    await sendMsg("5545991110010", "Lucia Martins", "boa noite", 5000);
    await sendMsg(
      "5545991110010",
      "Lucia Martins",
      "tem horario disponivel pra semana que vem?",
      5300,
    );
  });

  console.log(
    "\n⏳ Clientes em andamento... aguarde ~2 minutos para tudo processar.\n",
  );
}

test().catch(console.error);
