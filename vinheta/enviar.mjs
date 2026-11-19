// Envia o MP4 da vinheta e a folha de quadros para o storage da fábrica (mesmo upload do worker).
// Uso: PEDIDO_ID=<uuid> node vinheta/enviar.mjs <pasta-saida>
import fs from "node:fs";
import path from "node:path";
import { enviarArquivo } from "../src/api.mjs";
const saida = process.argv[2];
const pedido = process.env.PEDIDO_ID;
const urls = {};
urls.video = await enviarArquivo(pedido, "vinheta-luma-e-malu.mp4", path.join(saida, "vinheta-luma-e-malu.mp4"), "video/mp4");
const quadros = path.join(saida, "quadros");
if (fs.existsSync(quadros)) {
  for (const f of fs.readdirSync(quadros).filter((f) => /contact-sheet.*\.jpg$/.test(f))) {
    urls[f] = await enviarArquivo(pedido, `vinheta-${f}`, path.join(quadros, f), "image/jpeg");
  }
}
console.log("URLS " + JSON.stringify(urls));
