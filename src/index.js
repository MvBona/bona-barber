require("dotenv").config();
const express = require("express");
const { getAvailableSlots, bookSlot } = require("./sheets");
const { interpretMessage } = require("./ai");
const app = express();

app.use(express.json());

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

async function sendMessage(phone, message) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Token": ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify({ phone, message }),
  });

  const data = await response.json();
  console.log("Resposta enviada:", data);
}

app.get("/", (req, res) => {
  res.send("Bot da barbearia rodando!");
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.fromMe) return res.sendStatus(200);
  if (!body.text?.message) return res.sendStatus(200);

  const phone = body.phone;
  const text = body.text.message;
  const name = body.senderName;

  console.log(`Mensagem de ${name} (${phone}): ${text}`);

  try {
    const slots = await getAvailableSlots();
    const reply = await interpretMessage(text, slots);
    await sendMessage(phone, reply);
  } catch (error) {
    console.error("Erro ao processar mensagem:", error.message);
    await sendMessage(
      phone,
      "Desculpe, tive um problema. Tenta de novo em instantes!",
    );
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
