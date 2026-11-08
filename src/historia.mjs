// Formato historia_ilustrada: cenas com clipe LTX (imagem como 1º quadro) ou cartela, falas por personagem,
// música com ducking, legenda queimada, vídeo 16:9 + short 9:16.
// Fase 1 (sem GPU): prepararHistoria gera as vozes e calcula a duração de cada clipe.
// Fase 2 (GPU, no pod): os clipes são gerados pelo ltx/lote_gpu.py.
// Fase 3 (sem GPU): montarHistoria junta tudo, confere e entrega.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, duracao, baixar, log } from "./util.mjs";
import { vozElevenLabs } from "./voz.mjs";
import { conferir } from "./conferencia.mjs";
import { progresso, enviarArquivo } from "./api.mjs";

const FONTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fonts");
const FONTE = path.join(FONTES, "Inter-Bold.otf");
const W = 1280, H = 720, FPS = 24;
const ENTRADA = 0.3; // respiro antes da 1ª fala da cena
const ENTRE_FALAS = 0.25;
const FADE = 0.15; // 0,15 s de saída + 0,15 s de entrada = 0,3 s entre cenas
export const CLIPE_MIN = 5, CLIPE_MAX = 10;
const CARTELA_FINAL_SHORT = "A história completa está no canal e em fuiperguntar.com.br";

const nCena = (c, i) => (/^\d+$/.test(String(c.id)) ? Number(c.id) : i + 1);
const segura = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_");

function quebrar(texto, max) {
  const linhas = [];
  let atual = "";
  for (const p of String(texto).split(/\s+/)) {
    if ((atual + " " + p).trim().length > max && atual) { linhas.push(atual); atual = p; }
    else atual = (atual + " " + p).trim();
  }
  if (atual) linhas.push(atual);
  return linhas.join("\n");
}

/** Gera as vozes de todas as falas e devolve o plano da história (sem GPU). */
export async function prepararHistoria(pedido, pasta) {
  const e = pedido.entrada || {};
  const cenas = e.cenas || [];
  if (!cenas.length) throw new Error("historia_ilustrada sem cenas");
  let custo = 0;
  const plano = [];
  for (let i = 0; i < cenas.length; i++) {
    const c = cenas[i];
    const falas = [];
    for (let k = 0; k < (c.falas || []).length; k++) {
      const f = c.falas[k];
      const bruto = path.join(pasta, `fala-${segura(c.id)}-${k}.mp3`);
      if (f.audio_url) await baixar(f.audio_url, bruto);
      else if (f.voz_id && f.texto) custo += (await vozElevenLabs(f.texto, f.voz_id, bruto)).custo_usd;
      else throw new Error(`cena ${c.id}, fala ${k + 1}: precisa de voz_id + texto ou audio_url`);
      const wav = path.join(pasta, `fala-${segura(c.id)}-${k}.wav`);
      await ffmpeg(["-i", bruto, "-ar", "44100", "-ac", "2", wav]);
      falas.push({ arquivo: wav, dur: await duracao(wav), texto: f.texto || "", falante: f.falante || "" });
    }
    const audio = falas.reduce((s, f) => s + f.dur, 0) + ENTRE_FALAS * Math.max(0, falas.length - 1);
    const precisa = falas.length ? ENTRADA + audio + 0.3 : 0; // = falas + 0,6 s
    const tipo = c.tipo === "cartela" ? "cartela" : "clipe";
    const durClipe = tipo === "clipe" ? Math.min(CLIPE_MAX, Math.max(CLIPE_MIN, precisa)) : 0;
    const durCena = tipo === "clipe" ? Math.max(durClipe, precisa) : falas.length ? Math.max(3, precisa) : 3;
    plano.push({ id: String(c.id), n: nCena(c, i), tipo, falas, durClipe, durCena, congelado: Math.max(0, durCena - durClipe),
      imagem_url: c.imagem_url, prompt: c.prompt_movimento, texto_cartela: c.texto_cartela });
  }
  return { plano, custo_voz: custo };
}

/** Lista de clipes que a GPU precisa gerar para este pedido. */
export const trabalhosGpu = (pedido, plano) =>
  plano.filter((c) => c.tipo === "clipe").map((c) => ({
    pedido_id: pedido.id, cena: c.id, seed: 1000 + c.n, imagem_url: c.imagem_url, prompt: c.prompt, dur: Number(c.durClipe.toFixed(3)),
    nome: `clipes/cena-${segura(c.id)}.mp4`,
  }));

