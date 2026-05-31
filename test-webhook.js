require("dotenv").config();

async function sendMsg(
  message,
  phone = "595973413527",
  name = "Barbeiro",
) {
  const body = {
    fromMe: false,
    phone,
    senderName: name,
    text: { message },
  };

  // Sem await — dispara sem esperar resposta
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
  await sendMsg("passa Fernanda Costa de amanhã 15h para amanhã 11h");

  console.log("Mensagens enviadas! Aguardando 30s para o bot processar...");
}

test().catch(console.error);
