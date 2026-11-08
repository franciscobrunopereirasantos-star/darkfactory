# Gera todos os clipes LTX-2.5 (image-to-video) de um lote, em sequência, e envia cada um para a fábrica.
# Entrada: JOBS_GZ = base64(gzip(JSON [{pedido_id, cena, seed, imagem_url, prompt, dur, nome}])).
import base64, gzip, json, math, os, subprocess, time, traceback, urllib.request

import torch

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
LOTE = os.environ["LOTE_ID"]
MODELO = os.environ.get("LTX_DIR", "/workspace/ltx")
INICIO_POD = float(os.environ.get("INICIO_POD", time.time()))
JOBS = json.loads(gzip.decompress(base64.b64decode(os.environ["JOBS_GZ"])))
NEG = "blurry, distorted face, deformed hands, extra fingers, text, watermark, subtitles, logo, low quality, flicker"
DESTILADO = dict(guidance_scale=1.0, stg_scale=0.0, modality_scale=1.0, guidance_rescale=0.0,
                 audio_guidance_scale=1.0, audio_stg_scale=0.0, audio_modality_scale=1.0, audio_guidance_rescale=0.0)


def api(caminho, corpo):
    req = urllib.request.Request(f"{BASE}/api/public/fabrica/worker/{caminho}", data=json.dumps(corpo).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def avisar(etapa, msg, dados=None):
    print(f"[lote] {etapa}: {msg}", flush=True)
    try:
        api("lote/progresso", {"lote_id": LOTE, "etapa": etapa, "mensagem": msg[:1900],
                               "dados": {**(dados or {}), "segundos_desde_ligar": round(time.time() - INICIO_POD)}})
    except Exception as e:  # noqa
        print("[lote] aviso não enviado:", e, flush=True)


def enviar(pedido_id, arquivo, nome):
    r = api("upload-url", {"pedido_id": pedido_id, "nome": nome})
    with open(arquivo, "rb") as f:
        urllib.request.urlopen(urllib.request.Request(r["upload_url"], data=f.read(), method="PUT",
                               headers={"content-type": "video/mp4", "x-upsert": "true"}), timeout=300).read()
    return r.get("url_final")


def tamanho_ltx(w, h):
    """Mantém a imagem se já for múltipla de 32 e no máx. 1376 de largura; senão ajusta para 1376 de largura."""
    if w % 32 == 0 and h % 32 == 0 and w <= 1376:
        return w, h
    s = 1376 / w
    return 1376, max(32, int(round(h * s / 32)) * 32)


def main():
    import imageio_ffmpeg
    from diffusers import LTX2ImageToVideoPipeline
    from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
    from diffusers.utils import encode_video, load_image

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    gpu = torch.cuda.get_device_name(0)
    t0 = time.time()
    try:
        pipe = LTX2ImageToVideoPipeline.from_pretrained(MODELO, dtype=torch.bfloat16)
    except TypeError:
        pipe = LTX2ImageToVideoPipeline.from_pretrained(MODELO, torch_dtype=torch.bfloat16)
    vram_gb = torch.cuda.get_device_properties(0).total_memory / 2**30
    modo = "bf16"
    if vram_gb < 70:
        # GPU de 48 GB: o transformer em bf16 não cabe junto com as ativações. Guarda os pesos em fp8 e
        # calcula em bf16 (metade da memória do transformer).
        try:
            pipe.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)
            modo = "fp8-armazenamento"
        except Exception as e:  # noqa
            print("[lote] layerwise casting indisponível:", e, flush=True)
    pipe.enable_model_cpu_offload()
    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    avisar("carregou", f"LTX carregado em {time.time() - t0:.0f} s na {gpu} ({vram_gb:.0f} GB, {modo}); {len(JOBS)} clipes na fila",
           {"gpu": gpu, "modo": modo})

    def modo_economico():
        """Último recurso contra falta de memória: move camada por camada para a GPU (mais lento)."""
        nonlocal modo
        if modo.startswith("sequencial"):
            return False
        pipe.remove_all_hooks()
        torch.cuda.empty_cache()
        pipe.enable_sequential_cpu_offload()
        modo = "sequencial+" + modo
        avisar("memoria", f"Falta de memória na {gpu}: mudando para descarregamento sequencial", {"modo": modo})
        return True

    total_gpu, total_clipe, ok = 0.0, 0.0, 0
    for k, j in enumerate(JOBS):
      for tentativa in range(2):
        try:
            img = load_image(j["imagem_url"]).convert("RGB")
            w, h = tamanho_ltx(*img.size)
            if (w, h) != img.size:
                img = img.resize((w, h))
            quadros = round(j["dur"] * 24)
            gerar = 8 * math.ceil((quadros - 1) / 8) + 1
            t1 = time.time()
            video, _a = pipe(image=img, prompt=j["prompt"], width=w, height=h, num_frames=gerar, frame_rate=24.0,
                             sigmas=DISTILLED_SIGMA_VALUES, generator=torch.Generator("cuda").manual_seed(int(j["seed"])),
                             output_type="np", return_dict=False, **DESTILADO)
            gpu_s = time.time() - t1
            bruto = f"/root/bruto-{k}.mp4"
            encode_video(video[0], fps=24, output_path=bruto)
            final = f"/root/clipe-{k}.mp4"
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", bruto, "-frames:v", str(quadros),
                            "-vf", "scale=1280:720:flags=lanczos,setsar=1", "-r", "24", "-an", "-c:v", "libx264", "-crf", "16",
                            "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final], check=True)
            enviar(j["pedido_id"], final, j["nome"])
            total_gpu += gpu_s
            total_clipe += j["dur"]
            ok += 1
            avisar("clipe", f"{k + 1}/{len(JOBS)} cena {j['cena']}: {gpu_s:.0f} s de GPU para {j['dur']:.2f} s ({gerar} quadros, {w}x{h}, {modo})",
                   {"pedido_id": j["pedido_id"], "cena": j["cena"], "segundos_gpu": round(gpu_s, 1), "dur": j["dur"], "modo": modo})
            break
        except torch.OutOfMemoryError:
            torch.cuda.empty_cache()
            if tentativa == 0 and modo_economico():
                continue
            avisar("erro_clipe", f"cena {j.get('cena')}: sem memória na GPU mesmo no modo econômico", {"pedido_id": j.get("pedido_id"), "cena": j.get("cena")})
            break
        except Exception:
            avisar("erro_clipe", f"cena {j.get('cena')} do pedido {j.get('pedido_id')} falhou: {traceback.format_exc()[-1200:]}",
                   {"pedido_id": j.get("pedido_id"), "cena": j.get("cena")})
            break
    sps = round(total_gpu / total_clipe, 1) if total_clipe else None
    avisar("gpu_fim", f"{ok}/{len(JOBS)} clipes; {total_gpu:.0f} s de geração; {sps} s de GPU por s de clipe na {gpu}",
           {"gpu": gpu, "clipes_ok": ok, "clipes_total": len(JOBS), "segundos_geracao": round(total_gpu), "seg_gpu_por_seg_clipe": sps})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        avisar("erro", "Falha geral na GPU: " + traceback.format_exc()[-1800:])
