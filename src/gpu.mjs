// Liga o servidor de clipes da API de geração (se ainda não houver um rodando). Sai logo em seguida:
// o próprio pod atende a fila e se desliga depois de ficar ocioso.
import { gql, garantirVolume, ligarPod } from "./runpod.mjs";
import { log } from "./util.mjs";

const NOME = "df-gpu-servidor";
const BASE = (process.env.FABRICA_URL || "").replace(/\/$/, "");

async function main() {
  const d = await gql(`query { myself { pods { id name desiredStatus } } }`);
  const ativo = (d.myself?.pods || []).find((p) => p.name === NOME && p.desiredStatus === "RUNNING");
  if (ativo) { log(`servidor de GPU já está ligado (pod ${ativo.id})`); return; }
  let volume = null;
  try { volume = await garantirVolume(); } catch (e) { log("volume de rede indisponível, segue sem:", e.message); }
  const pod = await ligarPod({
    nome: NOME,
    cmd: "bash -c 'curl -sL https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/servidor_pod.sh | bash'",
    env: {
      FABRICA_URL: BASE, FABRICA_WORKER_TOKEN: process.env.FABRICA_WORKER_TOKEN,
      RUNPOD_API_KEY: process.env.RUNPOD_API_KEY, HF_TOKEN: process.env.HF_TOKEN,
      GPU_OCIOSA_MIN: process.env.GPU_OCIOSA_MIN || "10",
    },
    volume,
  });
  log(`servidor de GPU ligado: ${pod.gpu} (US$ ${pod.costPerHr}/h), pod ${pod.id}, ${pod.comVolume ? "com" : "sem"} volume`);
}

main().catch((e) => { log("erro ao ligar a GPU:", e.message); process.exit(1); });
