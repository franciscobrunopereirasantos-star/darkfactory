// Voz por cena. Hoje: OpenAI TTS. Formato da voz: "openai:onyx" (fornecedor:voz).
import fs from "node:fs";
import { fetchComRetry } from "./util.mjs";

const INSTRUCOES =
  "Fale em português do Brasil, com sotaque brasileiro natural. Tom de quem conta uma curiosidade: " +
  "envolvente, claro, ritmo um pouco acelerado como em vídeos curtos, sem soar robótico.";

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
