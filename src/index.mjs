// Worker da fábrica: pega pedidos na fila do DarkFactory, produz o vídeo e entrega.
// Roda no GitHub Actions (e depois na VPS). Sai quando a fila esvazia ou o tempo acaba.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pegarPedido, progresso, concluir, enviarArquivo } from "./api.mjs";
import { gerarVoz } from "./voz.mjs";
import { gerarBuscas, escolherVisual } from "./visual.mjs";
import { montar } from "./montagem.mjs";
import { conferir } from "./conferencia.mjs";
import { log, duracao } from "./util.mjs";

const MAX_MINUTOS = Number(process.env.MAX_MINUTOS || 40);
const MAX_PEDIDOS = Number(process.env.MAX_PEDIDOS || 20);
const FORMATOS = new Set(["short_narrado", "video_narrado"]);

// Executa tarefas com no máximo N ao mesmo tempo, mantendo a ordem do resultado.
async function emParalelo(itens, n, fn) {
  const saida = new Array(itens.length);
  let prox = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, itens.length) }, async () => {
      while (prox < itens.length) {
        const i = prox++;
        saida[i] = await fn(itens[i], i);
      }
    }),
  );
  return saida;
}

export async function produzir(pedido, cliente) {
  const entrada = pedido.entrada || {};
  const roteiro = entrada.roteiro || entrada;
  const formato = pedido.formato || entrada.formato;
  if (!FORMATOS.has(formato)) throw new Error(`formato ainda não suportado pelo worker: ${formato}`);
  const aspecto = entrada.aspecto || (formato === "video_narrado" ? "16:9" : "9:16");
  const vertical = aspecto === "9:16";
  const voz = entrada.voz || cliente?.voz_padrao || "openai:onyx";
  const marca = cliente?.marca || {};
  const cenasEntrada = (roteiro.cenas || []).filter((c) => c && c.texto && c.texto.trim());
  if (!cenasEntrada.length) throw new Error("roteiro sem cenas");

  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), `pedido-${pedido.id.slice(0, 8)}-`));
  let custo = 0;
  try {
    // 1) voz de cada cena (+ cartão final da marca)
    const cenas = cenasEntrada.map((c) => ({ ...c, texto: c.texto.trim() }));
    if (marca.cartao_final) cenas.push({ texto: marca.cartao_final, cartaoTexto: marca.rodape || marca.cartao_final, semLegenda: true, final: true });
    await progresso(pedido.id, "voz", 5, `Gerando voz de ${cenas.length} cenas`);
    await emParalelo(cenas, 4, async (c, i) => {
      const v = await gerarVoz(c.texto, voz, path.join(pasta, `voz${i}.mp3`));
      c.audio = v.arquivo;
      custo += v.custo_usd;
    });
    await progresso(pedido.id, "voz", 30, "Voz pronta");

    // 2) visual de cada cena
    await progresso(pedido.id, "visual", 35, "Escolhendo imagens");
    const normais = cenas.filter((c) => !c.final);
    const buscas = await gerarBuscas(roteiro.titulo || "", normais);
    const usados = new Set();
    // sequencial para não repetir clipe entre cenas
    for (let i = 0; i < normais.length; i++) {
      const c = normais[i];
      const d = await duracao(c.audio);
      c.visual = await escolherVisual({ cena: c, busca: buscas[i], vertical, duracao: d, usados, pasta, i });
      await progresso(pedido.id, "visual", 35 + (25 * (i + 1)) / normais.length, `Cena ${i + 1}: ${c.visual.tipo}${c.visual.busca ? ` (${c.visual.busca})` : ""}`);
    }
    for (const c of cenas) if (c.final) c.visual = { tipo: "cartao" };

    // 3) montagem
    await progresso(pedido.id, "montagem", 65, "Montando o vídeo");
    const saida = path.join(pasta, "final.mp4");
    const { duracao: durEsperada, tempos } = await montar({ cenas, marca, aspecto, pasta, saida });

    // 4) conferência
    await progresso(pedido.id, "conferencia", 85, "Conferindo");
    const conf = await conferir(saida, { aspecto, duracaoEsperada: durEsperada, tempos });
    const cenasInfo = cenas.map((c, i) => ({
      cena: i + 1,
      texto: c.texto,
      visual: c.visual?.tipo,
      busca: c.visual?.busca || null,
      fonte: c.visual?.fonte || null,
    }));
    if (cenas.some((c) => !c.final && c.visual?.tipo === "cartao")) {
      conf.regras.push({ regra: "todas_as_cenas_com_imagem", ok: false, detalhe: "alguma cena ficou sem imagem (cartão liso)" });
      if (conf.status === "pronto") conf.status = "revisar";
    }

    // 5) entrega
    let video_url = null;
    if (conf.status !== "falhou") {
      await progresso(pedido.id, "entrega", 92, "Enviando o vídeo");
      video_url = await enviarArquivo(pedido.id, "video.mp4", saida);
    }
    return {
      status: conf.status,
      resultado: { ...conf.resultado, video_url, cenas: cenasInfo },
      conferencia: { regras: conf.regras },
      erro: conf.status === "falhou" ? conf.regras.filter((r) => !r.ok).map((r) => `${r.regra}: ${r.detalhe}`).join("; ") : null,
      custo_usd: Math.round(custo * 10000) / 10000,
    };
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

async function main() {
  const inicio = Date.now();
  let feitos = 0;
  while (feitos < MAX_PEDIDOS && Date.now() - inicio < MAX_MINUTOS * 60_000) {
    const { pedido, cliente } = await pegarPedido();
    if (!pedido) {
      log("fila vazia");
      break;
    }
    log(`pedido ${pedido.id} (${pedido.formato}) de ${cliente?.slug ?? "?"}`);
    const t0 = Date.now();
    try {
      const r = await produzir(pedido, cliente);
      await concluir({ pedido_id: pedido.id, ...r });
      log(`pedido ${pedido.id}: ${r.status} em ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      log(`pedido ${pedido.id} falhou:`, e.message);
      try {
        await concluir({ pedido_id: pedido.id, status: "falhou", erro: e.message.slice(0, 1000) });
      } catch (e2) {
        log("não consegui marcar como falhou (volta para a fila sozinho em 25 min):", e2.message);
      }
    }
    feitos++;
  }
  log(`fim: ${feitos} pedido(s) em ${Math.round((Date.now() - inicio) / 1000)} s`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log("erro geral:", e.message);
    process.exit(1);
  });
}
