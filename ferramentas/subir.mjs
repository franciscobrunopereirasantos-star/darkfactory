// Sobe todos os arquivos de uma pasta do repositório para o storage da fábrica.
// Uso: PEDIDO_ID=<uuid> PREFIXO=<texto> node ferramentas/subir.mjs <pasta>
import fs from "node:fs";
import path from "node:path";
import { enviarArquivo } from "../src/api.mjs";
const pasta = process.argv[2];
const pedido = process.env.PEDIDO_ID;
const prefixo = process.env.PREFIXO || "";
const tipos = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };
const urls = {};
for (const f of fs.readdirSync(pasta).sort()) {
  const t = tipos[path.extname(f).toLowerCase()];
  if (!t) continue;
  urls[f] = await enviarArquivo(pedido, prefixo + f, path.join(pasta, f), t);
}
console.log("URLS " + JSON.stringify(urls));
