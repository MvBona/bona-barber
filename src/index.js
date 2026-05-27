const express = require("express");
const app = express();

app.use(express.json());

// Rota de teste
app.get("/", (req, res) => {
  res.send("Bot da barbearia rodando!");
});

// Webhook — aqui a Z-API vai enviar as mensagens
app.post("/webhook", (req, res) => {
  const body = req.body;
  console.log("Mensagem recebida:", JSON.stringify(body, null, 2));
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
