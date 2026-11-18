// Utilidades comuns: log, ffmpeg/ffprobe, download, espera.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

const run = promisify(execFile);

export function log(...args) {
  console.log(`[fabrica ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MIN || 12) * 60_000;

export async function ffmpeg(args) {
  try {
    // -nostdin: o execFile deixa o stdin aberto como pipe e o ffmpeg pode ficar esperando nele.
    // timeout: um ffmpeg travado não pode segurar o worker até o limite de 50 min do Actions (F19).
    await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS, killSignal: "SIGKILL" });
  } catch (e) {
    if (e.killed) throw new Error(`ffmpeg passou de ${FFMPEG_TIMEOUT_MS / 60000} min e foi interrompido: ${args.filter((a) => typeof a === "string" && a.length < 200).slice(-1)[0] || ""}`);
    throw new Error(`ffmpeg falhou: ${(e.stderr || e.message || "").toString().slice(0, 600)}`);
  }
}

// ffmpeg que devolve o stderr (para silencedetect/blackdetect)
export async function ffmpegAnalise(args) {
  try {
    const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", ...args], { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS, killSignal: "SIGKILL" });
    return stderr.toString();
  } catch (e) {
    return (e.stderr || "").toString();
  }
}

export async function ffprobeJson(arquivo) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", arquivo]);
  return JSON.parse(stdout.toString());
}

export async function duracao(arquivo) {
  const info = await ffprobeJson(arquivo);
  return Number(info.format.duration);
}

export async function baixar(url, destino, headers = {}) {
  const r = await fetchComRetry(url, { headers });
  if (!r.ok) throw new Error(`download ${r.status} em ${url.slice(0, 120)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(destino, buf);
  return destino;
}

export const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// fetch com até 3 tentativas para erros de rede e 429/5xx
export async function fetchComRetry(url, opcoes = {}, tentativas = 3) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, opcoes);
      if (r.status === 429 || r.status >= 500) {
        ultimo = new Error(`HTTP ${r.status} em ${url.slice(0, 120)}: ${(await r.text()).slice(0, 200)}`);
      } else {
        return r;
      }
    } catch (e) {
      ultimo = e;
    }
    await esperar(1500 * (i + 1) ** 2);
  }
  throw ultimo;
}
