// Junta vídeos em sequência (ex.: vinheta + episódio), normalizando para 1920x1080, 30 fps, AAC 48 kHz,
// e envia o resultado para o storage da fábrica.
// Uso: PEDIDO_ID=<uuid> NOME=<arquivo.mp4> node vinheta/juntar.mjs <url1> <url2> [...]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { enviarArquivo } from "../src/api.mjs";

const urls = process.argv.slice(2);
const pasta = fs.mkdtempSync("/tmp/juntar-");
const partes = [];
for (const [i, u] of urls.entries()) {
  const bruto = path.join(pasta, `b${i}.mp4`);
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", bruto, u]);
  const temAudio = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", bruto]).toString().trim() !== "";
  const norm = path.join(pasta, `n${i}.mp4`);
  const args = ["-nostdin", "-y", "-loglevel", "error", "-i", bruto];
  if (!temAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  if (!temAudio) args.push("-shortest");
  args.push(norm);
  execFileSync("ffmpeg", args);
  partes.push(norm);
  console.log(`parte ${i + 1}: ${u}`);
}
const lista = path.join(pasta, "lista.txt");
fs.writeFileSync(lista, partes.map((p) => `file '${p}'`).join("\n"));
const saida = path.join(pasta, process.env.NOME || "juntado.mp4");
execFileSync("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lista, "-c", "copy", "-movflags", "+faststart", saida]);
const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", saida]).toString().trim();
const url = await enviarArquivo(process.env.PEDIDO_ID, path.basename(saida), saida, "video/mp4");
console.log("URLS " + JSON.stringify({ video: url, duracao_s: Number(dur) }));
