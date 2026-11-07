// Cliente da API da fábrica (rotas /api/public/fabrica/worker/* no DarkFactory).
import fs from "node:fs";
import { fetchComRetry, log } from "./util.mjs";

const BASE = (process.env.FABRICA_URL || "").replace(/\/$/, "");
const TOKEN = process.env.FABRICA_WORKER_TOKEN || "";

async function chamar(caminho, corpo) {
  if (!BASE || !TOKEN) throw new Error("FABRICA_URL e FABRICA_WORKER_TOKEN precisam estar configurados");
  const r = await fetchComRetry(`${BASE}/api/public/fabrica/worker/${caminho}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(corpo ?? {}),
  });
  const texto = await r.text();
  let json = {};
  try { json = texto ? JSON.parse(texto) : {}; } catch { json = { erro: texto.slice(0, 300) }; }
  if (!r.ok) throw new Error(`API ${caminho} ${r.status}: ${json.erro || texto.slice(0, 300)}`);
  return json;
}

export const pegarPedido = () => chamar("pegar");

export async function progresso(pedido_id, etapa, pct, mensagem, dados) {
  try {
    await chamar("progresso", { pedido_id, etapa, progresso: Math.round(pct), mensagem, dados });
  } catch (e) {
    log("aviso: progresso não registrado:", e.message); // progresso nunca derruba o pedido
  }
}

export const concluir = (corpo) => chamar("concluir", corpo);

// Pede URL assinada e envia o arquivo. Devolve a URL pública final.
export async function enviarArquivo(pedido_id, nome, arquivo, tipo = "video/mp4") {
  const r = await chamar("upload-url", { pedido_id, nome });
  const destino = r.signedUrl || r.signed_url || r.upload_url || r.uploadUrl || r.url;
  const publica = r.public_url || r.publicUrl || r.url_publica;
  if (!destino) throw new Error("upload-url não devolveu a URL assinada");
  const corpo = fs.readFileSync(arquivo);
  const up = await fetchComRetry(destino, {
    method: "PUT",
    headers: { "content-type": tipo, "x-upsert": "true" },
    body: corpo,
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 300)}`);
  return publica;
}
