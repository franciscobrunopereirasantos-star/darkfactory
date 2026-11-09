# Teste de imagem na própria GPU: Qwen-Image-Edit-2509 com as MESMAS referências e cenas do teste do farol.
# Gera as 3 cenas (vigia / menina / os dois) com o atalho Lightning (8 passos) e a cena dos dois também
# com 40 passos (qualidade cheia), mede o tempo de cada uma e envia as imagens para o pedido de teste.
import json, os, time, traceback, urllib.request

import torch
from PIL import Image

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
PEDIDO = os.environ["PEDIDO_ID"]
CUSTO_HORA = float(os.environ.get("CUSTO_HORA", "0") or 0)
INICIO_POD = float(os.environ.get("INICIO_POD", time.time()))
MODELO = os.environ.get("QWEN_DIR", "/root/work/qwen")
G = "https://www.getdarkfactory.com/api/public/fabrica/arquivo/geracao/"
VIGIA = G + "3651389a-28be-40b8-ae99-c53121026446/imagem.png"
MENINA = G + "0d55e1f1-573c-4fd2-bc32-d69b68ece594/imagem.png"
ESTILO = "cinematic digital illustration, warm colors, dramatic lighting, clean line art, no written text"
CENAS = [
    ("cena2-vigia", [VIGIA],
     "The old lighthouse keeper from the reference image (same face, white beard, yellow raincoat, navy beanie) "
     "climbs the spiral staircase inside the lighthouse holding an oil lantern, rain beating on the window. "),
    ("cena3-menina", [MENINA],
     "The girl from the reference image (same face, curly brown hair tied up, red coat, rain boots) stands at the "
     "lighthouse door, wet from the rain, looking up worried. "),
    ("cena4-os-dois", [VIGIA, MENINA],
     "The old keeper from image 1 and the girl from image 2 (keep both faces and outfits exactly) together at the top "
     "of the lighthouse lighting the great lamp, a bright beam of light cutting through the storm. "),
]
W, H = 1376, 768


def api(caminho, corpo):
    req = urllib.request.Request(f"{BASE}/api/public/fabrica/worker/{caminho}", data=json.dumps(corpo).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def avisar(etapa, msg, dados=None, pct=50):
    print(f"[img] {etapa}: {msg}", flush=True)
    try:
        api("progresso", {"pedido_id": PEDIDO, "etapa": etapa, "progresso": pct, "mensagem": msg[:1900], "dados": dados or {}})
    except Exception as e:  # noqa
        print("[img] aviso não enviado:", e, flush=True)


def enviar(arquivo, nome):
    r = api("upload-url", {"pedido_id": PEDIDO, "nome": nome})
    destino = r.get("signedUrl") or r.get("signed_url") or r.get("upload_url") or r.get("url")
    with open(arquivo, "rb") as f:
        urllib.request.urlopen(urllib.request.Request(destino, data=f.read(), method="PUT",
                               headers={"content-type": "image/png", "x-upsert": "true"}), timeout=300).read()
    return r.get("url_final") or r.get("public_url") or f"{BASE}/api/public/fabrica/arquivo/teste/{PEDIDO}/{nome}"


def baixar(url):
    req = urllib.request.Request(url, headers={"user-agent": "darkfactory-teste"})
    with urllib.request.urlopen(req, timeout=120) as r:
        caminho = f"/root/work/ref-{abs(hash(url))}.png"
        open(caminho, "wb").write(r.read())
    return Image.open(caminho).convert("RGB")


def main():
    from diffusers import QwenImageEditPlusPipeline
    gpu = torch.cuda.get_device_name(0)
    vram = torch.cuda.get_device_properties(0).total_memory / 2**30
    t0 = time.time()
    pipe = QwenImageEditPlusPipeline.from_pretrained(MODELO, torch_dtype=torch.bfloat16)
    lightning = False
    try:
        # funde o atalho Lightning nos pesos ANTES do fp8 (LoRA solto não funciona com layerwise casting)
        pipe.load_lora_weights("lightx2v/Qwen-Image-Lightning",
                               weight_name="Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors")
        pipe.fuse_lora()
        pipe.unload_lora_weights()
        lightning = True
    except Exception as e:  # noqa
        avisar("lora", f"Lightning não carregou ({str(e)[:300]})", pct=40)
    modo = "bf16"
    if vram < 70:
        try:
            pipe.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)
            modo = "fp8-armazenamento"
        except Exception as e:  # noqa
            print("[img] layerwise casting indisponível:", e, flush=True)
    pipe.enable_model_cpu_offload()
    carga = time.time() - t0
    avisar("carregado", f"Qwen-Image-Edit-2509 carregado em {carga:.0f} s na {gpu} ({modo}, Lightning={lightning})",
           {"gpu": gpu, "carga_s": round(carga), "modo": modo}, pct=45)

    refs = {u: baixar(u) for u in (VIGIA, MENINA)}
    resultados = []
    rodadas = [(c, 8 if lightning else 40, lightning) for c in CENAS]
    for (nome, urls, prompt), passos, com_lora in rodadas:
        try:
            kw = dict(image=[refs[u] for u in urls], prompt=prompt + "Style: " + ESTILO, width=W, height=H,
                      num_inference_steps=passos, true_cfg_scale=1.0 if com_lora else 4.0,
                      negative_prompt=" ", generator=torch.Generator("cuda").manual_seed(42))
            t1 = time.time()
            img = pipe(**kw).images[0]
            seg = time.time() - t1
            arq = f"/root/work/{nome}-{passos}p.png"
            img.save(arq)
            url = enviar(arq, f"qwen-{nome}-{passos}p.png")
            r = {"cena": nome, "passos": passos, "segundos": round(seg, 1),
                 "custo_usd": round(seg / 3600 * CUSTO_HORA, 4), "url": url}
            resultados.append(r)
            avisar("imagem", f"{nome} {passos} passos: {seg:.0f} s (US$ {r['custo_usd']})", r, pct=60)
        except Exception:
            avisar("erro_imagem", f"{nome} {passos}p falhou: {traceback.format_exc()[-1200:]}", pct=60)
    total = time.time() - INICIO_POD
    avisar("fim", "Teste concluído " + json.dumps({"gpu": gpu, "custo_hora": CUSTO_HORA, "carga_s": round(carga),
           "pod_total_s": round(total), "resultados": resultados}, ensure_ascii=False)[:1800],
           {"resultados": resultados, "pod_total_s": round(total), "custo_hora": CUSTO_HORA}, pct=99)


if __name__ == "__main__":
    try:
        main()
        print("Teste concluído", flush=True)
    except Exception:
        avisar("erro", traceback.format_exc()[-1500:], pct=99)
        raise
