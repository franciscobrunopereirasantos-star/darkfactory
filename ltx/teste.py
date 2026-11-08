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
    {
        "nome": "ltx-macieira-i2v.mp4",
        "tipo": "i2v",
        "imagem": "https://cdn.kairogen.ai/gallery/images/6ad2287a63742eb015a00e2a/c9125162-b264-41a9-87b2-3bc576473190.png",
        "w": 960, "h": 544,
        "prompt": "The young man with long hair raises the drawing higher toward the hanging light bulb, his face lighting up "
                  "with an amazed smile; the young man with thick glasses leans in and pushes his glasses up, nodding slowly; "
                  "the bulb swings slightly. Painterly illustrated style preserved, gentle natural motion, warm amber light.",
    },
]


DESTILADO = dict(guidance_scale=1.0, stg_scale=0.0, modality_scale=1.0, guidance_rescale=0.0,
                 audio_guidance_scale=1.0, audio_stg_scale=0.0, audio_modality_scale=1.0, audio_guidance_rescale=0.0)


def gerar(runner, c, k, extra):
    from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
    from diffusers.utils import encode_video
    args = dict(prompt=c["prompt"], width=c["w"], height=c["h"], num_frames=121, frame_rate=24.0,
                sigmas=DISTILLED_SIGMA_VALUES, generator=torch.Generator("cuda").manual_seed(42),
                output_type="np", return_dict=False, **DESTILADO, **extra)
    t1 = time.time()

    def passo(p, i, t, kw):
        if i % 2 == 0:
            avisar("passo", f"{c['nome']} passo {i} em {time.time() - t1:.0f} s", None, 40 + 20 * k)
        return kw
    try:
        video, audio = runner(**args, callback_on_step_end=passo)
    except TypeError as e:
        if "callback" not in str(e):
            raise
        video, audio = runner(**args)
    seg = time.time() - t1
    saida = f"/root/work/{c['nome']}"
    encode_video(video[0], fps=24, audio=audio[0].float().cpu() if audio is not None else None,
                 audio_sample_rate=runner.vocoder.config.output_sampling_rate, output_path=saida)
    url = enviar(saida, c["nome"])
    r = {"cena": c["nome"], "segundos_gpu": round(seg, 1), "url": url}
    avisar("clipe", f"{c['nome']}: {seg:.0f} s de GPU para 5 s de vídeo", r, 40 + 20 * (k + 1))
    return r


def carregar(classe):
    t0 = time.time()
    try:
        pipe = classe.from_pretrained(MODELO, dtype=torch.bfloat16)
    except TypeError:
        pipe = classe.from_pretrained(MODELO, torch_dtype=torch.bfloat16)
    pipe.enable_model_cpu_offload()
    if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    avisar("carregou", f"{classe.__name__} carregado em {time.time() - t0:.0f} s", None, 40)
    return pipe


def main():
    import gc
    from diffusers import LTX2Pipeline, LTX2ImageToVideoPipeline
    from diffusers.utils import load_image

    gpu = torch.cuda.get_device_name(0)
    ativas = [x for x in os.environ.get("CENAS_ATIVAS", "").split(",") if x]
    cenas = [c for c in CENAS if not ativas or c["nome"] in ativas]
    resultados = []
    for tipo, classe in (("t2v", LTX2Pipeline), ("i2v", LTX2ImageToVideoPipeline)):
        lote = [c for c in cenas if c["tipo"] == tipo]
        if not lote:
            continue
        pipe = carregar(classe)
        for k, c in enumerate(lote):
            try:
                extra = {"image": load_image(c["imagem"]).convert("RGB").resize((c["w"], c["h"]))} if tipo == "i2v" else {}
                resultados.append(gerar(pipe, c, k, extra))
            except Exception:
                erro = traceback.format_exc()[-1500:]
                resultados.append({"cena": c["nome"], "erro": erro})
                avisar("erro", f"{c['nome']} falhou: {erro}", {"cena": c["nome"]})
        del pipe
        gc.collect()
        torch.cuda.empty_cache()
    avisar("fim", "Teste concluído", {"gpu": gpu, "resultados": resultados}, 100)
    print("Teste concluído", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        avisar("erro", "Falha geral: " + traceback.format_exc()[-1800:])
