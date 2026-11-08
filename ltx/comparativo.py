# Comparativo LTX-2.5 (image-to-video) x Veo 3.1 Lite, com as mesmas entradas usadas no Kairogen.
# Saída: 8 s, 1280x720, 24 fps, sem áudio. A imagem entra como primeiro quadro no tamanho original (1376x768).
import json, os, subprocess, time, traceback, urllib.request

import torch

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
PEDIDO = os.environ["PEDIDO_ID"]
MODELO = os.environ.get("LTX_DIR", "/root/work/ltx")
INICIO_POD = float(os.environ.get("INICIO_POD", time.time()))
IMG = "https://cdn.kairogen.ai/gallery/images/6ad2287a63742eb015a00e2a/"

CENAS = {
    "17": (IMG + "9cbcfc1a-bb2a-4d68-8a1e-ff3fc058c5eb.png",
           "The two young people stand still inside the elevator, quiet and disappointed; the metal elevator doors slide closed slowly in front of them until the gap disappears, reflections on the glass corridor, city lights outside. No dialogue, no readable text."),
    "01": (IMG + "0e821ab2-b874-40c5-b344-bbd8eb1babdc.png",
           "Slow push-in on the glowing old CRT monitor in the dark room; the cursor blinks in the empty search box and a few characters appear as if being typed (abstract, unreadable), subtle screen flicker, quiet hum. No dialogue, no readable text."),
    "09": (IMG + "95db59a8-87e7-436f-a3a0-dfd7064914a4.png",
           "Fingers type on the old laptop keyboard; on the screen, the result list blocks appear one after another in a quick cascade from top to bottom (abstract lines, unreadable), gentle glow on the hands, slow camera drift. No dialogue, no readable text."),
    "26": (IMG + "4c43f8f9-97f9-4837-8a29-31cf58040ad7.png",
           "The older man writes on the whiteboard with the marker, finishing a big question mark with a confident stroke, then turns his head slightly toward the room with a gentle smile; people in the background keep working; warm golden light, slow camera move. No dialogue, no readable text."),
    "30": (IMG + "95813967-b278-4068-869a-f48360548917.png",
           "Slow push-in through the incubator window at dusk toward the laptop screen with an empty text box and blinking cursor; the person at the desk starts typing; city lights flicker on outside, warm lamp glow. Hopeful ending. No dialogue, no readable text."),
}
DESTILADO = dict(guidance_scale=1.0, stg_scale=0.0, modality_scale=1.0, guidance_rescale=0.0,
                 audio_guidance_scale=1.0, audio_stg_scale=0.0, audio_modality_scale=1.0, audio_guidance_rescale=0.0)


def api(caminho, corpo):
    req = urllib.request.Request(f"{BASE}/api/public/fabrica/worker/{caminho}", data=json.dumps(corpo).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def avisar(etapa, msg, dados=None, pct=50):
    print(f"[cmp] {etapa}: {msg}", flush=True)
    try:
        api("progresso", {"pedido_id": PEDIDO, "etapa": etapa, "progresso": pct, "mensagem": msg[:1900], "dados": dados or {}})
    except Exception as e:  # noqa
        print("[cmp] aviso não enviado:", e, flush=True)


def enviar(arquivo, nome):
    r = api("upload-url", {"pedido_id": PEDIDO, "nome": nome})
    with open(arquivo, "rb") as f:
        urllib.request.urlopen(urllib.request.Request(r["upload_url"], data=f.read(), method="PUT",
                               headers={"content-type": "video/mp4", "x-upsert": "true"}), timeout=300).read()
    return r["url_final"]


def conferir(ffmpeg, arquivo):
    """Lê duração, tamanho, fps e se há áudio direto do arquivo final."""
    out = subprocess.run([ffmpeg, "-i", arquivo], capture_output=True, text=True).stderr
    import re
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
    seg = int(dur[1]) * 3600 + int(dur[2]) * 60 + float(dur[3]) if dur else None
    v = re.search(r"Video: .*?, (\d+)x(\d+).*?, ([\d.]+) fps", out)
    return {"duracao_s": seg, "largura": int(v[1]) if v else None, "altura": int(v[2]) if v else None,
            "fps": float(v[3]) if v else None, "tem_audio": "Audio:" in out}


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
    pipe.enable_model_cpu_offload()
    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    avisar("carregou", f"LTX image-to-video carregado em {time.time() - t0:.0f} s na {gpu}", {"gpu": gpu}, 40)

    resultados = []
    for num in [x.strip() for x in os.environ.get("CENAS_CMP", "17").split(",") if x.strip()]:
        url_img, prompt = CENAS[num]
        seed = 1000 + int(num)
        nome = f"cmp-cena{num}-ltx.mp4"
        try:
            img = load_image(url_img).convert("RGB")
            w, h = img.size  # 1376x768: múltiplos de 32, entra sem corte e sem redimensionar
            t1 = time.time()
            video, _audio = pipe(image=img, prompt=prompt, width=w, height=h, num_frames=193, frame_rate=24.0,
                                 sigmas=DISTILLED_SIGMA_VALUES, generator=torch.Generator("cuda").manual_seed(seed),
                                 output_type="np", return_dict=False, **DESTILADO)
            gpu_s = time.time() - t1
            bruto = f"/root/work/bruto-{num}.mp4"
            encode_video(video[0], fps=24, output_path=bruto)
            final = f"/root/work/{nome}"
            # 193 quadros gerados (o LTX exige 8n+1) -> corta para 192 (8,00 s); escala 1376x768 -> 1280x720; sem áudio
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", bruto, "-frames:v", "192", "-vf", "scale=1280:720:flags=lanczos",
                            "-r", "24", "-an", "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
                            "-movflags", "+faststart", final], check=True)
            conf = conferir(ffmpeg, final)
            url = enviar(final, nome)
            r = {"cena": num, "url": url, "seed": seed, "gpu": gpu, "segundos_gpu": round(gpu_s, 1),
                 "pronto_apos_inicio_pod_s": round(time.time() - INICIO_POD), "entrada": f"{w}x{h}", "quadros_gerados": 193, **conf}
            resultados.append(r)
            avisar("clipe", f"cena {num}: {gpu_s:.0f} s de GPU; {conf}", r, 80)
        except Exception:
            erro = traceback.format_exc()[-1500:]
            resultados.append({"cena": num, "erro": erro})
            avisar("erro", f"cena {num} falhou: {erro}", {"cena": num})
    avisar("fim", "Comparativo concluído", {"gpu": gpu, "resultados": resultados}, 100)
    print("Teste concluído", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        avisar("erro", "Falha geral: " + traceback.format_exc()[-1800:])
