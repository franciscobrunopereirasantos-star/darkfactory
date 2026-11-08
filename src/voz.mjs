// Voz por cena. Hoje: OpenAI TTS. Formato da voz: "openai:onyx" (fornecedor:voz).
import fs from "node:fs";
import { fetchComRetry } from "./util.mjs";

const INSTRUCOES =
  "Fale em português do Brasil, com sotaque brasileiro natural. Tom de quem conta uma curiosidade: " +
  "envolvente, claro, ritmo um pouco acelerado como em vídeos curtos, sem soar robótico.";

// ElevenLabs (eleven_multilingual_v2). Custo aproximado: ~US$ 0,18 por 1.000 caracteres (plano Creator).
export async function vozElevenLabs(texto, vozId, destino) {
  const chave = process.env.ELEVENLABS_API_KEY;
  if (!chave) throw new Error("ELEVENLABS_API_KEY não configurada no worker");
  const r = await fetchComRetry(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vozId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": chave, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: texto,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
  return { arquivo: destino, custo_usd: (texto.length / 1000) * 0.18 };
}

export async function gerarVoz(texto, voz, destino) {
  const [fornecedor, nome] = (voz || "openai:onyx").includes(":") ? voz.split(":") : ["openai", voz];
  if (fornecedor !== "openai") throw new Error(`fornecedor de voz não suportado ainda: ${fornecedor}`);
  const r = await fetchComRetry("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: nome || "onyx",
      input: texto,
      instructions: INSTRUCOES,
      response_format: "mp3",
    }),
  });
  if (!r.ok) throw new Error(`OpenAI TTS ${r.status}: ${(await r.text()).slice(0, 300)}`);
  fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
  // custo aproximado do gpt-4o-mini-tts: ~US$ 0,015 por minuto de áudio; estimamos por caracteres
  return { arquivo: destino, custo_usd: (texto.length / 900) * 0.015 };
}
