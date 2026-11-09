// Sincroniza o custo REAL faturado da RunPod (pods + volumes, por dia) e o saldo com a fábrica.
import { fetchComRetry, log } from "./util.mjs";

const KEY = process.env.RUNPOD_API_KEY;
const BASE = (process.env.FABRICA_URL || "").replace(/\/$/, "");
const TOKEN = process.env.FABRICA_WORKER_TOKEN || "";

const inicioMes = new Date(); inicioMes.setUTCDate(1); inicioMes.setUTCHours(0, 0, 0, 0);
const desde = new Date(Math.min(inicioMes.getTime(), Date.now() - 3 * 86400e3)).toISOString();
const ate = new Date().toISOString();
const q = `bucketSize=day&startTime=${encodeURIComponent(desde)}&endTime=${encodeURIComponent(ate)}`;

async function rest(caminho) {
  const r = await fetchComRetry(`https://rest.runpod.io/v1/${caminho}`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`RunPod ${caminho} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function main() {
  const pods = await rest(`billing/pods?${q}`);
  const vols = await rest(`billing/networkvolumes?${q}`);
  const g = await (await fetchComRetry(`https://api.runpod.io/graphql?api_key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "query { myself { clientBalance } }" }),
  })).json();
  const dia = (t) => String(t).slice(0, 10);
  const itens = [
    ...pods.map((p) => ({ data: dia(p.time), tipo: "pod", referencia: p.podId, valor_usd: Math.round(p.amount * 1e6) / 1e6, segundos: Math.round((p.timeBilledMs || 0) / 1000) })),
    ...vols.map((v) => ({ data: dia(v.startDate), tipo: "volume", referencia: "volume", valor_usd: Math.round(v.amount * 1e6) / 1e6 })),
  ];
  const saldo = g.data?.myself?.clientBalance;
  const total = itens.reduce((s, i) => s + i.valor_usd, 0);
  log(`RunPod: ${itens.length} itens, US$ ${total.toFixed(2)} desde ${desde.slice(0, 10)}; saldo US$ ${Number(saldo).toFixed(2)}`);
  const r = await fetchComRetry(`${BASE}/api/public/fabrica/worker/custos/runpod`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ itens, saldo_usd: saldo, consultado_em: new Date().toISOString() }),
  });
  if (r.status === 404) { log("rota de custos ainda não publicada"); return; }
  if (!r.ok) throw new Error(`fábrica ${r.status}: ${(await r.text()).slice(0, 200)}`);
  log("custos enviados para a fábrica");
}

main().catch((e) => { log("erro ao sincronizar custos:", e.message); process.exit(1); });
