// Consulta (só leitura) da RunPod: datacenters, estoque de L40S/A100 e volumes de rede existentes.
const KEY = process.env.RUNPOD_API_KEY;
const gql = async (query) => {
  const r = await fetch(`https://api.runpod.io/graphql?api_key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  });
  return r.json().catch(() => ({ erro: r.status }));
};
const tentativas = {
  datacenters: `query { dataCenters { id name location storageSupport listed gpuAvailability { gpuTypeId stockStatus available } } }`,
  volumes: `query { myself { networkVolumes { id name size dataCenterId } } }`,
  gpus: `query { gpuTypes { id displayName memoryInGb secureCloud communityCloud lowestPrice(input: {gpuCount: 1}) { minimumBidPrice uninterruptablePrice stockStatus } } }`,
};
for (const [nome, q] of Object.entries(tentativas)) {
  const j = await gql(q);
  if (nome === "datacenters" && j.data?.dataCenters) {
    for (const d of j.data.dataCenters) {
      const g = (d.gpuAvailability || []).filter((x) => /L40S|A100|H100|6000 Ada/i.test(x.gpuTypeId));
      console.log(`${d.id} (${d.location}) storage=${d.storageSupport} listed=${d.listed} :: ${g.map((x) => `${x.gpuTypeId}=${x.stockStatus}`).join(" | ")}`);
    }
  } else if (nome === "gpus" && j.data?.gpuTypes) {
    for (const g of j.data.gpuTypes.filter((x) => /L40S|A100|H100|6000 Ada|A6000/i.test(x.id)))
      console.log(`GPU ${g.id} ${g.memoryInGb}GB secure=${g.secureCloud} :: ${JSON.stringify(g.lowestPrice)}`);
  } else console.log(nome, JSON.stringify(j).slice(0, 1500));
}
