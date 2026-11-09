// Montagem: cenas (visual + áudio + texto) -> MP4 com legenda grande e rodapé da marca.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, duracao } from "./util.mjs";

const FONTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fonts");
const FONTE = path.join(FONTES, "Inter-Bold.otf");
const FPS = 30;
const PAUSA = 0.15; // respiro entre cenas

export const dimensoes = (aspecto) => (aspecto === "16:9" ? { W: 1920, H: 1080 } : { W: 1080, H: 1920 });

function quebrar(texto, max) {
  const linhas = [];
  let atual = "";
  for (const p of texto.split(/\s+/)) {
    if ((atual + " " + p).trim().length > max && atual) { linhas.push(atual); atual = p; }
    else atual = (atual + " " + p).trim();
  }
  if (atual) linhas.push(atual);
  return linhas.join("\n");
}

async function segmentoImagem(arquivo, d, W, H, i, saida) {
  const n = Math.ceil(d * FPS);
  // zoom lento, alternando entrar/sair
  const z = i % 2 ? `zoompan=z='1.12-0.12*on/${n}'` : `zoompan=z='1+0.12*on/${n}'`;
  const W2 = Math.round(W * 1.25), H2 = Math.round(H * 1.25);
  await ffmpeg([
    "-loop", "1", "-i", arquivo, "-t", d.toFixed(3),
    "-vf", `scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},${z}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", saida,
  ]);
}

async function segmentoVideo(arquivo, d, W, H, saida) {
  await ffmpeg([
    "-stream_loop", "-1", "-i", arquivo, "-t", d.toFixed(3),
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", saida,
  ]);
}

// Cartão liso escuro com texto (usado no cartão final da marca e quando não acha imagem)
async function segmentoCartao(texto, d, W, H, pasta, i, saida, destaque = false) {
  const txt = path.join(pasta, `cartao${i}.txt`);
  const vertical = H > W;
  fs.writeFileSync(txt, quebrar(texto, vertical ? 16 : 30));
  const tam = destaque ? (vertical ? 92 : 84) : vertical ? 72 : 64;
  await ffmpeg([
    "-f", "lavfi", "-i", `color=c=0x15121f:s=${W}x${H}:r=${FPS}:d=${d.toFixed(3)}`,
    "-vf",
    `drawbox=x=0:y=ih*0.62:w=iw:h=ih*0.38:color=0x7c3aed@0.18:t=fill,` +
      `drawtext=fontfile=${FONTE}:textfile=${txt}:fontcolor=white:fontsize=${tam}:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", saida,
  ]);
}

const ts = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${x}`;
};
const assTexto = (t) => t.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();

/**
 * cenas: [{ texto, audio, visual: { tipo, arquivo? }, semLegenda?, cartaoTexto? }]
 * marca: { rodape }
 */
export async function montar({ cenas, marca = {}, aspecto = "9:16", pasta, saida }) {
  const { W, H } = dimensoes(aspecto);
  const vertical = H > W;
  const segs = [], auds = [], legendas = [], tempos = [];
  let t = 0;

  for (let i = 0; i < cenas.length; i++) {
    const c = cenas[i];
    const fala = await duracao(c.audio);
    const d = fala + PAUSA;
    const seg = path.join(pasta, `seg${i}.mp4`);
    if (c.visual.tipo === "imagem") await segmentoImagem(c.visual.arquivo, d, W, H, i, seg);
    else if (c.visual.tipo === "video") await segmentoVideo(c.visual.arquivo, d, W, H, seg);
    else await segmentoCartao(c.cartaoTexto || c.texto, d, W, H, pasta, i, seg, Boolean(c.cartaoTexto));
    segs.push(seg);

    const aud = path.join(pasta, `aud${i}.wav`);
    await ffmpeg(["-i", c.audio, "-af", `apad=pad_dur=${PAUSA}`, "-t", d.toFixed(3), "-ar", "44100", "-ac", "2", aud]);
    auds.push(aud);

    // legenda em blocos de até 5 palavras, tempo proporcional ao nº de letras
    if (!c.semLegenda && c.visual.tipo !== "cartao") {
      const palavras = c.texto.split(/\s+/).filter(Boolean);
      const blocos = [];
      for (let k = 0; k < palavras.length; k += 5) blocos.push(palavras.slice(k, k + 5).join(" "));
      const total = blocos.reduce((s, b) => s + b.length, 0) || 1;
      let tb = t;
      for (const b of blocos) {
        const db = (fala * b.length) / total;
        legendas.push([tb, tb + db, b]);
        tb += db;
      }
    }
    tempos.push({ cena: i + 1, inicio: t, fim: t + d, cartao: Boolean(c.cartaoTexto) });
    t += d;
  }

  const lista = (arqs, nome) => {
    const f = path.join(pasta, nome);
    fs.writeFileSync(f, arqs.map((s) => `file '${s}'`).join("\n"));
    return f;
  };
  const video = path.join(pasta, "video.mp4");
  const audio = path.join(pasta, "audio.wav");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", lista(segs, "v.txt"), "-c", "copy", video]);
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", lista(auds, "a.txt"), "-c", "copy", audio]);

  // o rodapé some quando entra o cartão final (que já mostra o site)
  const fimRodape = tempos.find((x) => x.cartao)?.inicio ?? t;
  const fsL = vertical ? 78 : 64, mvL = vertical ? 560 : 120;
  const fsM = Math.round(fsL * 0.55);
  const ass =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    `Style: L,Inter,${fsL},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,2,80,80,${mvL},1\n` +
    `Style: M,Inter,${fsM},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,10,0,2,40,40,70,1\n\n` +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    legendas.map(([a, b, x]) => `Dialogue: 0,${ts(a)},${ts(b)},L,,0,0,0,,${assTexto(x).toUpperCase()}`).join("\n") +
    (marca.rodape ? `\nDialogue: 0,${ts(0)},${ts(fimRodape)},M,,0,0,0,,${assTexto(marca.rodape)}` : "") +
    "\n";
  const legenda = path.join(pasta, "leg.ass");
  fs.writeFileSync(legenda, ass);

  // Teto de tamanho (90 MB): limita o bitrate pela duração; se ainda passar, recodifica mais leve.
  const LIMITE_MB = 85;
  const codificar = (kbps) => ffmpeg([
    "-i", video, "-i", audio,
    "-vf", `ass=${legenda}:fontsdir=${FONTES}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", saida,
  ]);
  let kbps = Math.max(700, Math.min(6000, Math.floor((LIMITE_MB * 8 * 1024) / Math.max(t, 1)) - 170));
  await codificar(kbps);
  for (let i = 0; i < 2 && fs.statSync(saida).size > LIMITE_MB * 1048576; i++) {
    kbps = Math.max(500, Math.floor(kbps * 0.75));
    await codificar(kbps);
  }
  return { duracao: t, tempos };
}
