// RunPod: volume de rede com os pesos do LTX, ligar uma GPU, acompanhar e garantir que ela desligue.
import { log } from "./util.mjs";

const KEY = () => process.env.RUNPOD_API_KEY;
const s = (v) => JSON.stringify(String(v ?? ""));

export async function gql(query) {
  const r = await fetch(`https://api.runpod.io/graphql?api_key=${KEY()}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 500));
  return j.data;
}

export const VOLUME_NOME = "ltx-pesos";
export const VOLUME_GB = Number(process.env.VOLUME_GB || 100);
export const VOLUME_DC = process.env.VOLUME_DC || "US-IL-1";

// GPUs em ordem de preferência. sps = segundos de GPU por segundo de clipe (medido; o da L40S/6000 Ada é chute até o 1º lote).
export const GPUS = [
  { id: "NVIDIA L40S", preco: 1.09, sps: 21 },
  { id: "NVIDIA RTX 6000 Ada Generation", preco: 0.95, sps: 40 },
  { id: "NVIDIA A100 80GB PCIe", preco: 1.64, sps: 20 },
  { id: "NVIDIA A100-SXM4-80GB", preco: 1.74, sps: 18 },
  { id: "NVIDIA H100 PCIe", preco: 2.39, sps: 14 },
  // 48 GB mais antigas/baratas: só entram se as de cima estiverem esgotadas (sps é chute, mais lentas)
  { id: "NVIDIA L40", preco: 0.99, sps: 26 },
  { id: "NVIDIA RTX A6000", preco: 0.49, sps: 40 },
  { id: "NVIDIA A40", preco: 0.44, sps: 42 },
];
export const BOOT_COM_VOLUME_S = 300; // ligar + instalar + carregar com pesos no volume
export const BOOT_SEM_VOLUME_S = 1000; // baixar 72 GB do Hugging Face

/** Pior caso de custo para gerar `segClipe` segundos de clipe (usa a GPU mais cara por clipe da lista). */
export function estimarCusto(segClipe) {
  return Math.max(...GPUS.map((g) => ((BOOT_SEM_VOLUME_S + segClipe * g.sps) / 3600) * g.preco));
}

export async function garantirVolume() {
  const d = await gql(`query { myself { networkVolumes { id name size dataCenterId } } }`);
  const existente = (d.myself?.networkVolumes || []).find((v) => v.name === VOLUME_NOME);
  if (existente) return existente;
  const c = await gql(`mutation { createNetworkVolume(input: { name: ${s(VOLUME_NOME)}, size: ${VOLUME_GB}, dataCenterId: ${s(VOLUME_DC)} }) { id name size dataCenterId } }`);
  log(`volume de rede criado: ${c.createNetworkVolume.id} (${VOLUME_GB} GB em ${VOLUME_DC})`);
  return c.createNetworkVolume;
}

/** Liga um pod que roda `cmd`. Tenta primeiro no datacenter do volume; se não houver GPU lá, liga sem volume. */
export async function ligarPod({ nome, cmd, env, volume }) {
  const envs = Object.entries(env).map(([k, v]) => `{ key: ${s(k)}, value: ${s(v)} }`).join(", ");
  const base = `cloudType: __NUVEM__, gpuCount: 1, name: ${s(nome)}, imageName: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
    containerDiskInGb: 200, minVcpuCount: 8, minMemoryInGb: 60, dockerArgs: ${s(cmd)}, ports: "", env: [${envs}, { key: "COM_VOLUME", value: "__VOL__" }]`;
  const tentativas = [];
  if (volume) for (const g of GPUS) tentativas.push({ g, extra: `, networkVolumeId: ${s(volume.id)}, volumeMountPath: "/workspace", dataCenterId: ${s(volume.dataCenterId)}`, vol: "1" });
  for (const g of GPUS) tentativas.push({ g, extra: ", volumeInGb: 0", vol: "0" });
  // último recurso: nuvem comunitária (mais barata, menos garantida), sem volume
  for (const g of GPUS) tentativas.push({ g, extra: ", volumeInGb: 0", vol: "0", nuvem: "COMMUNITY" });
  for (const t of tentativas) {
    try {
      const q = `mutation { podFindAndDeployOnDemand(input: { ${base.replace("__VOL__", t.vol).replace("__NUVEM__", t.nuvem || "SECURE")}, gpuTypeId: ${s(t.g.id)}${t.extra} }) { id costPerHr machine { gpuDisplayName } } }`;
      const d = await gql(q);
      const p = d.podFindAndDeployOnDemand;
      if (p?.id) {
        log(`GPU ligada: ${t.g.id} ${t.vol === "1" ? "com volume" : "SEM volume (vai baixar os pesos)"} — US$ ${p.costPerHr}/h, pod ${p.id}`);
        return { ...p, gpu: t.g.id, comVolume: t.vol === "1", inicio: Date.now() };
      }
    } catch (e) {
      log(`${t.g.id} ${t.vol === "1" ? "(volume)" : ""}: indisponível — ${e.message.slice(0, 140)}`);
    }
  }
  throw new Error("nenhuma GPU disponível na RunPod agora");
}

/** Espera o pod se desligar sozinho; desliga à força depois de maxMin. Devolve os minutos ligados. */
export async function esperarPod(pod, maxMin, aoMinuto) {
  while (true) {
    await new Promise((r) => setTimeout(r, 60_000));
    const min = (Date.now() - pod.inicio) / 60000;
    let d;
    try { d = await gql(`query { pod(input: {podId: ${s(pod.id)}}) { id desiredStatus } }`); }
    catch (e) { log("consulta do pod falhou:", e.message.slice(0, 120)); continue; }
    if (!d.pod || d.pod.desiredStatus === "TERMINATED" || d.pod.desiredStatus === "EXITED") {
      if (d.pod) await desligarPod(pod);
      log(`GPU desligada após ${min.toFixed(1)} min`);
      return min;
    }
    if (aoMinuto) await aoMinuto(min);
    if (min > maxMin) {
      await desligarPod(pod);
      log(`tempo máximo (${maxMin} min) atingido: GPU desligada à força`);
      return min;
    }
  }
}

export async function desligarPod(pod) {
  try { await gql(`mutation { podTerminate(input: {podId: ${s(pod.id)}}) }`); } catch (e) { log("podTerminate:", e.message.slice(0, 120)); }
}
