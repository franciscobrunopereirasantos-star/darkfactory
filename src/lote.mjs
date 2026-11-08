// Worker de LOTE: pega um lote fechado, prepara as vozes, liga a GPU uma vez só para todos os clipes,
// desliga e monta cada pedido fora da GPU. Um pedido com problema vira "revisar" e o lote segue.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { concluir, progresso } from "./api.mjs";
import { fetchComRetry, log, baixar, duracao } from "./util.mjs";
import { prepararHistoria, trabalhosGpu, montarHistoria } from "./historia.mjs";
import { produzir } from "./index.mjs";
import { garantirVolume, ligarPod, esperarPod, estimarCusto } from "./runpod.mjs";

const BASE = (process.env.FABRICA_URL || "").replace(/\/$/, "");
const TOKEN = process.env.FABRICA_WORKER_TOKEN || "";

async function chamar(caminho, corpo) {
  const r = await fetchComRetry(`${BASE}/api/public/fabrica/worker/${caminho}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(corpo ?? {}),
  });
  const texto = await r.text();
  let json = {};
  try { json = texto ? JSON.parse(texto) : {}; } catch { json = { erro: texto.slice(0, 300) }; }
  if (!r.ok) throw new Error(`API ${caminho} ${r.status}: ${json.erro || texto.slice(0, 300)}`);
  return json;
}
const semNulos = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const avisoLote = (lote_id, etapa, mensagem, dados) =>
  chamar("lote/progresso", semNulos({ lote_id, etapa, mensagem, dados })).catch((e) => log("aviso do lote não registrado:", e.message));
const r4 = (x) => Math.round(x * 10000) / 10000;

async function main() {
  let pego;
  try { pego = await chamar("lote/pegar", {}); }
  catch (e) { if (/ 404/.test(e.message)) { log("rota de lote ainda não publicada"); return; } throw e; }
  const { lote, pedidos = [], motivo } = pego;
  if (!lote) { log("nenhum lote para produzir", motivo ? `(${motivo})` : ""); return; }
  const t0 = Date.now();
  const cliente = lote.cliente || {};
  log(`lote ${lote.ref} (${lote.id.slice(0, 8)}…): ${pedidos.length} pedidos, teto US$ ${lote.teto_usd}`);
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), `lote-${lote.id.slice(0, 8)}-`));
  const estado = new Map(); // pedido_id -> { pedido, pasta, plano, jobs, custoVoz, erro, final }

  const encerrar = async (p, r) => {
    const st = estado.get(p.id);
    st.final = r;
    try { await concluir({ pedido_id: p.id, ...r }); }
    catch (e) { log(`não consegui concluir ${p.id.slice(0, 8)}…:`, e.message); }
  };
  const revisar = (p, motivoTxt, extra = {}) => encerrar(p, { status: "revisar", erro: motivoTxt.slice(0, 1000), ...extra });

  // 1) preparar: vozes e plano de cada história (sem GPU)
  const jobs = [];
  for (const p of pedidos) {
    const pasta = path.join(raiz, p.id.slice(0, 8));
    fs.mkdirSync(pasta, { recursive: true });
    estado.set(p.id, { pedido: p, pasta });
    if (p.formato !== "historia_ilustrada") continue;
    try {
      await progresso(p.id, "voz", 10, "Gerando as vozes das falas");
      const { plano, custo_voz } = await prepararHistoria(p, pasta);
      const js = trabalhosGpu(p, plano);
      Object.assign(estado.get(p.id), { plano, jobs: js, custoVoz: custo_voz });
      jobs.push(...js);
      await progresso(p.id, "voz", 30, `Vozes prontas; ${js.length} clipes na fila da GPU`, { clipes: js.length, segundos_clipe: r4(js.reduce((s, j) => s + j.dur, 0)) });
    } catch (e) {
      log(`pedido ${p.id.slice(0, 8)}… não preparou:`, e.message);
      await revisar(p, `preparo falhou: ${e.message}`);
    }
  }

  // 2) teto de custo
  const segClipe = jobs.reduce((s, j) => s + j.dur, 0);
  const estimativa = jobs.length ? estimarCusto(segClipe) : 0;
  await avisoLote(lote.id, "estimativa", `${jobs.length} clipes, ${segClipe.toFixed(1)} s de clipe; estimativa de GPU US$ ${estimativa.toFixed(2)} (teto US$ ${lote.teto_usd})`,
    { clipes: jobs.length, segundos_clipe: r4(segClipe), estimativa_usd: r4(estimativa) });
  if (estimativa > Number(lote.teto_usd || 15)) {
    const m = `GPU não ligada: estimativa US$ ${estimativa.toFixed(2)} passa do teto de US$ ${lote.teto_usd}`;
    for (const [, st] of estado) if (!st.final) await revisar(st.pedido, m);
    await chamar("lote/concluir", { lote_id: lote.id, status: "revisar", motivo: m, tempo_total_s: Math.round((Date.now() - t0) / 1000) });
    return;
  }

  // 3) GPU: uma ligada só para todos os clipes do lote
  let gpu = null, minutos = 0, custoGpu = 0;
  if (jobs.length) {
    let volume = null;
    try { volume = await garantirVolume(); } catch (e) { log("volume de rede indisponível, segue sem:", e.message); }
    const JOBS_GZ = zlib.gzipSync(Buffer.from(JSON.stringify(jobs))).toString("base64");
    const pod = await ligarPod({
      nome: `lote-${lote.ref}`.slice(0, 60),
      cmd: "bash -c 'curl -sL https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/lote_pod.sh | bash'",
      env: { FABRICA_URL: BASE, FABRICA_WORKER_TOKEN: TOKEN, LOTE_ID: lote.id, RUNPOD_API_KEY: process.env.RUNPOD_API_KEY, HF_TOKEN: process.env.HF_TOKEN, JOBS_GZ },
      volume,
    });
    gpu = pod.gpu;
    await avisoLote(lote.id, "gpu", `GPU ligada: ${pod.gpu} (US$ ${pod.costPerHr}/h) ${pod.comVolume ? "com volume de rede" : "sem volume"}`, { gpu: pod.gpu, custo_hora: pod.costPerHr, com_volume: pod.comVolume });
    const maxMin = Math.min(300, 30 + (segClipe * 45) / 60 + (pod.comVolume ? 15 : 30));
    minutos = await esperarPod(pod, maxMin);
    custoGpu = (minutos / 60) * pod.costPerHr;
    await avisoLote(lote.id, "gpu_desligada", `GPU desligada após ${minutos.toFixed(1)} min; custo US$ ${custoGpu.toFixed(2)}`, { minutos: r4(minutos), custo_usd: r4(custoGpu) });
  }

  // 4) baixar os clipes e montar cada pedido (sem GPU)
  for (const p of pedidos) {
    const st = estado.get(p.id);
    if (st.final) continue;
    const tp = Date.now();
    try {
      let r;
      if (p.formato === "historia_ilustrada") {
        const clipes = new Map();
        const faltando = [];
        for (const j of st.jobs) {
          const url = `${BASE}/api/public/fabrica/arquivo/${cliente.slug}/${p.id}/${j.nome}`;
          const arq = path.join(st.pasta, `ltx-${path.basename(j.nome)}`);
          try { await baixar(url, arq); if ((await duracao(arq)) > 0) clipes.set(j.cena, arq); } catch { faltando.push(j.cena); }
        }
        const segP = st.jobs.reduce((s, j) => s + j.dur, 0);
        const parte = segClipe ? segP / segClipe : 0;
        const extras = { gpu, segundos_gpu: Math.round(minutos * 60 * parte), tempo_total_s: null };
        if (faltando.length) {
          await revisar(p, `a GPU não entregou o clipe das cenas ${faltando.join(", ")}`, { custo_usd: r4(st.custoVoz + custoGpu * parte) });
          continue;
        }
        r = await montarHistoria(p, st.plano, clipes, st.pasta, extras);
        r.custo_usd = r4(st.custoVoz + custoGpu * parte);
      } else {
        r = await produzir(p, cliente);
      }
      r.resultado = { ...(r.resultado || {}), tempo_total_s: Math.round((Date.now() - tp) / 1000) };
      await encerrar(p, r);
      log(`pedido ${p.id.slice(0, 8)}… (${p.formato}): ${r.status}`);
    } catch (e) {
      log(`pedido ${p.id.slice(0, 8)}… falhou na montagem:`, e.message);
      await revisar(p, `montagem falhou: ${e.message}`);
    }
  }

  // 5) fechamento do lote
  const finais = [...estado.values()].map((s) => s.final?.status || "revisar");
  const status = finais.every((x) => x === "pronto") ? "pronto" : finais.every((x) => x === "falhou") ? "falhou" : "revisar";
  const custoTotal = [...estado.values()].reduce((s, x) => s + Number(x.final?.custo_usd || 0), 0);
  await chamar("lote/concluir", semNulos({
    lote_id: lote.id, status,
    motivo: status === "pronto" ? null : `${finais.filter((x) => x !== "pronto").length} pedido(s) para revisar`,
    segundos_gpu: Math.round(minutos * 60), custo_usd: r4(Math.max(custoTotal, custoGpu)), gpu,
    tempo_total_s: Math.round((Date.now() - t0) / 1000),
  }));
  log(`lote ${lote.ref}: ${status} em ${Math.round((Date.now() - t0) / 60000)} min; GPU ${minutos.toFixed(1)} min, US$ ${custoGpu.toFixed(2)}`);
  fs.rmSync(raiz, { recursive: true, force: true });
}

main().catch((e) => { log("erro geral do lote:", e.message); process.exit(1); });
