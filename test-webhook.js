require("dotenv").config();

const body = {
  fromMe: false,
  phone: process.env.BARBERSHOP_PHONE,
  senderName: "Barbeiro",
  text: {
    message: "Desbloqueia o dia 11/06", // ← muda aqui para testar
  },
};

fetch(`http://localhost:3000/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})
  .then((res) => console.log("Status:", res.status))
  .catch(console.error);
