// Apaga o volume de rede "ltx-pesos" da RunPod (pedido do Francisco em 09/11/2026: não compensa).
const KEY = process.env.RUNPOD_API_KEY;
const gql = async (query) => (await fetch(`https://api.runpod.io/graphql?api_key=${KEY}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
})).json();
const d = await gql(`query { myself { networkVolumes { id name size dataCenterId } } }`);
const vols = (d.data?.myself?.networkVolumes || []).filter((v) => v.name === "ltx-pesos");
if (!vols.length) console.log("nenhum volume ltx-pesos encontrado");
for (const v of vols) {
  const r = await gql(`mutation { deleteNetworkVolume(input: { id: "${v.id}" }) }`);
  console.log("apagar", v.id, v.size + "GB", v.dataCenterId, "=>", JSON.stringify(r));
}
const depois = await gql(`query { myself { networkVolumes { id name } } }`);
console.log("volumes restantes:", JSON.stringify(depois.data?.myself?.networkVolumes));
