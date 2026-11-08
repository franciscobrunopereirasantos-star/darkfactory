// Escolha do visual de cada cena: imagem enviada pelo cliente > vídeo do Pexels > foto do Pexels > cartão liso.
import path from "node:path";
import { baixar, fetchComRetry, ffmpegAnalise, log } from "./util.mjs";

// Gera termos de busca em inglês para as cenas que não trouxeram "busca".
export async function gerarBuscas(titulo, cenas) {
  const faltando = cenas.map((c, i) => ({ i, texto: c.texto })).filter((x) => !cenas[x.i].busca && !cenas[x.i].imagem_url);
  if (!faltando.length) return cenas.map((c) => c.busca || null);
  const r = await fetchComRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Você escolhe imagens de banco (Pexels) para cenas de um vídeo curto. Para cada cena, devolva um termo de busca " +
            "em INGLÊS, de 2 a 4 palavras, concreto e filmável (objetos, lugares, pessoas fazendo algo). Nada abstrato, nada de texto, " +
            "nada de marcas. Termos diferentes entre as cenas. Responda JSON: {\"buscas\":[{\"i\":numero,\"busca\":\"...\"}]}",
        },
        { role: "user", content: JSON.stringify({ titulo, cenas: faltando }) },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI buscas ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const json = JSON.parse((await r.json()).choices[0].message.content);
  const mapa = new Map((json.buscas || []).map((b) => [b.i, b.busca]));
  return cenas.map((c, i) => c.busca || mapa.get(i) || titulo);
}

async function pexels(url) {
  const r = await fetchComRetry(url, { headers: { authorization: process.env.PEXELS_API_KEY } });
  if (!r.ok) throw new Error(`Pexels ${r.status}`);
  return r.json();
}

// Clipe escuro demais (céu noturno, fade para preto) vira "tela preta" no vídeo final: descarta.
async function escuroDemais(arquivo, duracao) {
  const saida = await ffmpegAnalise(["-t", String(Math.max(3, Math.ceil(duracao))), "-i", arquivo, "-vf", "blackdetect=d=0.5:pic_th=0.98", "-an", "-f", "null", "-"]);
  const total = [...saida.matchAll(/black_duration:([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  return total > 0.5;
}

async function videoPexels(busca, vertical, duracaoMin, usados) {
  const orient = vertical ? "portrait" : "landscape";
  const json = await pexels(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(busca)}&orientation=${orient}&size=medium&per_page=15`,
  );
  // evita repetir o mesmo vídeo e o mesmo autor (clipes da mesma sessão parecem iguais)
  const lista = [...(json.videos || [])].sort((a, b) => usados.has(`u${a.user?.id}`) - usados.has(`u${b.user?.id}`));
  for (const v of lista) {
    if (usados.has(`v${v.id}`)) continue;
    if (v.duration < Math.min(duracaoMin, 6)) continue;
    const arquivos = (v.video_files || [])
      .filter((f) => f.file_type === "video/mp4" && f.width && f.height)
      .filter((f) => (vertical ? f.height >= 1280 && f.height > f.width : f.width >= 1280 && f.width > f.height))
      .sort((a, b) => (vertical ? a.height - b.height : a.width - b.width)); // menor que ainda é HD
    if (arquivos.length) {
      usados.add(`v${v.id}`);
      if (v.user?.id) usados.add(`u${v.user.id}`);
      return { tipo: "video", url: arquivos[0].link, credito: v.user?.name, fonte: v.url };
    }
  }
  return null;
}

async function fotoPexels(busca, vertical, usados) {
  const json = await pexels(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(busca)}&orientation=${vertical ? "portrait" : "landscape"}&per_page=15`,
  );
  const lista = [...(json.photos || [])].sort((a, b) => usados.has(`u${a.photographer_id}`) - usados.has(`u${b.photographer_id}`));
  for (const p of lista) {
    if (usados.has(`f${p.id}`)) continue;
    usados.add(`f${p.id}`);
    if (p.photographer_id) usados.add(`u${p.photographer_id}`);
    return { tipo: "imagem", url: vertical ? p.src.portrait || p.src.large2x : p.src.landscape || p.src.large2x, credito: p.photographer, fonte: p.url };
  }
  return null;
}

// Devolve { tipo: 'imagem'|'video'|'cartao', arquivo?, busca, fonte? }
export async function escolherVisual({ cena, busca, vertical, duracao, usados, pasta, i }) {
  if (cena.imagem_url) {
    const ext = /\.png(\?|$)/i.test(cena.imagem_url) ? "png" : "jpg";
    const arquivo = await baixar(cena.imagem_url, path.join(pasta, `img${i}.${ext}`));
    return { tipo: "imagem", arquivo, busca: null, fonte: cena.imagem_url };
  }
  const tentativas = [busca, busca.split(" ").slice(0, 2).join(" ")].filter((x, k, a) => x && a.indexOf(x) === k);
  for (const termo of tentativas) {
    try {
      // até 3 clipes por termo: pula os escuros demais
      for (let k = 0; k < 3; k++) {
        const v = await videoPexels(termo, vertical, duracao, usados);
        if (!v) break;
        const arquivo = await baixar(v.url, path.join(pasta, `vid${i}.mp4`));
        if (await escuroDemais(arquivo, duracao)) {
          log(`cena ${i + 1}: clipe ${v.fonte} escuro demais, tentando outro`);
          continue;
        }
        return { tipo: "video", arquivo, busca: termo, fonte: v.fonte };
      }
      const f = await fotoPexels(termo, vertical, usados);
      if (f) {
        const arquivo = await baixar(f.url, path.join(pasta, `img${i}.jpg`));
        return { tipo: "imagem", arquivo, busca: termo, fonte: f.fonte };
      }
    } catch (e) {
      log(`cena ${i + 1}: busca "${termo}" falhou: ${e.message}`);
    }
  }
  return { tipo: "cartao", busca, fonte: null };
}
