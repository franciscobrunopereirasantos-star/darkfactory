# Piloto do formato Narrador (Palavra Viva) em 3 versões de voz, todas com o motor LTX-2.5:
#   V1 "misto"  : abertura com a narradora falando (voz do LTX, boca sincronizada) + resto narrado pela voz da OpenAI
#   V2 "ltx"    : a narradora fala o vídeo inteiro (voz do LTX em cada trecho)
#   V3 "openai" : narração inteira com a voz da OpenAI sobre a narradora animada (sem boca sincronizada)
# Mesma narradora (imagem salva do Palavra Viva), mesmo texto, mesma montagem. Resultado: 3 MP4 verticais 720x1280.
import json, math, os, subprocess, time, traceback, urllib.request

import torch

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
PEDIDO = os.environ["PEDIDO_ID"]
OPENAI = os.environ.get("OPENAI_API_KEY", "")
MODELO = os.environ.get("LTX_DIR", "/root/work/ltx")
W = "/root/work"
IMG = "https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/assets/palavra-viva-narradora.jpg"

# Salmos 118:6 — um trecho por cena (cada trecho cabe em até ~10 s de fala)
TRECHOS = [
    "Pare por alguns segundos e ouça essa Palavra. Ela chegou até você hoje por um motivo.",
    "Salmos cento e dezoito, versículo seis: O Senhor está comigo, não temerei. O que me podem fazer os homens?",
    "Talvez você esteja enfrentando pessoas, palavras ou situações que tiram a sua paz e apertam o seu coração.",
    "Mas escute: quem caminha com Deus nunca caminha sozinho. Nenhuma ameaça é maior do que a mão que te sustenta.",
    "Respire fundo e entregue esse medo agora. O mesmo Deus que te trouxe até aqui vai te levar além.",
    "Se essa Palavra é para você, escreva Amém nos comentários e salve este vídeo para ouvir de novo.",
]
GESTOS = [
    "she looks directly at the camera with a warm, welcoming expression",
    "she slowly lifts her eyes upward with reverence, light rays glow behind her",
    "she tilts her head gently with compassion, a soft breeze moves her mantle",
    "she places her hands over her heart with a confident, protective gaze",
    "she closes her eyes for a moment and breathes calmly, then opens them with peace",
    "she opens her hands toward the camera in an inviting gesture with a gentle smile",
]
BASE_VISUAL = ("Keep the exact same appearance, crown, mantle and painting style as the reference image. "
               "Golden light rays shimmer softly behind her, clouds drift slowly, very slow cinematic push-in. ")
FALA = ("She speaks in Brazilian Portuguese with a warm, serene, gentle female voice, clear lip sync, saying: \"{t}\" "
        "Calm sacred ambience, no music.")
MUDA = "She does not speak, her lips stay closed, gentle breathing and subtle natural movement only. Silent."
DESTILADO = dict(guidance_scale=1.0, stg_scale=0.0, modality_scale=1.0, guidance_rescale=0.0,
                 audio_guidance_scale=1.0, audio_stg_scale=0.0, audio_modality_scale=1.0, audio_guidance_rescale=0.0)


