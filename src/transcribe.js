const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeAudio(audioUrl) {
  // Baixa o áudio
  const response = await fetch(audioUrl);
  const buffer = await response.arrayBuffer();

  // Salva temporariamente
  const tempPath = path.join(__dirname, "../temp_audio.ogg");
  fs.writeFileSync(tempPath, Buffer.from(buffer));

  // Transcreve com Whisper
  const transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(tempPath),
    model: "whisper-1",
    language: "pt",
  });

  // Remove o arquivo temporário
  fs.unlinkSync(tempPath);

  return transcription.text;
}

module.exports = { transcribeAudio };