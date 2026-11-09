# Servidor de clipes da API de geração: carrega o LTX-2.5 uma vez, atende a fila de jobs "clipe"
# e encerra depois de GPU_OCIOSA_MIN minutos sem trabalho (o pod.sh desliga a GPU na saída).
import json, math, os, subprocess, threading, time, traceback, urllib.request

import torch

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
MODELO = os.environ.get("LTX_DIR", "/workspace/ltx")
POD = os.environ.get("RUNPOD_POD_ID", "")
CUSTO_HORA = float(os.environ.get("CUSTO_HORA", "0") or 0)
OCIOSA_MIN = float(os.environ.get("GPU_OCIOSA_MIN", "10"))
INICIO_POD = float(os.environ.get("INICIO_POD", time.time()))
DESTILADO = dict(guidance_scale=1.0, stg_scale=0.0, modality_scale=1.0, guidance_rescale=0.0,
                 audio_guidance_scale=1.0, audio_stg_scale=0.0, audio_modality_scale=1.0, audio_guidance_rescale=0.0)
estado = {"estado": "ligando", "gpu": ""}


def api(caminho, corpo, timeout=60):
    req = urllib.request.Request(f"{BASE}/api/public/fabrica/worker/{caminho}", data=json.dumps(corpo).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def sinal():
    try:
        api("gpu/sinal", {"pod_id": POD, "gpu": estado["gpu"], "estado": estado["estado"], "custo_hora": CUSTO_HORA,
                          "segundos_desde_ligar": round(time.time() - INICIO_POD)}, timeout=20)
    except Exception as e:  # noqa
        print("[servidor] sinal falhou:", e, flush=True)


def batimento():
    while True:
        sinal()
        time.sleep(60)


def progresso(job, msg, dados=None):
    print(f"[servidor] {job}: {msg}", flush=True)
    try:
        api("jobs/progresso", {"job_id": job, "mensagem": msg[:1900], "dados": dados or {}})
    except Exception as e:  # noqa
        print("[servidor] progresso falhou:", e, flush=True)


def enviar(job, arquivo, nome, tipo="video/mp4"):
    r = api("jobs/upload-url", {"job_id": job, "nome": nome})
    with open(arquivo, "rb") as f:
        urllib.request.urlopen(urllib.request.Request(r["upload_url"], data=f.read(), method="PUT",
                               headers={"content-type": tipo, "x-upsert": "true"}), timeout=300).read()
    return r.get("url_final")


def tamanho_ltx(w, h):
    if w % 32 == 0 and h % 32 == 0 and w <= 1376:
        return w, h
    s = 1376 / w if w >= h else 1376 / h
    return max(32, int(round(w * s / 32)) * 32), max(32, int(round(h * s / 32)) * 32)


class Motor:
    """Mantém um pipeline carregado (image-to-video ou text-to-video) e troca quando precisa."""

    def __init__(self):
        self.pipe, self.tipo, self.modo = None, None, "bf16"
        self.vram = torch.cuda.get_device_properties(0).total_memory / 2**30

    def carregar(self, tipo):
        if self.tipo == tipo:
            return
        from diffusers import LTX2ImageToVideoPipeline, LTX2Pipeline
        if self.pipe is not None:
            del self.pipe
            torch.cuda.empty_cache()
        cls = LTX2ImageToVideoPipeline if tipo == "i2v" else LTX2Pipeline
        try:
            self.pipe = cls.from_pretrained(MODELO, dtype=torch.bfloat16)
        except TypeError:
            self.pipe = cls.from_pretrained(MODELO, torch_dtype=torch.bfloat16)
        self.modo = "bf16"
        if self.vram < 70:
            try:
                self.pipe.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)
                self.modo = "fp8-armazenamento"
            except Exception as e:  # noqa
                print("[servidor] layerwise casting indisponível:", e, flush=True)
        self.pipe.enable_model_cpu_offload()
        if hasattr(self.pipe.vae, "enable_tiling"):
            self.pipe.vae.enable_tiling()
        self.tipo = tipo

    def sequencial(self):
        if self.modo.startswith("sequencial"):
            return False
        self.pipe.remove_all_hooks()
        torch.cuda.empty_cache()
        self.pipe.enable_sequential_cpu_offload()
        self.modo = "sequencial+" + self.modo
        return True


