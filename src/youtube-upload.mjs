// Upload de vídeo grande para o YouTube pelo worker (contrato do Lovable, rota /api/public/fabrica/worker/youtube).
// 1) pede a sessão (o servidor já abriu o upload resumível no YouTube — nenhuma credencial do Google chega aqui);
// 2) baixa o vídeo assinado e faz PUT dos bytes no upload_url; 3) avisa resultado ou falha.
// Uso: PUBLICACAO_ID=<uuid> node src/youtube-upload.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BASE = (process.env.FABRICA_URL || "").replace(/\/$/, "");
const TOKEN = process.env.FABRICA_WORKER_TOKEN || "";
const PUB = process.env.PUBLICACAO_ID || "";

async function api(corpo) {
  const r = await fetch(`${BASE}/api/public/fabrica/worker/youtube`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(corpo),
  });
  const txt = await r.text();
  let json = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* corpo não-JSON */ }
  if (!r.ok) throw new Error(`worker/youtube ${corpo.acao}: HTTP ${r.status} ${txt.slice(0, 300)}`);
  return json;
}

async function main() {
  if (!BASE || !TOKEN || !PUB) throw new Error("faltam FABRICA_URL, FABRICA_WORKER_TOKEN ou PUBLICACAO_ID");
  const s = await api({ acao: "sessao", publicacao_id: PUB });
  if (!s.upload_url || !s.video_url) throw new Error("sessão sem upload_url/video_url");
  console.log(`[youtube] sessão ok (${s.tamanho} bytes, short=${!!s.short})`);

  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yt-")), "video.mp4");
  const dl = await fetch(s.video_url);
  if (!dl.ok || !dl.body) throw new Error(`download do vídeo: HTTP ${dl.status}`);
  await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(arq));
  const tamanho = fs.statSync(arq).size;
  if (s.tamanho && Number(s.tamanho) !== tamanho) throw new Error(`tamanho baixado ${tamanho} ≠ esperado ${s.tamanho}`);
  console.log(`[youtube] baixado ${tamanho} bytes; enviando…`);

  const up = await fetch(s.upload_url, {
    method: "PUT",
    headers: { "content-type": s.content_type || "video/mp4", "content-length": String(tamanho) },
    body: Readable.toWeb(fs.createReadStream(arq)),
    duplex: "half",
  });
  const txt = await up.text();
  if (!up.ok) throw new Error(`PUT YouTube: HTTP ${up.status} ${txt.slice(0, 400)}`);
  let id = null;
  try { id = JSON.parse(txt).id; } catch { /* */ }
  if (!id) throw new Error(`YouTube não devolveu id: ${txt.slice(0, 300)}`);
  await api({ acao: "resultado", publicacao_id: PUB, video_id: id });
  console.log(`[youtube] publicado: https://youtu.be/${id}`);
}

main().catch(async (e) => {
  const erro = String(e?.message || e).slice(0, 1500);
  console.error("[youtube] falhou:", erro);
  try { if (BASE && TOKEN && PUB) await api({ acao: "falha", publicacao_id: PUB, erro }); } catch (e2) { console.error("[youtube] aviso de falha não enviado:", e2.message); }
  process.exit(1);
});
