# bona-barber

Bot de agendamento para a Bona Barber via WhatsApp — fork do [barber-bot](https://github.com/MvBona/barber-bot) migrado para Baileys (conexão direta ao WhatsApp Web, sem API paga).

## O que faz

- Clientes agendam, cancelam e reagendam pelo WhatsApp sem intervenção humana
- IA interpreta linguagem natural em PT e ES (barbearia italiana, clientela mista)
- Painel web com visão dia / semana / mês dos horários
- Lembretes automáticos 24h e 1h antes do agendamento
- Barbeiro gerencia tudo pelo próprio WhatsApp
- Transcrição de áudios via Whisper

## Stack

| Camada | Tecnologia |
|---|---|
| WhatsApp | Baileys (`@whiskeysockets/baileys`) |
| IA | Claude (Anthropic) + Whisper (OpenAI) |
| Dados | Google Sheets |
| Backend | Node.js + Express |
| Processo | PM2 |

## Configuração rápida

```bash
cp .env.example .env   # preencher credenciais
npm install
node src/index.js      # exibe QR code para conectar o WhatsApp
```

Sessão salva em `auth_info_baileys/` — não precisa escanear de novo após reiniciar.

### Variáveis de ambiente (`.env`)

| Variável | Descrição |
|---|---|
| `SPREADSHEET_ID` | ID da planilha Google Sheets |
| `GOOGLE_CREDENTIALS` | JSON das credenciais da service account (minificado) |
| `OPENAI_API_KEY` | Chave OpenAI (transcrição de áudios) |
| `ANTHROPIC_API_KEY` | Chave Anthropic (IA de interpretação) |
| `BARBERSHOP_NAME` | Nome da barbearia |
| `BARBERSHOP_PHONE` | Número do admin (DDI+DDD+número) |
| `BARBERSHOP_JID` | JID do WhatsApp do admin (para mapeamento LID) |
| `BAILEYS_AUTH_FOLDER` | Pasta da sessão (padrão: `auth_info_baileys`) |
| `PORT` | Porta do servidor Express (padrão: `3001`) |
| `CRONS_ENABLED` | `true` para ativar lembretes automáticos |

## Comandos do barbeiro (WhatsApp)

```
agenda hoje / agenda 15/06        — ver horários do dia
bloqueia 15/06                    — bloquear dia inteiro
bloqueia 14h do dia 15/06         — bloquear horário específico
desbloqueia ...                   — liberar dia ou horário
marca João 14h 15/06              — agendar manualmente
cancela 15/06 14h                 — cancelar agendamento
passa de 15/06 14h para 16/06 10h — reagendar
ajuda                             — ver todos os comandos
```

## Estrutura

```
src/
  index.js        — entrada principal, rotas Express e handler WhatsApp
  whatsapp.js     — módulo Baileys (conexão, envio, reconexão automática)
  ai.js           — interpretação de mensagens com Claude
  sheets.js       — leitura e escrita na planilha
  scheduler.js    — geração de slots e bloqueios
  i18n.js         — mensagens PT / ES / EN
  transcribe.js   — transcrição de áudios (Whisper)
public/
  index.html      — painel web de agenda
```
