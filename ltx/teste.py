# Teste do motor LTX-2.5 (Lightricks, pesos oficiais) numa GPU do RunPod.
# Gera 3 clipes, mede o tempo de cada um e envia tudo para a fábrica (DarkFactory).
import json, os, time, traceback, urllib.request

import torch

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
PEDIDO = os.environ["PEDIDO_ID"]
MODELO = os.environ.get("LTX_DIR", "/root/work/ltx")


def api(caminho, corpo):
    req = urllib.request.Request(
        f"{BASE}/api/public/fabrica/worker/{caminho}",
        data=json.dumps(corpo).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def avisar(etapa, msg, dados=None, pct=0):
    print(f"[ltx] {etapa}: {msg}", flush=True)
    try:
        api("progresso", {"pedido_id": PEDIDO, "etapa": etapa, "progresso": pct, "mensagem": msg[:1900], "dados": dados or {}})
    except Exception as e:  # noqa
        print("[ltx] aviso não enviado:", e, flush=True)


def enviar(arquivo, nome):
    r = api("upload-url", {"pedido_id": PEDIDO, "nome": nome})
    with open(arquivo, "rb") as f:
        req = urllib.request.Request(r["upload_url"], data=f.read(), method="PUT",
                                     headers={"content-type": "video/mp4", "x-upsert": "true"})
        urllib.request.urlopen(req, timeout=300).read()
    return r["url_final"]


CENAS = [
    {
        "nome": "ltx-macieira-i2v.mp4",
        "tipo": "i2v",
        "imagem": "https://cdn.kairogen.ai/gallery/images/6ad2287a63742eb015a00e2a/c9125162-b264-41a9-87b2-3bc576473190.png",
        "w": 960, "h": 544,
        "prompt": "The young man with long hair raises the drawing higher toward the hanging light bulb, his face lighting up "
                  "with an amazed smile; the young man with thick glasses leans in and pushes his glasses up, nodding slowly; "
                  "the bulb swings slightly. Painterly illustrated style preserved, gentle natural motion, warm amber light.",
    },
    {
        "nome": "ltx-signo-t2v.mp4",
        "tipo": "t2v",
        "w": 544, "h": 960,
        "prompt": "Vertical cinematic painterly illustration: a mysterious woman representing the Scorpio zodiac sign stands on a "
                  "dark rooftop at night under a deep purple sky full of stars, a glowing scorpion constellation appears behind "
                  "her, her hair and coat move with the wind, slow push-in camera, magical particles, rich colors.",
    },
    {
        "nome": "ltx-fala-ptbr-t2v.mp4",
        "tipo": "t2v",
        "w": 544, "h": 960,
        "prompt": "Vertical video, 3D animated cartoon style: a friendly young Brazilian presenter with curly hair looks at the "
                  "camera in a colorful studio and says in Brazilian Portuguese, with clear lip sync: \"Você sabia que a Lua "
                  "também gira? Fica comigo que eu te explico.\" Expressive face, natural hand gestures, static camera.",
    },
]


def main():
    from diffusers import LTX2Pipeline
    from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
    from diffusers.utils import encode_video, load_image

    gpu = torch.cuda.get_device_name(0)
    t0 = time.time()
    pipe = LTX2Pipeline.from_pretrained(MODELO, dtype=torch.bfloat16)
    pipe.enable_model_cpu_offload()
    avisar("carregou", f"Modelo carregado em {time.time() - t0:.0f} s na {gpu}", {"gpu": gpu}, 40)

    i2v = None
    resultados = []
    for k, c in enumerate(CENAS):
        try:
            args = dict(prompt=c["prompt"], width=c["w"], height=c["h"], num_frames=121, frame_rate=24.0,
                        sigmas=DISTILLED_SIGMA_VALUES, guidance_scale=1.0,
                        generator=torch.Generator("cuda").manual_seed(42), output_type="np", return_dict=False)
            if c["tipo"] == "i2v":
                if i2v is None:
                    try:
                        from diffusers import LTX2ImageToVideoPipeline
                        i2v = LTX2ImageToVideoPipeline.from_pipe(pipe)
                    except Exception as e:  # sem pipeline de imagem: registra e segue
                        raise RuntimeError(f"image-to-video indisponível nesta versão do diffusers: {e}")
                args["image"] = load_image(c["imagem"]).resize((c["w"], c["h"]))
                runner = i2v
            else:
                runner = pipe
            t1 = time.time()
            video, audio = runner(**args)
            seg = time.time() - t1
            saida = f"/root/work/{c['nome']}"
            encode_video(video[0], fps=24, audio=audio[0].float().cpu() if audio is not None else None,
                         audio_sample_rate=pipe.vocoder.config.output_sampling_rate, output_path=saida)
            url = enviar(saida, c["nome"])
            r = {"cena": c["nome"], "segundos_gpu": round(seg, 1), "url": url}
            resultados.append(r)
            avisar("clipe", f"{c['nome']}: {seg:.0f} s de GPU para 5 s de vídeo", r, 40 + 20 * (k + 1))
        except Exception:
            erro = traceback.format_exc()[-1500:]
            resultados.append({"cena": c["nome"], "erro": erro})
            avisar("erro", f"{c['nome']} falhou: {erro}", {"cena": c["nome"]})
    avisar("fim", "Teste concluído", {"gpu": gpu, "resultados": resultados}, 100)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        avisar("erro", "Falha geral: " + traceback.format_exc()[-1800:])
