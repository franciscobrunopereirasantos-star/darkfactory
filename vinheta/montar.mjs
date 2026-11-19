// Monta o index.html da vinheta Luma e Malu a partir das durações reais dos clipes.
// Uso: node vinheta/montar.mjs <pasta-do-projeto>   (a pasta precisa ter assets/ baixados)
// Arquivos esperados em assets/: v1.mp4 (Malu, espelhar), v2.mp4 (Luma), v3.mp4 (as duas, espelhar),
// m1.mp4 m2.mp4 m3.mp4 (cortes rápidos), v3-ultimo.png (último quadro do v3, já espelhado no CSS),
// musica.mp3, pop.wav, plim.wav, assinatura.wav, whoosh.wav
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
const proj = process.argv[2] || aqui;
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(proj, "assets", f)]).toString().trim());
const r = (x) => Math.round(x * 1000) / 1000;

const ESPELHAR = { v1: true, v2: false, v3: true }; // ursinho no braço DIREITO da Malu
const INTRO = 1.5;            // pegadas da marca
const CORTE = 0.8;            // cada corte rápido da montagem
const LOGO_DEPOIS = 1.4;      // logo entra 1,4 s depois do início do v3 (após "Luma e Malu!")
const SEGURAR_FINAL = 2.6;    // logo + frase parados antes do fim

const d1 = dur("v1.mp4"), d2 = dur("v2.mp4"), d3 = dur("v3.mp4");
const t1 = INTRO, t2 = r(t1 + d1), tm = r(t2 + d2), t3 = r(tm + 3 * CORTE);
const tLogo = r(t3 + LOGO_DEPOIS);
const fim = r(Math.max(t3 + d3, tLogo + 1.6 + SEGURAR_FINAL));
const dFinal = r(fim - tLogo);
const temStill = t3 + d3 < fim; // v3 acabou antes do fim → segura o último quadro

const video = (id, src, start, d, { espelhar = false, audio = true, z = 1, mediaStart = 0 } = {}) =>
  `      <video id="${id}" class="clip" src="assets/${src}" data-start="${start}" data-duration="${r(d)}"${mediaStart ? ` data-media-start="${mediaStart}"` : ""} data-track-index="${z}" ${audio ? 'data-has-audio="true"' : "muted"} playsinline style="position:absolute;left:0;top:0;width:1920px;height:1080px;object-fit:cover;z-index:${z};${espelhar ? "transform:scaleX(-1);" : ""}"></video>`;
const host = (id, start, d, z) =>
  `      <div id="${id}" data-composition-id="${id}" data-composition-src="compositions/${id}.html" data-start="${start}" data-duration="${r(d)}" data-track-index="${z}" data-track-kind="graphics" data-width="1920" data-height="1080" style="z-index:${z}"></div>`;
const som = (id, src, start, vol, extra = "") =>
  `      <audio id="${id}" class="clip" src="assets/${src}" data-start="${r(start)}" data-volume="${vol}" data-track-index="20"${extra}></audio>`;

const html = `<!doctype html>
<html lang="pt-BR" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="assets/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #000; }
      #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; }
      #fundo { position: absolute; inset: 0; background: #f2b56b; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${fim}" data-width="1920" data-height="1080" data-fps="30">
      <div id="fundo"></div>
${host("intro", 0, INTRO + 0.1, 30)}
${video("v1", "v1.mp4", t1, d1, { espelhar: ESPELHAR.v1, z: 2 })}
${host("nome-malu", r(t1 + 0.5), d1 - 0.5, 31)}
${video("v2", "v2.mp4", t2, d2, { espelhar: ESPELHAR.v2, z: 3 })}
${host("nome-luma", r(t2 + 0.35), d2 - 0.35, 32)}
${video("m1", "m1.mp4", tm, CORTE, { audio: false, z: 4, mediaStart: 0.6 })}
${video("m2", "m2.mp4", r(tm + CORTE), CORTE, { audio: false, z: 5, mediaStart: 0.9 })}
${video("m3", "m3.mp4", r(tm + 2 * CORTE), CORTE, { audio: false, z: 6, mediaStart: 0.6 })}
${video("v3", "v3.mp4", t3, d3, { espelhar: ESPELHAR.v3, z: 7 })}
${temStill ? `      <img id="v3-still" class="clip" src="assets/v3-ultimo.png" data-start="${r(t3 + d3)}" data-duration="${r(fim - (t3 + d3))}" data-track-index="8" style="position:absolute;left:0;top:0;width:1920px;height:1080px;object-fit:cover;z-index:8;${ESPELHAR.v3 ? "transform:scaleX(-1);" : ""}" />` : ""}
${host("final", tLogo, dFinal, 33)}
${som("musica", "musica.mp3", 0, 0.32, ` data-duration="${fim}" data-fade-out="0.6"`)}
${som("sfx-pop", "pop.wav", t1 + 0.55, 0.9)}
${som("sfx-plim", "plim.wav", t2 + 0.95, 0.8)}
${som("sfx-whoosh1", "whoosh.wav", tm - 0.05, 0.7)}
${som("sfx-whoosh2", "whoosh2.wav", t3 - 0.05, 0.7)}
${som("sfx-assinatura", "assinatura.wav", tLogo + 1.3, 0.9)}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      // punch-in leve nos cortes rápidos (escala no wrapper não existe: usamos o próprio fundo parado)
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
writeFileSync(join(proj, "index.html"), html);

// saídas dos nomes: 0,25 s antes do fim do slot de cada um
mkdirSync(join(proj, "compositions"), { recursive: true });
const cena = (nome, saida) => {
  const s = readFileSync(join(aqui, "compositions", `${nome}.html`), "utf8").replace('"{{SAIDA}}"', String(r(saida)));
  writeFileSync(join(proj, "compositions", `${nome}.html`), s);
};
cena("nome-malu", d1 - 0.5 - 0.3);
cena("nome-luma", d2 - 0.35 - 0.3);
for (const f of ["intro.html", "final.html"]) {
  if (proj !== aqui) copyFileSync(join(aqui, "compositions", f), join(proj, "compositions", f));
}
console.log(JSON.stringify({ d1, d2, d3, t1, t2, tm, t3, tLogo, fim, temStill }));
