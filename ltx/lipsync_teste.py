# Teste 2 da novela das frutinhas (18/11): sincronia labial DEPOIS, com o LatentSync 1.6 (ByteDance) na GPU.
# Entrada: clipes do teste 1 (LTX, um personagem falando por cena) + a voz aprovada da cena (ElevenLabs).
# O LatentSync é treinado com rosto humano: se não achar rosto na fruta, o erro é registrado por cena.
import json, os, subprocess, time, traceback, urllib.request

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
PEDIDO = os.environ["PEDIDO_ID"]
W, LS = "/root/work", "/root/work/LatentSync"
G = "https://www.getdarkfactory.com/api/public/fabrica/arquivo/geracao/%s/%s"
PARES = [
    ("Banana flagra", "e8bc767b-056b-45e5-b310-4ff6d7fd9010", "8f8295c6-d1ff-4fd7-adeb-4a891df7eaa5"),
    ("Uva debocha", "b318bb68-529d-4527-9416-8079cd0a2ccd", "c61a1305-fc58-48a8-bae6-71edcf95e05d"),
    ("Morango pede calma", "81a41c36-ddf2-41cb-a0c2-9699eae01a48", "090366f3-2835-4879-8668-821c6e7b40b8"),
    ("Banana liquidificador", "b13b0399-b993-4352-9624-cef7770896d7", "c14e6df2-2c91-43f5-b9e5-5d546bea4e35"),
]


def api(caminho, corpo):
    req = urllib.request.Request(f"{BASE}/api/public/fabrica/worker/{caminho}", data=json.dumps(corpo).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def avisar(etapa, msg, dados=None, pct=50):
    print(f"[lipsync] {etapa}: {msg}", flush=True)
    try:
        api("progresso", {"pedido_id": PEDIDO, "etapa": etapa, "progresso": pct, "mensagem": msg[:1900], "dados": dados or {}})
    except Exception as e:  # noqa
        print("[lipsync] aviso não enviado:", e, flush=True)


def enviar(arquivo, nome):
    r = api("upload-url", {"pedido_id": PEDIDO, "nome": nome})
    with open(arquivo, "rb") as f:
        urllib.request.urlopen(urllib.request.Request(r["upload_url"], data=f.read(), method="PUT",
                               headers={"content-type": "video/mp4", "x-upsert": "true"}), timeout=300).read()
    return r["url_final"]


def baixar(url, destino):
    req = urllib.request.Request(url, headers={"user-agent": "darkfactory-gpu"})
    with urllib.request.urlopen(req, timeout=120) as r, open(destino, "wb") as f:
        f.write(r.read())
    return destino


def ff(*a):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *a], check=True)


def dur(arq):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", arq],
                         capture_output=True, text=True).stdout.strip()
    return float(out or 0)


def main():
    res, ok = [], []
    for i, (nome, clipe_id, voz_id) in enumerate(PARES):
        try:
            v = baixar(G % (clipe_id, "clipe.mp4"), f"{W}/c{i}.mp4")
            a = baixar(G % (voz_id, "voz.mp3"), f"{W}/v{i}.mp3")
            wav = f"{W}/v{i}.wav"
            ff("-i", a, "-ar", "16000", "-ac", "1", wav)
            d = dur(wav) + 0.3
            # vídeo do tamanho da fala (congela o último quadro se a fala for maior que o clipe), 25 fps
            vin = f"{W}/c{i}-in.mp4"
            ff("-i", v, "-vf", f"tpad=stop_mode=clone:stop_duration={d:.2f},fps=25,setsar=1", "-t", f"{d:.2f}", "-an",
               "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", vin)
            out = f"{W}/frutas-lipsync-cena{i + 1}.mp4"
            t1 = time.time()
            p = subprocess.run(["/root/ls/bin/python", "-m", "scripts.inference", "--unet_config_path", "configs/unet/stage2_512.yaml",
                                "--inference_ckpt_path", "checkpoints/latentsync_unet.pt", "--inference_steps", "20",
                                "--guidance_scale", "1.5", "--video_path", vin, "--audio_path", wav, "--video_out_path", out],
                               cwd=LS, capture_output=True, text=True, timeout=1500)
            g = time.time() - t1
            if p.returncode != 0 or not os.path.isfile(out):
                raise RuntimeError((p.stderr or p.stdout)[-700:])
            # devolve a voz original em qualidade cheia por cima do resultado
            final = f"{W}/frutas-lipsync-final{i + 1}.mp4"
            ff("-i", out, "-i", a, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "192k", "-shortest", final)
            url = enviar(final, os.path.basename(final))
            res.append({"cena": nome, "url": url, "segundos_gpu": round(g)})
            ok.append(final)
            avisar("clipe", f"{nome}: sincronia labial pronta em {g:.0f} s", {"url": url}, 40 + 12 * i)
        except Exception as e:  # noqa
            res.append({"cena": nome, "erro": str(e)[-600:]})
            avisar("clipe", f"{nome}: falhou — {str(e)[-500:]}", None, 40 + 12 * i)
    juntado = None
    if ok:
        lista = f"{W}/lista.txt"
        open(lista, "w").write("\n".join(f"file '{s}'" for s in ok))
        j = f"{W}/frutas-teste2-lipsync.mp4"
        ff("-f", "concat", "-safe", "0", "-i", lista, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", j)
        juntado = enviar(j, os.path.basename(j))
    avisar("fim", f"Teste 2 (sincronia labial) concluído: {len(ok)} de {len(PARES)} cenas",
           {"video_juntado": juntado, "cenas": res}, 100)
    print("Teste concluído", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        avisar("erro", "Falha geral: " + traceback.format_exc()[-1800:])