async function segmentoCartela(texto, d, pasta, nome) {
  const txt = path.join(pasta, `${nome}.txt`);
  fs.writeFileSync(txt, quebrar(texto, 30));
  const saida = path.join(pasta, `${nome}.mp4`);
  await ffmpeg([
    "-f", "lavfi", "-i", `color=c=0x0f0f14:s=${W}x${H}:r=${FPS}:d=${d.toFixed(3)}`,
    "-vf", `drawtext=fontfile=${FONTE}:textfile=${txt}:fontcolor=white:fontsize=60:line_spacing=16:text_align=C:x=(w-text_w)/2:y=(h-text_h)/2,` +
      `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(d - FADE).toFixed(3)}:d=${FADE},format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS), saida,
  ]);
  return saida;
}

// Clipe LTX + congelamento do último quadro com zoom lento quando a fala passa de 10 s.
async function segmentoClipe(clipe, c, pasta, nome) {
  const saida = path.join(pasta, `${nome}.mp4`);
  const base = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`;
  if (c.congelado > 0.05) {
    const quadro = path.join(pasta, `${nome}-ultimo.png`);
    await ffmpeg(["-sseof", "-0.1", "-i", clipe, "-frames:v", "1", "-update", "1", quadro]);
    const n = Math.ceil(c.congelado * FPS);
    const W2 = W * 2, H2 = H * 2;
    const cong = path.join(pasta, `${nome}-cong.mp4`);
    await ffmpeg([
      "-loop", "1", "-i", quadro, "-t", c.congelado.toFixed(3),
      "-vf", `scale=${W2}:${H2},zoompan=z='1+0.06*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p`,
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", cong,
    ]);
    const lista = path.join(pasta, `${nome}-lista.txt`);
    const parte1 = path.join(pasta, `${nome}-p1.mp4`);
    await ffmpeg(["-i", clipe, "-t", c.durClipe.toFixed(3), "-vf", `${base},format=yuv420p`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", parte1]);
    fs.writeFileSync(lista, `file '${parte1}'\nfile '${cong}'\n`);
    const junto = path.join(pasta, `${nome}-junto.mp4`);
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", lista, "-c", "copy", junto]);
    clipe = junto;
  }
  await ffmpeg([
    "-i", clipe, "-t", c.durCena.toFixed(3),
    "-vf", `${base},tpad=stop_mode=clone:stop_duration=1,trim=duration=${c.durCena.toFixed(3)},` +
      `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(c.durCena - FADE).toFixed(3)}:d=${FADE},format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS), saida,
  ]);
  return saida;
}

// Áudio da cena: 0,3 s de respiro, falas em sequência com 0,25 s entre elas, silêncio até o fim da cena.
async function audioCena(c, pasta, nome) {
  const saida = path.join(pasta, `${nome}.wav`);
  if (!c.falas.length) {
    await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", c.durCena.toFixed(3), saida]);
    return saida;
  }
  const args = [], partes = [];
  let t = ENTRADA;
  c.falas.forEach((f, k) => {
    args.push("-i", f.arquivo);
    const ms = Math.round(t * 1000);
    partes.push(`[${k}:a]adelay=${ms}|${ms}[a${k}]`);
    f.inicio = t;
    t += f.dur + ENTRE_FALAS;
  });
  const mix = c.falas.map((_, k) => `[a${k}]`).join("");
  await ffmpeg([...args, "-filter_complex",
    `${partes.join(";")};${mix}amix=inputs=${c.falas.length}:normalize=0,apad,atrim=0:${c.durCena.toFixed(3)}[s]`,
    "-map", "[s]", "-ar", "44100", "-ac", "2", saida]);
  return saida;
}

const ts = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${x}`;
};
const assTexto = (t) => t.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();

function legendasDaFala(f, inicioCena) {
  const palavras = (f.texto || "").split(/\s+/).filter(Boolean);
  const blocos = [];
  for (let k = 0; k < palavras.length; k += 6) blocos.push(palavras.slice(k, k + 6).join(" "));
  const total = blocos.reduce((s, b) => s + b.length, 0) || 1;
  let t = inicioCena + f.inicio;
  return blocos.map((b) => { const d = (f.dur * b.length) / total; const ev = [t, t + d, b]; t += d; return ev; });
}

function arquivoAss(legendas, w, h, fonte, margemV, extra = "") {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    `Style: L,Inter,${fonte},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,60,60,${margemV},1\n\n` +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    legendas.map(([a, b, x]) => `Dialogue: 0,${ts(a)},${ts(b)},L,,0,0,0,,${assTexto(x)}`).join("\n") + extra + "\n";
}

// Voz + música com ducking + loudness -14 LUFS.
async function mixarAudio(voz, musicaUrl, musicaDb, pasta, nome) {
  const saida = path.join(pasta, `${nome}-mix.wav`);
  if (!musicaUrl) {
    await ffmpeg(["-i", voz, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", "44100", "-ac", "2", saida]);
    return saida;
  }
  const musica = path.join(pasta, "musica");
  if (!fs.existsSync(musica)) await baixar(musicaUrl, musica);
  const d = await duracao(voz);
  await ffmpeg([
    "-i", voz, "-stream_loop", "-1", "-i", musica, "-filter_complex",
    `[1:a]atrim=0:${d.toFixed(3)},aformat=channel_layouts=stereo,volume=${musicaDb}dB[m];` +
      `[0:a]asplit=2[v][sc];[m][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=500[md];` +
      `[v][md]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[s]`,
    "-map", "[s]", "-t", d.toFixed(3), "-ar", "44100", "-ac", "2", saida,
  ]);
  return saida;
}

async function codificar(video, audio, ass, saida, maxMB, extraVf = "") {
  const dur = await duracao(audio);
  const kbps = Math.max(800, Math.min(4000, Math.floor(((maxMB * 0.92 * 8 * 1024) / dur) - 192)));
  await ffmpeg([
    "-i", video, "-i", audio,
    "-vf", `${extraVf}ass=${ass}:fontsdir=${FONTES}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", saida,
  ]);
}

/** Monta video.mp4 + short.mp4, confere e entrega. clipes: Map cena -> arquivo local. */
export async function montarHistoria(pedido, plano, clipes, pasta, extras = {}) {
  const e = pedido.entrada || {};
  const regras = [];
  const segs = [], auds = [], legendas = [], tempos = [], parados = [];
  let t = 0;
  await progresso(pedido.id, "montagem", 70, `Montando ${plano.length} cenas`);
  for (let i = 0; i < plano.length; i++) {
    const c = plano[i];
    const nome = `cena-${String(i).padStart(3, "0")}`;
    let seg;
    if (c.tipo === "cartela") {
      seg = await segmentoCartela(c.texto_cartela || "", c.durCena, pasta, nome);
      parados.push({ inicio: t, fim: t + c.durCena });
    } else {
      const arq = clipes.get(c.id);
      if (!arq) throw new Error(`cena ${c.id}: clipe não foi gerado pela GPU`);
      const real = await duracao(arq);
      const ok = Math.abs(real - c.durClipe) <= 0.15;
      regras.push({ regra: `clipe_duracao_cena_${c.id}`, ok, detalhe: `${real.toFixed(2)} s (previsto ${c.durClipe.toFixed(2)} s)` });
      seg = await segmentoClipe(arq, c, pasta, nome);
      if (c.congelado > 0.05) parados.push({ inicio: t + c.durClipe, fim: t + c.durCena });
    }
    segs.push(seg);
    auds.push(await audioCena(c, pasta, nome));
    for (const f of c.falas) legendas.push(...legendasDaFala(f, t));
    tempos.push({ cena: c.id, inicio: t, fim: t + c.durCena, clipe: seg, audio: auds[auds.length - 1], c });
    t += c.durCena;
  }
  const lista = (arqs, n) => { const f = path.join(pasta, n); fs.writeFileSync(f, arqs.map((s) => `file '${s}'`).join("\n")); return f; };
  const video = path.join(pasta, "historia-v.mp4"), voz = path.join(pasta, "historia-a.wav");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", lista(segs, "v.txt"), "-c", "copy", video]);
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", lista(auds, "a.txt"), "-c", "copy", voz]);
  const mix = await mixarAudio(voz, e.musica_url, Number(e.musica_volume ?? -20), pasta, "historia");
  const ass = path.join(pasta, "historia.ass");
  fs.writeFileSync(ass, arquivoAss(legendas, W, H, 48, 36));
  const final = path.join(pasta, "video.mp4");
  await codificar(video, mix, ass, final, 90);

  await progresso(pedido.id, "conferencia", 85, "Conferindo o vídeo");
  const conf = await conferir(final, { dims: { W, H }, duracaoEsperada: t, tempos, maxMB: 90, paradoPermitido: parados });
  regras.push(...conf.regras);

  // ---- short 9:16 ----
  let shortUrl = null, confShort = null;
  if (e.short?.cenas_ids?.length) {
    const sel = e.short.cenas_ids.map((id) => tempos.find((x) => x.cena === String(id))).filter(Boolean);
    if (sel.length) {
      const sp = path.join(pasta, "short");
      fs.mkdirSync(sp, { recursive: true });
      const sv = path.join(sp, "v.mp4"), sa = path.join(sp, "a.wav");
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", lista(sel.map((x) => x.clipe), "short/v.txt"), "-c", "copy", sv]);
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", lista(sel.map((x) => x.audio), "short/a.txt"), "-c", "copy", sa]);
      const corpo = Math.min(57, sel.reduce((s, x) => s + (x.fim - x.inicio), 0));
      const fim = 3;
      // vídeo vertical: fundo desfocado + quadro central; título nos 3 primeiros segundos; cartela final
      const tit = path.join(sp, "titulo.txt");
      fs.writeFileSync(tit, String(e.short.titulo || e.titulo || "").replace(/\\n/g, "\n"));
      const cartTxt = path.join(sp, "cartela.txt");
      fs.writeFileSync(cartTxt, quebrar(e.short.cartela_final || CARTELA_FINAL_SHORT, 22));
      const vert = path.join(sp, "vert.mp4");
      await ffmpeg([
        "-i", sv, "-f", "lavfi", "-i", `color=c=0x0f0f14:s=1080x1920:r=${FPS}:d=${fim}`,
        "-filter_complex",
        `[0:v]trim=0:${corpo.toFixed(3)},setpts=PTS-STARTPTS,split=2[a][b];` +
          `[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.12[fundo];` +
          `[b]scale=1080:-2[frente];[fundo][frente]overlay=0:(H-h)/2,` +
          `drawtext=fontfile=${FONTE}:textfile=${tit}:fontcolor=white:fontsize=68:line_spacing=14:text_align=C:borderw=5:bordercolor=black:x=(w-text_w)/2:y=230:enable='lt(t,3)',setsar=1,format=yuv420p[corpo];` +
          `[1:v]drawtext=fontfile=${FONTE}:textfile=${cartTxt}:fontcolor=white:fontsize=70:line_spacing=18:text_align=C:x=(w-text_w)/2:y=(h-text_h)/2,fade=t=in:st=0:d=0.3,setsar=1,format=yuv420p[fim];` +
          `[corpo][fim]concat=n=2:v=1:a=0[v]`,
        "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS), vert,
      ]);
      const sa2 = path.join(sp, "a2.wav");
      await ffmpeg(["-i", sa, "-af", `atrim=0:${corpo.toFixed(3)},afade=t=out:st=${Math.max(0, corpo - 0.4).toFixed(3)}:d=0.4,apad`, "-t", (corpo + fim).toFixed(3), "-ar", "44100", "-ac", "2", sa2]);
      const smix = await mixarAudio(sa2, e.musica_url, Number(e.musica_volume ?? -20), sp, "short");
      // legendas do short: as mesmas falas, deslocadas para a nova linha do tempo
      const legS = [];
      let base = 0;
      for (const x of sel) {
        for (const f of x.c.falas) for (const [a, b, txt] of legendasDaFala(f, base)) if (a < corpo) legS.push([a, Math.min(b, corpo), txt]);
        base += x.fim - x.inicio;
      }
      const sass = path.join(sp, "short.ass");
      fs.writeFileSync(sass, arquivoAss(legS, 1080, 1920, 64, 520));
      const shortFinal = path.join(pasta, "short.mp4");
      await codificar(vert, smix, sass, shortFinal, 60);
      confShort = await conferir(shortFinal, { dims: { W: 1080, H: 1920 }, duracaoEsperada: corpo + fim, maxMB: 60, rotulo: "short_" });
      const ds = confShort.resultado.duracao_seg;
      confShort.regras.push({ regra: "short_duracao_45_60", ok: ds >= 45 && ds <= 60.5, detalhe: `${ds} s` });
      regras.push(...confShort.regras);
      if (!confShort.regras.some((r) => !r.ok && /formato|tem_audio|tamanho/.test(r.regra)))
        shortUrl = await enviarArquivo(pedido.id, "short.mp4", shortFinal);
    }
  }

  const falhas = regras.filter((r) => !r.ok);
  const graves = conf.status === "falhou";
  const status = graves ? "falhou" : falhas.length ? "revisar" : "pronto";
  let video_url = null;
  if (!graves) {
    await progresso(pedido.id, "entrega", 95, "Enviando o vídeo");
    video_url = await enviarArquivo(pedido.id, "video.mp4", final);
  }
  log(`historia ${pedido.id.slice(0, 8)}…: ${status} (${t.toFixed(1)} s)`);
  return {
    status,
    resultado: { ...conf.resultado, video_url, short_url: shortUrl, short_duracao_seg: confShort?.resultado?.duracao_seg, cenas: plano.length, ...extras },
    conferencia: { regras },
    erro: falhas.length ? falhas.map((r) => `${r.regra}: ${r.detalhe}`).join("; ").slice(0, 1000) : null,
  };
}
