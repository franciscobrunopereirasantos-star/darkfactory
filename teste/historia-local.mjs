// Teste local da montagem da historia_ilustrada (sem GPU, sem ElevenLabs): falas e música por audio_url
// servidos por um servidor local, clipes sintéticos no lugar do LTX. Uso: node teste/historia-local.mjs <pasta>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const pasta = path.resolve(process.argv[2] || "/tmp/hist-teste");
fs.mkdirSync(pasta, { recursive: true });
const ff = (...a) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...a]);
// falas: tom com pausas curtas (simula fala); uma fala longa para forçar congelamento
const fala = (nome, d, f) => ff("-f", "lavfi", "-i", `sine=f=${f}:d=${d}`, "-af", "volume=0.5,apulsator=hz=3", "-ar", "44100", path.join(pasta, nome));
fala("f1.mp3", 2.2, 220); fala("f2.mp3", 3.1, 330); fala("f3.mp3", 6.5, 260); fala("f4.mp3", 5.8, 300);
ff("-f", "lavfi", "-i", "sine=f=110:d=30", "-af", "volume=0.6", path.join(pasta, "musica.mp3"));

const enviados = {};
const srv = http.createServer((req, res) => {
  let corpo = [];
  req.on("data", (c) => corpo.push(c));
  req.on("end", () => {
    const u = req.url;
    if (u.startsWith("/arq/")) { res.end(fs.readFileSync(path.join(pasta, u.slice(5)))); return; }
    if (u.includes("/worker/upload-url")) {
      const { nome } = JSON.parse(Buffer.concat(corpo));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ upload_url: `http://127.0.0.1:${porta}/put/${nome}`, url_final: `http://x/${nome}` }));
      return;
    }
    if (u.startsWith("/put/")) { enviados[u.slice(5)] = Buffer.concat(corpo).length; res.end("{}"); return; }
    res.setHeader("content-type", "application/json"); res.end("{}");
  });
});
await new Promise((ok) => srv.listen(0, ok));
const porta = srv.address().port;
process.env.FABRICA_URL = `http://127.0.0.1:${porta}`;
process.env.FABRICA_WORKER_TOKEN = "teste";
const A = (n) => `http://127.0.0.1:${porta}/arq/${n}`;

const { prepararHistoria, trabalhosGpu, montarHistoria } = await import("../src/historia.mjs");
const pedido = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  formato: "historia_ilustrada",
  entrada: {
    titulo: "Teste", aspecto: process.env.ASPECTO || "16:9", musica_url: A("musica.mp3"),
    cenas: [
      { id: "1", tipo: "cartela", texto_cartela: "Em 1998, uma caixa de busca mudou tudo", falas: [{ audio_url: A("f1.mp3"), texto: "Em mil novecentos e noventa e oito tudo mudou" }] },
      { id: "2", tipo: "clipe", imagem_url: "x", prompt_movimento: "x", falas: [{ audio_url: A("f2.mp3"), texto: "Ela digitou a pergunta e esperou" }, { audio_url: A("f1.mp3"), texto: "E a resposta veio" }] },
      { id: "3", tipo: "clipe", imagem_url: "x", prompt_movimento: "x", falas: [{ audio_url: A("f3.mp3"), texto: "Uma fala longa para testar o congelamento do último quadro com zoom lento" }, { audio_url: A("f4.mp3"), texto: "e continua falando bastante tempo" }] },
    ],
    ...(process.env.CORTES
      ? { cortes_verticais: [
          { id: "antes", cenas_ids: ["2", "3", "2", "3", "2", "3", "2"], chamada: "a história completa sai hoje às 19h" },
          { id: "junto", cenas_ids: ["2", "3", "2", "3", "2", "3"], chamada: "história completa no canal" },
          { id: "depois", cenas_ids: ["3", "2", "3", "2", "3", "2"], chamada: "assista a história completa no canal" },
        ] }
      : { short: { cenas_ids: ["2", "3", "2", "3", "2", "3"], titulo: "Como a busca\nmudou tudo" } }),
  },
};
const { plano } = await prepararHistoria(pedido, pasta);
console.log("plano:", plano.map((c) => ({ id: c.id, tipo: c.tipo, durClipe: c.durClipe.toFixed(2), durCena: c.durCena.toFixed(2), congelado: c.congelado.toFixed(2) })));
const jobs = trabalhosGpu(pedido, plano);
console.log("jobs:", jobs);
// clipes sintéticos com movimento (o LTX entregaria isso), já na duração exata
const clipes = new Map();
for (const j of jobs) {
  const arq = path.join(pasta, `clipe-${j.cena}.mp4`);
  ff("-f", "lavfi", "-i", `testsrc2=s=1280x720:r=24`, "-frames:v", String(Math.round(j.dur * 24)), "-c:v", "libx264", "-pix_fmt", "yuv420p", arq);
  clipes.set(j.cena, arq);
}
const r = await montarHistoria(pedido, plano, clipes, pasta);
console.log(JSON.stringify({ status: r.status, resultado: r.resultado, falhas: r.conferencia.regras.filter((x) => !x.ok), erro: r.erro }, null, 1));
console.log("enviados:", enviados);
srv.close();
