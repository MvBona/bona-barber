module.exports = {
  nome: "Bona Barber",
  botName: "Fio",
  adminAlias: "barbeiro",
  telefoneAdmin: "595973413527",
  telefoneAgente: "5545920026026", // número do WhatsApp do bot

  timezone: "America/Sao_Paulo",
  idiomas: ["pt", "es"],

  expediente: { inicio: 10, fim: 20 },
  duracaoSlot: 60,
  diasFechado: [0], // domingo

  profissionais: [
    { id: "marcos", nome: "Marcos", telefone: "595973413527" },
    // { id: "livia",  nome: "Lívia",  telefone: "595973629910" },
  ],
  adminsPorProfissional: true,
  distribuicao: "manual",
  permissoesContratado: { cancelar: false },

  servicos: [
    { nome: "Corte de cabelo", preco: "R$50" },
    { nome: "Barba",           preco: "R$30" },
    { nome: "Sobrancelha",     preco: "R$10" },
    { nome: "Lavagem + Penteado", preco: "R$20" },
  ],
  pagamento: "Reais e guaranis (câmbio na hora)",

  subtitulo: "Barbiere · Agenda Online",
  logo: "logo-bona.svg",

  endereco: "Rua Exemplo, 123 — Cidade, País",
  // enderecoMaps: "https://maps.app.goo.gl/...", // opcional: link direto do Google Maps

  cancelamentoMinHoras: 2,
  maxAgendamentosPorDia: 2,
  confirmarSeLessDe: 60,
};
