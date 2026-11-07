// Conferência automática antes de entregar: o vídeo só sai "pronto" se passar em tudo.
import fs from "node:fs";
import { ffprobeJson, ffmpegAnalise } from "./util.mjs";
import { dimensoes } from "./montagem.mjs";

export async function conferir(arquivo, { aspecto = "9:16", duracaoEsperada, tempos = [] }) {
  const { W, H } = dimensoes(aspecto);
  const info = await ffprobeJson(arquivo);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  const dur = Number(info.format.duration);
  const bytes = fs.statSync(arquivo).size;
  const regras = [];
  const add = (regra, ok, detalhe) => regras.push({ regra, ok, detalhe });

  add("formato", v && v.width === W && v.height === H, v ? `${v.width}×${v.height}` : "sem vídeo");
  add("tem_audio", Boolean(a), a ? `${a.codec_name} ${a.sample_rate} Hz` : "sem áudio");
  add(
    "duracao",
    dur >= 5 && dur <= 600 && (!duracaoEsperada || Math.abs(dur - duracaoEsperada) < 1.5),
    `${dur.toFixed(1)} s${duracaoEsperada ? ` (esperado ${duracaoEsperada.toFixed(1)} s)` : ""}`,
  );
  add("tamanho", bytes < 100 * 1024 * 1024, `${(bytes / 1048576).toFixed(1)} MB`);

  const cenaEm = (s) => tempos.find((x) => s >= x.inicio && s < x.fim)?.cena;

  // silêncio maior que 1,5 s (ignora o fim do vídeo)
  const sil = await ffmpegAnalise(["-i", arquivo, "-af", "silencedetect=noise=-40dB:d=1.5", "-vn", "-f", "null", "-"]);
  const silencios = [...sil.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_duration: ([\d.]+)/g)]
    .map((m) => ({ inicio: Number(m[1]), dur: Number(m[2]) }))
    .filter((s) => s.inicio + s.dur < dur - 0.3);
  add(
    "sem_silencio_longo",
    silencios.length === 0,
    silencios.length ? silencios.map((s) => `${s.dur.toFixed(1)} s na cena ${cenaEm(s.inicio) ?? "?"}`).join("; ") : "ok",
  );

  // tela preta por mais de 1 s
  const pre = await ffmpegAnalise(["-i", arquivo, "-vf", "blackdetect=d=1:pic_th=0.98", "-an", "-f", "null", "-"]);
  const pretos = [...pre.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ inicio: Number(m[1]), fim: Number(m[2]) }));
  add(
    "sem_tela_preta",
    pretos.length === 0,
    pretos.length ? pretos.map((p) => `${(p.fim - p.inicio).toFixed(1)} s na cena ${cenaEm(p.inicio) ?? "?"}`).join("; ") : "ok",
  );

  const falhas = regras.filter((r) => !r.ok);
  // Problema técnico grave (sem áudio/formato/duração) => falhou; o resto => revisar.
  const graves = falhas.filter((r) => ["formato", "tem_audio", "duracao", "tamanho"].includes(r.regra));
  const status = graves.length ? "falhou" : falhas.length ? "revisar" : "pronto";
  return {
    status,
    regras,
    resultado: { duracao_seg: Math.round(dur * 10) / 10, largura: v?.width, altura: v?.height, tamanho_bytes: bytes },
  };
}