def api(caminho, corpo):
    req = urllib.request.Request(f"{BASE}/api/public/fabrica/worker/{caminho}", data=json.dumps(corpo).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def avisar(etapa, msg, dados=None, pct=50):
    print(f"[narrador] {etapa}: {msg}", flush=True)
    try:
        api("progresso", {"pedido_id": PEDIDO, "etapa": etapa, "progresso": pct, "mensagem": msg[:1900], "dados": dados or {}})
    except Exception as e:  # noqa
        print("[narrador] aviso não enviado:", e, flush=True)


def enviar(arquivo, nome):
    r = api("upload-url", {"pedido_id": PEDIDO, "nome": nome})
    with open(arquivo, "rb") as f:
        urllib.request.urlopen(urllib.request.Request(r["upload_url"], data=f.read(), method="PUT",
                               headers={"content-type": "video/mp4", "x-upsert": "true"}), timeout=300).read()
    return r["url_final"]


def tts(texto, destino):
    req = urllib.request.Request("https://api.openai.com/v1/audio/speech", method="POST",
                                 headers={"authorization": f"Bearer {OPENAI}", "content-type": "application/json"},
                                 data=json.dumps({"model": "gpt-4o-mini-tts", "voice": "coral", "input": texto, "response_format": "wav",
                                                  "instructions": "Voz feminina brasileira, serena, acolhedora e reverente, como uma mãe "
                                                                  "aconselhando com carinho. Ritmo calmo, pausas naturais."}).encode())
    with urllib.request.urlopen(req, timeout=120) as r, open(destino, "wb") as f:
        f.write(r.read())
    return destino


def main():
    import imageio_ffmpeg
    from diffusers import LTX2ImageToVideoPipeline
    from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
    from diffusers.utils import encode_video, load_image

    ff = imageio_ffmpeg.get_ffmpeg_exe()
    run = lambda *a: subprocess.run([ff, "-y", "-loglevel", "error", *a], check=True)

    def dur(arq):
        import re
        out = subprocess.run([ff, "-i", arq], capture_output=True, text=True).stderr
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
        return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])

    gpu = torch.cuda.get_device_name(0)
    try:
        pipe = LTX2ImageToVideoPipeline.from_pretrained(MODELO, dtype=torch.bfloat16)
    except TypeError:
        pipe = LTX2ImageToVideoPipeline.from_pretrained(MODELO, torch_dtype=torch.bfloat16)
    pipe.enable_model_cpu_offload()
    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    img = load_image(IMG).convert("RGB")
    w, h = img.size  # 768x1344, múltiplos de 32
    avisar("carregou", f"LTX carregado na {gpu}; narradora {w}x{h}", {"gpu": gpu}, 20)

    def clipe(prompt, segundos, seed, nome, com_audio):
        quadros = min(241, int(math.ceil(segundos * 24 / 8)) * 8 + 1)
        t1 = time.time()
        video, audio = pipe(image=img, prompt=prompt, width=w, height=h, num_frames=quadros, frame_rate=24.0,
                            sigmas=DISTILLED_SIGMA_VALUES, generator=torch.Generator("cuda").manual_seed(seed),
                            output_type="np", return_dict=False, **DESTILADO)
        g = time.time() - t1
        saida = f"{W}/{nome}.mp4"
        if com_audio and audio is not None:
            encode_video(video[0], fps=24, audio=audio[0].float().cpu(),
                         audio_sample_rate=pipe.vocoder.config.output_sampling_rate, output_path=saida)
        else:
            encode_video(video[0], fps=24, output_path=saida)
        return saida, g, quadros

    gpu_total = 0.0
    # 1) Narração da OpenAI por trecho (usada nas versões 1 e 3)
    narr = []
    for i, t in enumerate(TRECHOS):
        a = tts(t, f"{W}/tts{i}.wav")
        narr.append((a, dur(a)))
    avisar("voz", "Narração OpenAI pronta: " + ", ".join(f"{d:.1f}s" for _, d in narr), None, 25)

    # 2) Clipes com fala (versão 2; o primeiro também abre a versão 1)
    falados = []
    for i, t in enumerate(TRECHOS):
        seg = max(5.0, len(t) / 13.0 + 1.0)  # ~13 caracteres por segundo de fala + respiro
        arq, g, q = clipe(BASE_VISUAL + GESTOS[i] + ". " + FALA.format(t=t), seg, 2000 + i, f"fala{i}", True)
        gpu_total += g
        falados.append(arq)
        avisar("clipe", f"fala {i + 1}/6: {g:.0f} s de GPU ({q} quadros)", {"segundos_gpu": round(g, 1)}, 25 + 6 * i)

    # 3) Clipes mudos (versões 1 e 3), um por trecho, do tamanho da narração
    mudos = []
    for i, t in enumerate(TRECHOS):
        arq, g, q = clipe(BASE_VISUAL + GESTOS[i] + ". " + MUDA, narr[i][1] + 0.3, 3000 + i, f"mudo{i}", False)
        gpu_total += g
        mudos.append(arq)
        avisar("clipe", f"mudo {i + 1}/6: {g:.0f} s de GPU ({q} quadros)", {"segundos_gpu": round(g, 1)}, 60 + 5 * i)

    # 4) Montagem: cada trecho vira um segmento 720x1280 com seu áudio; depois concatena
    def segmento(video, audio, nome, alvo=None):
        """Normaliza para 720x1280/24fps/AAC 48k. Se 'alvo' for dado, ajusta o vídeo à duração do áudio."""
        out = f"{W}/seg-{nome}.mp4"
        vf = "scale=720:1280:flags=lanczos,setsar=1,fps=24"
        if audio:
            d = dur(audio)
            run("-i", video, "-i", audio, "-filter_complex",
                f"[0:v]{vf},tpad=stop_mode=clone:stop_duration=5[v];[1:a]aresample=48000,apad=pad_dur=0.25[a]",
                "-map", "[v]", "-map", "[a]", "-t", f"{d + 0.25:.3f}", "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", out)
        else:  # usa o áudio do próprio clipe (voz do LTX)
            run("-i", video, "-vf", vf, "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", out)
        return out

    def juntar(segs, nome):
        lista = f"{W}/{nome}.txt"
        open(lista, "w").write("\n".join(f"file '{s}'" for s in segs))
        out = f"{W}/{nome}.mp4"
        run("-f", "concat", "-safe", "0", "-i", lista, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out)
        return out

    v2 = juntar([segmento(falados[i], None, f"v2-{i}") for i in range(6)], "narrador-v2-voz-ltx")
    v3 = juntar([segmento(mudos[i], narr[i][0], f"v3-{i}") for i in range(6)], "narrador-v3-voz-openai")
    v1 = juntar([segmento(falados[0], None, "v1-0")] + [segmento(mudos[i], narr[i][0], f"v1-{i}") for i in range(1, 6)],
                "narrador-v1-misto")

    custo_h = float(os.environ.get("CUSTO_HORA", "1.79"))
    resultados = []
    for rot, arq in (("Voz 1 — misto (abertura LTX + OpenAI)", v1), ("Voz 2 — só LTX", v2), ("Voz 3 — só OpenAI", v3)):
        url = enviar(arq, os.path.basename(arq))
        resultados.append({"rotulo": rot, "url": url, "duracao_s": round(dur(arq), 1)})
    dados = {"gpu": gpu, "segundos_gpu_total": round(gpu_total), "custo_gpu_usd": round(gpu_total / 3600 * custo_h, 3),
             "resultados": resultados}
    avisar("fim", "Piloto Narrador concluído", dados, 100)

    # Registra no Laboratório (se a rota existir)
    try:
        api("lab", {"teste": {"titulo": "Narrador Palavra Viva — 3 vozes (Salmos 118:6)", "tipo": "comparativo_voz",
                              "descricao": "Mesma narradora, mesmo texto e mesma montagem; muda só a voz. Motor LTX-2.5 na A100."},
                    "itens": [{"grupo": "Piloto", "ordem": k, "rotulo": r["rotulo"], "video_url": r["url"], "imagem_url": IMG,
                               "motor": "LTX-2.5", "dados": {"duracao_s": r["duracao_s"], "gpu": gpu}} for k, r in enumerate(resultados)]})
    except Exception as e:
        print("[narrador] laboratório indisponível:", e, flush=True)
    print("Teste concluído", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        avisar("erro", "Falha geral: " + traceback.format_exc()[-1800:])
