# Teste 3 da novela das frutinhas (18/11): o próprio LTX-2.5 gera a VOZ junto com o vídeo (boca sincronizada,
# como o Veo 3). Mesmas imagens e falas do episódio 1; 4 cenas de uma fala cada + um vídeo juntando as 4.
# Comparar com o teste 1 (vozes da fábrica + uma fala por cena) e o teste 2 (sincronia labial depois).
import json, math, os, subprocess, time, traceback, urllib.request

import torch

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
PEDIDO = os.environ["PEDIDO_ID"]
MODELO = os.environ.get("LTX_DIR", "/root/work/ltx")
W = "/root/work"
G = "https://www.getdarkfactory.com/api/public/fabrica/arquivo/geracao/%s/imagem.png"
S = ("High-quality 3D cartoon animation in the style of a Pixar feature film, anthropomorphic fruit characters with big "
     "expressive eyes and fully animated faces, dramatic Brazilian telenovela lighting in a dark kitchen at night, saturated colors.")
CENAS = [
    ("195c60b9-0d4d-48a0-9b62-79c93b9b9dc8",
     "The yellow banana with red lipstick in the foreground drops her purse, eyes huge, and shouts in outrage at the strawberry and the grape behind the juice pitcher, who freeze guiltily with mouths closed.",
     "an outraged, dramatic adult female voice", "Morango?! Com a Uva?! Que piii é essa?!"),
    ("bdc14ead-e2e5-4b24-b0ca-2ff15d15faa8",
     "Close-up of the purple grape with sunglasses on top: she smirks, rolls her eyes and slides her sunglasses down while taunting.",
     "a sassy, mocking, sarcastic adult female voice", "Ih, querida... ele me contou que você já tá passando do ponto."),
    ("97fb2468-e13f-4ae9-a539-ddf824c56e25",
     "Close-up of the yellow banana exploding with rage, face turning red, jabbing her finger toward the camera and screaming.",
     "a furious, screaming adult female voice", "Passando do ponto é a piii da tua mãe, sua uva-passa recalcada!"),
    ("5c5cd679-857e-4ce8-8197-1bb699e63526",
     "The red strawberry with a leafy pompadour sweats and raises both hands asking for calm, talking fast; the banana beside him crosses her arms, silent, mouth closed.",
     "a nervous, pleading young adult male voice", "Gente, calma! Vamos conversar igual fruta civilizada..."),
]
FALA = (" Only this character speaks, in Brazilian Portuguese, with {voz}, perfect lip sync, saying: \"{t}\" "
        "Comedic soap-opera tone, quiet kitchen ambience, no music.")
DESTILADO = dict(guidance_scale=1.0, stg_scale=0.0, modality_scale=1.0, guidance_rescale=0.0,
                 audio_guidance_scale=1.0, audio_stg_scale=0.0, audio_modality_scale=1.0, audio_guidance_rescale=0.0)


def api(caminho, corpo):
    req = urllib.request.Request(f"{BASE}/api/public/fabrica/worker/{caminho}", data=json.dumps(corpo).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def avisar(etapa, msg, dados=None, pct=50):
    print(f"[frutas] {etapa}: {msg}", flush=True)
    try:
        api("progresso", {"pedido_id": PEDIDO, "etapa": etapa, "progresso": pct, "mensagem": msg[:1900], "dados": dados or {}})
    except Exception as e:  # noqa
        print("[frutas] aviso não enviado:", e, flush=True)


def enviar(arquivo, nome):
    r = api("upload-url", {"pedido_id": PEDIDO, "nome": nome})
    with open(arquivo, "rb") as f:
        urllib.request.urlopen(urllib.request.Request(r["upload_url"], data=f.read(), method="PUT",
                               headers={"content-type": "video/mp4", "x-upsert": "true"}), timeout=300).read()
    return r["url_final"]


def main():
    import imageio_ffmpeg
    from diffusers import LTX2ImageToVideoPipeline
    from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
    from diffusers.utils import encode_video, load_image

    ff = imageio_ffmpeg.get_ffmpeg_exe()
    run = lambda *a: subprocess.run([ff, "-y", "-loglevel", "error", *a], check=True)
    gpu = torch.cuda.get_device_name(0)
    try:
        pipe = LTX2ImageToVideoPipeline.from_pretrained(MODELO, dtype=torch.bfloat16)
    except TypeError:
        pipe = LTX2ImageToVideoPipeline.from_pretrained(MODELO, torch_dtype=torch.bfloat16)
    pipe.enable_model_cpu_offload()
    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    avisar("carregou", f"LTX carregado na {gpu}", {"gpu": gpu}, 20)

    segs, res, gtot = [], [], 0.0
    for i, (img_id, acao, voz, texto) in enumerate(CENAS):
        img = load_image(G % img_id).convert("RGB")
        w, h = 768, 1376  # vertical
        img = img.resize((w, h))
        seg = max(4.0, len(texto) / 12.0 + 1.2)
        quadros = min(241, int(math.ceil(seg * 24 / 8)) * 8 + 1)
        t1 = time.time()
        video, audio = pipe(image=img, prompt=acao + FALA.format(voz=voz, t=texto) + " " + S, width=w, height=h,
                            num_frames=quadros, frame_rate=24.0, sigmas=DISTILLED_SIGMA_VALUES,
                            generator=torch.Generator("cuda").manual_seed(4000 + i), output_type="np", return_dict=False, **DESTILADO)
        g = time.time() - t1
        gtot += g
        bruto = f"{W}/fala{i}-bruto.mp4"
        encode_video(video[0], fps=24, audio=audio[0].float().cpu(),
                     audio_sample_rate=pipe.vocoder.config.output_sampling_rate, output_path=bruto)
        out = f"{W}/frutas-ltx-voz-cena{i + 1}.mp4"
        run("-i", bruto, "-vf", "scale=720:1280:flags=lanczos,setsar=1,fps=24", "-c:v", "libx264", "-crf", "17",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", out)
        segs.append(out)
        url = enviar(out, os.path.basename(out))
        res.append({"cena": i + 1, "fala": texto, "url": url, "segundos_gpu": round(g)})
        avisar("clipe", f"cena {i + 1}/4 com voz do LTX: {g:.0f} s de GPU", {"url": url}, 30 + 15 * i)

    lista = f"{W}/lista.txt"
    open(lista, "w").write("\n".join(f"file '{s}'" for s in segs))
    junto = f"{W}/frutas-teste3-voz-ltx.mp4"
    run("-f", "concat", "-safe", "0", "-i", lista, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", junto)
    url = enviar(junto, os.path.basename(junto))
    custo_h = float(os.environ.get("CUSTO_HORA", "0.79") or 0.79)
    avisar("fim", "Teste 3 (voz do LTX) concluído",
           {"gpu": gpu, "video_juntado": url, "cenas": res, "segundos_gpu_total": round(gtot),
            "custo_gpu_usd": round(gtot / 3600 * custo_h, 3)}, 100)
    print("Teste concluído", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        avisar("erro", "Falha geral: " + traceback.format_exc()[-1800:])
