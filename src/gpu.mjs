// Liga o servidor de clipes da API de geração (se ainda não houver um rodando). Sai logo em seguida:
// o próprio pod atende a fila e se desliga depois de ficar ocioso.
import { gql, garantirVolume, ligarPod } from "./runpod.mjs";
import { log } from "./util.mjs";
import { pathToFileURL } from "node:url";

const NOME = "df-gpu-servidor";

// Tempo ocioso antes do pod se desligar. Produção semanal: 10 min (padrão). Modo avulso (teste único disparado
// pela fábrica): a fábrica manda client_payload.ocioso_min (ex.: 3) e o workflow repassa em GPU_OCIOSA_MIN_PEDIDO.
// Valor fora de 2–30 é ignorado. Se já houver um pod ligado, nada muda: ele segue com a política com que subiu.
export function ociosoMin(env = process.env) {
  const pedido = Number(env.GPU_OCIOSA_MIN_PEDIDO);
  if (Number.isFinite(pedido) && pedido >= 2 && pedido <= 30) return String(pedido);
  return env.GPU_OCIOSA_MIN || "10";
}
const BASE = (process.env.FABRICA_URL || "").replace(/\/$/, "");

async function main() {
  const d = await gql(`query { myself { pods { id name desiredStatus } } }`);
  const ativo = (d.myself?.pods || []).find((p) => p.name === NOME && p.desiredStatus === "RUNNING");
  if (ativo) { log(`servidor de GPU já está ligado (pod ${ativo.id})`); return; }
  let volume = null;
  if (process.env.USAR_VOLUME === "1") { try { volume = await garantirVolume(); } catch (e) { log("volume de rede indisponível, segue sem:", e.message); } }
  // Sem placa barata agora: tenta de novo a cada 5 min por até GPU_ESPERA_MIN (padrão 50) antes de desistir.
  const limite = Date.now() + Number(process.env.GPU_ESPERA_MIN || 50) * 60_000;
  let pod;
  for (;;) {
    try { pod = await ligarPodServidor(volume); break; }
    catch (e) {
      if (Date.now() + 5 * 60_000 > limite) throw e;
      log(`${e.message} — nova tentativa em 5 min`);
      await new Promise((r) => setTimeout(r, 5 * 60_000));
      const d2 = await gql(`query { myself { pods { id name desiredStatus } } }`);
      if ((d2.myself?.pods || []).some((p) => p.name === NOME && p.desiredStatus === "RUNNING")) { log("outro disparo já ligou a GPU"); return; }
    }
  }
  log(`servidor de GPU ligado: ${pod.gpu} (US$ ${pod.costPerHr}/h), pod ${pod.id}, ${pod.comVolume ? "com" : "sem"} volume, ` +
    `desliga após ${ociosoMin()} min ocioso${process.env.GPU_MODO ? ` (modo ${process.env.GPU_MODO})` : ""}`);
}

function ligarPodServidor(volume) {
  return ligarPod({
    nome: NOME,
    cmd: "bash -c 'curl -sL https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/servidor_pod.sh | bash'",
    env: {
      FABRICA_URL: BASE, FABRICA_WORKER_TOKEN: process.env.FABRICA_WORKER_TOKEN,
      RUNPOD_API_KEY: process.env.RUNPOD_API_KEY, HF_TOKEN: process.env.HF_TOKEN,
      GPU_OCIOSA_MIN: ociosoMin(),
    },
    volume,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { log("erro ao ligar a GPU:", e.message); process.exit(1); });
}