def gerar_clipe(motor, job):
    from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
    from diffusers.utils import encode_video, load_image
    import imageio_ffmpeg

    e = job.get("entrada") or {}
    dur = max(2.0, min(10.0, float(e.get("duracao_s") or 5)))
    seed = int(e.get("seed") or 1000)
    prompt = e.get("prompt_movimento") or e.get("prompt") or ""
    quadros = round(dur * 24)
    gerar = 8 * math.ceil((quadros - 1) / 8) + 1
    vertical = e.get("aspecto") == "9:16"
    kwargs = dict(prompt=prompt, num_frames=gerar, frame_rate=24.0, sigmas=DISTILLED_SIGMA_VALUES,
                  generator=torch.Generator("cuda").manual_seed(seed), output_type="np", return_dict=False, **DESTILADO)
    if e.get("imagem_url"):
        img = load_image(e["imagem_url"]).convert("RGB")
        w, h = tamanho_ltx(*img.size)
        if (w, h) != img.size:
            img = img.resize((w, h))
        motor.carregar("i2v")
        kwargs.update(image=img, width=w, height=h)
    else:
        w, h = (768, 1376) if vertical else (1376, 768)
        motor.carregar("t2v")
        kwargs.update(width=w, height=h)
    t1 = time.time()
    for tentativa in range(2):
        try:
            video, _a = motor.pipe(**kwargs)
            break
        except torch.OutOfMemoryError:
            torch.cuda.empty_cache()
            if tentativa == 0 and motor.sequencial():
                progresso(job["id"], "sem memória: mudando para descarregamento sequencial")
                continue
            raise
    gpu_s = time.time() - t1
    bruto, final = f"/root/bruto-{job['id']}.mp4", f"/root/clipe-{job['id']}.mp4"
    encode_video(video[0], fps=24, output_path=bruto)
    escala = "720:1280" if h > w else "1280:720"
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", bruto, "-frames:v", str(quadros),
                    "-vf", f"scale={escala}:flags=lanczos,setsar=1", "-r", "24", "-an", "-c:v", "libx264", "-crf", "16",
                    "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final], check=True)
    url = enviar(job["id"], final, "clipe.mp4")
    for f in (bruto, final):
        try:
            os.remove(f)
        except OSError:
            pass
    ew, eh = (int(x) for x in escala.split(":"))
    return {"url": url, "duracao_s": round(quadros / 24, 3), "largura": ew, "altura": eh, "quadros": quadros,
            "modo": motor.modo, "seed": seed}, gpu_s


def main():
    estado["gpu"] = torch.cuda.get_device_name(0)
    threading.Thread(target=batimento, daemon=True).start()
    motor = Motor()
    t0 = time.time()
    motor.carregar("i2v")
    estado["estado"] = "ligada"
    sinal()
    print(f"[servidor] LTX carregado em {time.time() - t0:.0f} s na {estado['gpu']} ({motor.modo})", flush=True)

    ociosa_desde = time.time()
    while True:
        try:
            r = api("jobs/pegar", {"tipos": ["clipe"], "gpu": estado["gpu"], "pod_id": POD})
        except Exception as e:  # noqa
            print("[servidor] pegar falhou:", e, flush=True)
            r = {}
        job = r.get("job")
        if not job:
            if estado["estado"] != "ociosa":
                estado["estado"] = "ociosa"
                sinal()
            if time.time() - ociosa_desde > OCIOSA_MIN * 60:
                print(f"[servidor] {OCIOSA_MIN:.0f} min sem trabalho: encerrando", flush=True)
                return
            time.sleep(15)
            continue
        estado["estado"] = "ligada"
        try:
            progresso(job["id"], f"gerando na {estado['gpu']}")
            resultado, gpu_s = gerar_clipe(motor, job)
            api("jobs/concluir", {"job_id": job["id"], "status": "pronto", "resultado": resultado,
                                  "segundos_gpu": round(gpu_s, 1), "gpu": estado["gpu"],
                                  "custo_usd": round(gpu_s / 3600 * CUSTO_HORA, 4)})
            print(f"[servidor] {job['id']}: pronto em {gpu_s:.0f} s", flush=True)
        except Exception:
            erro = traceback.format_exc()[-1500:]
            print(erro, flush=True)
            try:
                api("jobs/concluir", {"job_id": job["id"], "status": "falhou", "erro": erro, "gpu": estado["gpu"]})
            except Exception as e:  # noqa
                print("[servidor] concluir falhou:", e, flush=True)
        ociosa_desde = time.time()


if __name__ == "__main__":
    main()
