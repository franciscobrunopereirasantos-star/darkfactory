// Liga uma GPU no RunPod para o teste do LTX, acompanha e garante que ela seja desligada no fim.
const KEY = process.env.RUNPOD_API_KEY;
const MAX_MIN = Number(process.env.MAX_MIN || 80);
const gql = async (query) => {
  const r = await fetch(`https://api.runpod.io/graphql?api_key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 500));
  return j.data;
};
const s = (v) => JSON.stringify(String(v ?? ""));
const env = ["FABRICA_URL", "FABRICA_WORKER_TOKEN", "PEDIDO_ID", "RUNPOD_API_KEY"]
  .map((k) => `{ key: ${s(k)}, value: ${s(process.env[k])} }`).join(", ");
const cmd = "bash -c 'curl -sL https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/pod.sh | bash'";
const GPUS = ["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB", "NVIDIA H100 PCIe", "NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation"];

let pod = null;
for (const gpu of GPUS) {
  try {
    const d = await gql(`mutation { podFindAndDeployOnDemand(input: {
      cloudType: ALL, gpuCount: 1, gpuTypeId: ${s(gpu)}, name: "ltx-teste-darkfactory",
      imageName: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
      containerDiskInGb: 180, volumeInGb: 0, minVcpuCount: 8, minMemoryInGb: 60,
      dockerArgs: ${s(cmd)}, ports: "", env: [${env}] }) { id costPerHr machine { gpuDisplayName } } }`);
    pod = d.podFindAndDeployOnDemand;
    if (pod?.id) { console.log(`GPU ligada: ${gpu} (US$ ${pod.costPerHr}/h) pod ${pod.id}`); break; }
  } catch (e) { console.log(`${gpu}: indisponível (${e.message.slice(0, 160)})`); }
}
if (!pod?.id) { console.log("Nenhuma GPU disponível agora."); process.exit(1); }

const inicio = Date.now();
while (true) {
  await new Promise((r) => setTimeout(r, 60_000));
  const min = (Date.now() - inicio) / 60000;
  let d;
  try { d = await gql(`query { pod(input: {podId: ${s(pod.id)}}) { id desiredStatus runtime { uptimeInSeconds } } }`); }
  catch (e) { console.log("consulta falhou:", e.message.slice(0, 120)); continue; }
  if (!d.pod) { console.log(`GPU já desligada pelo próprio teste após ${min.toFixed(0)} min.`); break; }
  console.log(`${min.toFixed(0)} min — ${d.pod.desiredStatus}`);
  if (min > MAX_MIN) {
    await gql(`mutation { podTerminate(input: {podId: ${s(pod.id)}}) }`);
    console.log(`Tempo máximo (${MAX_MIN} min) atingido: GPU desligada.`);
    break;
  }
}
console.log(`Custo estimado: US$ ${((Date.now() - inicio) / 3600000 * pod.costPerHr).toFixed(2)}`);
