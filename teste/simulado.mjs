// Teste de ponta a ponta sem gastar nada: simula a API da fábrica, a OpenAI e o Pexels
// com arquivos locais, e roda o worker de verdade (voz -> visual -> montagem -> conferência -> entrega).
// Uso: node teste/simulado.mjs <pasta-com-a0.wav..., v0.mp4, i1.jpg...> <saida.mp4>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [pastaAssets, saidaFinal] = process.argv.slice(2);
const audios = fs.readdirSync(pastaAssets).filter((f) => /^a\d+\.wav$/.test(f)).sort();
const videos = fs.readdirSync(pastaAssets).filter((f) => /^v\d+\.mp4$/.test(f)).sort();
const fotos = fs.readdirSync(pastaAssets).filter((f) => /^i\d+\.jpg$/.test(f)).sort();

const pedido = {
  id: "11111111-2222-3333-4444-555555555555",
  formato: "short_narrado",
  entrada: {
    formato: "short_narrado",
    aspecto: "9:16",
    roteiro: {
      titulo: "Por que o céu é azul?",
      cenas: [
        { texto: "Se a luz do Sol é branca, por que o céu é azul e o pôr do sol fica vermelho?" },
        { texto: "A resposta não é o reflexo do mar. É o ar que existe entre você e o espaço." },
        { texto: "A luz solar é uma mistura de cores que se espalha na atmosfera.", busca: "sunlight sky" },
        { texto: "É o espalhamento de Rayleigh: o azul se desvia em todas as direções." },
        { texto: "No fim da tarde, a luz atravessa muito mais ar até chegar em você." },
        { texto: "Então o Sol não muda de cor. Muda a mistura de luz que chega aos seus olhos." },
        { texto: "Tem mais em fuiperguntar.com.br." },
      ],
    },
  },
};
const cliente = { slug: "fui-perguntar", nome: "Fui Perguntar", voz_padrao: "openai:onyx", marca: { rodape: "fuiperguntar.com.br", cartao_final: "Tem mais em fuiperguntar.com.br" } };

let entregue = null, concluido = null, pego = false;
const eventos = [];
const servidor = http.createServer((req, res) => {
  let corpo = [];
  req.on("data", (c) => corpo.push(c));
  req.on("end", () => {
    const buf = Buffer.concat(corpo);
    const json = () => JSON.parse(buf.toString() || "{}");
    const enviar = (obj, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer dfw_teste" && !req.url.startsWith("/upload") && !req.url.startsWith("/arquivo")) return enviar({ erro: "token" }, 401);
    if (req.url.endsWith("/worker/pegar")) { const r = pego ? { pedido: null } : { pedido, cliente }; pego = true; return enviar(r); }
    if (req.url.endsWith("/worker/progresso")) { const j = json(); eventos.push(`${j.etapa} ${j.progresso}% ${j.mensagem ?? ""}`); return enviar({ ok: true }); }
    if (req.url.endsWith("/worker/upload-url")) return enviar({ upload_url: `http://127.0.0.1:${porta}/upload`, url_final: `http://127.0.0.1:${porta}/arquivo/video.mp4` });
    if (req.url === "/upload") { entregue = buf; fs.writeFileSync(saidaFinal, buf); return enviar({ ok: true }); }
    if (req.url.endsWith("/worker/concluir")) { concluido = json(); return enviar({ ok: true }); }
    if (req.url.startsWith("/arquivo/")) { const f = path.join(pastaAssets, decodeURIComponent(req.url.slice(9))); res.writeHead(200); return res.end(fs.readFileSync(f)); }
    enviar({ erro: "rota" }, 404);
  });
});
let porta;
await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
porta = servidor.address().port;

// Simula OpenAI e Pexels
const fetchReal = globalThis.fetch;
let nVoz = 0;
globalThis.fetch = async (url, op = {}) => {
  const u = String(url);
  if (u.includes("api.openai.com/v1/audio/speech")) {
    const wav = fs.readFileSync(path.join(pastaAssets, audios[nVoz++ % audios.length]));
    return new Response(wav, { status: 200 });
  }
  if (u.includes("api.openai.com/v1/chat/completions")) {
    const cenas = JSON.parse(JSON.parse(op.body).messages[1].content).cenas;
    const buscas = cenas.map((c) => ({ i: c.i, busca: ["blue sky clouds", "ocean horizon", "light prism", "sunset city", "sun rays", "eyes closeup"][c.i % 6] }));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ buscas }) } }] });
  }
  if (u.includes("api.pexels.com/videos/search")) {
    const q = new URL(u).searchParams.get("query");
    const k = [...q].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    if (k % 3 === 0) return Response.json({ videos: [] }); // força cair na foto
    const lista = videos.map((v, j) => ({ id: j + 1, duration: 10, url: `pexels/${v}`, user: { name: "teste" }, video_files: [{ file_type: "video/mp4", width: 1080, height: 1920, link: `http://127.0.0.1:${porta}/arquivo/${v}` }] }));
    return Response.json({ videos: lista });
  }
  if (u.includes("api.pexels.com/v1/search")) {
    const lista = fotos.map((f, j) => ({ id: j + 1, photographer: "teste", url: `pexels/${f}`, src: { portrait: `http://127.0.0.1:${porta}/arquivo/${f}` } }));
    return Response.json({ photos: lista });
  }
  return fetchReal(url, op);
};

process.env.FABRICA_URL = `http://127.0.0.1:${porta}`;
process.env.FABRICA_WORKER_TOKEN = "dfw_teste";
process.env.OPENAI_API_KEY = "sk-teste";
process.env.PEXELS_API_KEY = "teste";

const t0 = Date.now();
const { produzir } = await import("../src/index.mjs");
const { pegarPedido, concluir } = await import("../src/api.mjs");
const { pedido: p, cliente: c } = await pegarPedido();
const r = await produzir(p, c);
await concluir({ pedido_id: p.id, ...r });
servidor.close();

console.log("\nEVENTOS:\n" + eventos.join("\n"));
console.log("\nCONCLUIR:", JSON.stringify({ ...concluido, resultado: { ...concluido.resultado, cenas: concluido.resultado.cenas.map((x) => `${x.cena}:${x.visual}:${x.busca}`) } }, null, 1));
console.log(`\nentregue: ${entregue ? (entregue.length / 1048576).toFixed(1) + " MB" : "NÃO"} em ${Math.round((Date.now() - t0) / 1000)} s`);
