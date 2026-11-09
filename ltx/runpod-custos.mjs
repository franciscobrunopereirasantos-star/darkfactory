// Custo REAL da RunPod (faturado), por dia: pods e volumes de rede + saldo atual.
// Se FABRICA_URL/FABRICA_WORKER_TOKEN estiverem definidos e ENVIAR=1, envia para a fábrica.
const KEY = process.env.RUNPOD_API_KEY;
const desde = process.env.DESDE || new Date(Date.now() - 30 * 86400e3).toISOString();
const ate = new Date().toISOString();
async function rest(caminho) {
  const r = await fetch(`https://rest.runpod.io/v1/${caminho}`, { headers: { authorization: `Bearer ${KEY}` } });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, texto: t.slice(0, 500) }; }
}
const q = `bucketSize=day&startTime=${encodeURIComponent(desde)}&endTime=${encodeURIComponent(ate)}`;
const pods = await rest(`billing/pods?${q}`);
const vols = await rest(`billing/networkvolumes?${q}`);
const g = await (await fetch(`https://api.runpod.io/graphql?api_key=${KEY}`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "query { myself { clientBalance currentSpendPerHr } }" }) })).json();
console.log("PODS", pods.status, JSON.stringify(pods.json ?? pods.texto).slice(0, 3000));
console.log("VOLUMES", vols.status, JSON.stringify(vols.json ?? vols.texto).slice(0, 2000));
console.log("SALDO", JSON.stringify(g.data?.myself));
