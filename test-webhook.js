require("dotenv").config();

async function sendMsg(
  message,
  phone = "5545999990001",
  name = "Cliente Teste",
) {
  const body = {
    fromMe: false,
    phone,
    senderName: name,
    text: { message },
  };

  // ✅ sem await — dispara sem esperar resposta
  fetch(`http://localhost:3000/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) =>
    console.log(`Enviado: "${message}" → Status: ${res.status}`),
  );

  // Pequena pausa entre mensagens (simula digitação rápida)
  await new Promise((r) => setTimeout(r, 200));
}

async function test() {
  await sendMsg("Opa");
  await sendMsg("Blz?");
  await sendMsg("Ta tendo horario?");
  await sendMsg("Hj ainda?");

  console.log("Mensagens enviadas! Aguardando 30s para o bot processar...");
}

test().catch(console.error);
