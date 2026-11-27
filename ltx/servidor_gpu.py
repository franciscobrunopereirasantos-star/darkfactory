# Servidor de clipes da API de geração: carrega o LTX-2.5 uma vez, atende a fila de jobs "clipe"
# e encerra depois de GPU_OCIOSA_MIN minutos sem trabalho (o pod.sh desliga a GPU na saída).
import json, math, os, subprocess, threading, time, traceback, urllib.request

import torch

BASE = os.environ["FABRICA_URL"].rstrip("/")
TOKEN = os.environ["FABRICA_WORKER_TOKEN"]
MODELO = os.environ.get("LTX_DIR", "/workspace/ltx")
QWEN_DIR = os.environ.get("QWEN_DIR", os.path.join(os.path.dirname(MODELO.rstrip("/")), "qwen"))
QWEN_REPO = "Qwen/Qwen-Image-Edit-2509"
LIGHTNING = ("lightx2v/Qwen-Image-Lightning", "Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors")
POD = os.environ.get("RUNPOD_POD_ID", "")
CUSTO_HORA = float(os.environ.get("CUSTO_HORA", "0") or 0)
OCIOSA_MIN = float(os.environ.get("GPU_OCIOSA_MIN", "10"))
INICIO_POD = float(os.environ.get("INICIO_POD", time.time()))
# Trava (F15): se a GPU ficar TRAVADA_MIN minutos sem nenhum progresso, o processo encerra e o pod.sh desliga a GPU
# (para de cobrar). O job fica em 'processando' e a fábrica o reabre e religa a GPU sozinha depois de 15 min.
TRAVADA_MIN = float(os.environ.get("GPU_TRAVADA_MIN", "20"))
ultimo_progresso = {"t": time.time(), "onde": "inicio"}


def marcar(onde):
    ultimo_progresso["t"] = time.time()
    ultimo_progresso["onde"] = onde


def vigia_trava():
    while True:
        time.sleep(30)
        if ultimo_progresso.get("baixando"):  # download de pesos grandes pode passar do limite: não conta como trava
            marcar("baixando pesos")
            continue
        parado = time.time() - ultimo_progresso["t"]
        if parado > TRAVADA_MIN * 60:
            msg = f"GPU travada: {parado / 60:.0f} min sem progresso (em {ultimo_progresso['onde']}); desligando para não cobrar"
            print(f"[servidor] {msg}", flush=True)
            try:
                api("gpu/sinal", {"pod_id": POD, "gpu": estado["gpu"], "estado": "travada", "custo_hora": CUSTO_HORA,
                                  "mensagem": msg, "segundos_desde_ligar": round(time.time() - INICIO_POD)}, timeout=15)
            except Exception:  # noqa
                pass
            os._exit(3)
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
    marcar(f"job {job}")
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


def ajustar_orientacao(img, aspecto):
    """Rede de segurança: se a imagem veio na orientação errada para o vídeo, corta o centro na proporção certa
    (nunca encaixa com faixas). aspecto "9:16" → vertical; "16:9" → horizontal; vazio → mantém."""
    if aspecto not in ("9:16", "16:9"):
        return img
    alvo = 9 / 16 if aspecto == "9:16" else 16 / 9
    w, h = img.size
    atual = w / h
    if (alvo < 1) == (atual < 1) and abs(atual - alvo) / alvo < 0.15:
        return img
    if atual > alvo:  # larga demais: corta as laterais
        nw = max(16, round(h * alvo))
        x = (w - nw) // 2
        caixa = (x, 0, x + nw, h)
    else:  # alta demais: corta em cima e embaixo
        nh = max(16, round(w / alvo))
        y = (h - nh) // 2
        caixa = (0, y, w, y + nh)
    print(f"[gpu] imagem {w}x{h} fora do formato {aspecto}: corte central {caixa}", flush=True)
    return img.crop(caixa)


def tamanho_ltx(w, h):
    if w % 32 == 0 and h % 32 == 0 and w <= 1376:
        return w, h
    s = 1376 / w if w >= h else 1376 / h
    return max(32, int(round(w * s / 32)) * 32), max(32, int(round(h * s / 32)) * 32)


class Motor:
    """Mantém um pipeline carregado (LTX image-to-video, text-to-video ou Qwen de imagem) e troca quando precisa."""

    def __init__(self):
        self.pipe, self.tipo, self.modo, self.lightning = None, None, "bf16", False
        self.vram = torch.cuda.get_device_properties(0).total_memory / 2**30

    def carregar(self, tipo):
        if self.tipo == tipo:
            return
        if self.pipe is not None:
            del self.pipe
            self.pipe, self.tipo = None, None
            torch.cuda.empty_cache()
        if tipo == "qwen":
            return self.carregar_qwen()
        from diffusers import LTX2ImageToVideoPipeline, LTX2Pipeline
        cls = LTX2ImageToVideoPipeline if tipo.startswith("i2v") else LTX2Pipeline
        try:
            self.pipe = cls.from_pretrained(MODELO, dtype=torch.bfloat16)
        except TypeError:
            self.pipe = cls.from_pretrained(MODELO, torch_dtype=torch.bfloat16)
        self.modo = "bf16"
        if tipo.endswith("_alta"):
            # Qualidade alta: troca o transformer destilado (padrão do repositório) pelo completo (transformer_full),
            # que é o feito para 40 passos com guidance. Baixa na 1ª vez (não vem no download padrão do pod).
            completo = os.path.join(MODELO, "transformer_full")
            if not os.path.isfile(os.path.join(completo, ".ok")):
                from huggingface_hub import snapshot_download
                t = time.time()
                ultimo_progresso["baixando"] = True
                try:
                    snapshot_download("Lightricks/LTX-2.5-Diffusers", local_dir=MODELO, allow_patterns=["transformer_full/*"],
                                      token=os.environ.get("HF_TOKEN") or None)
                finally:
                    ultimo_progresso["baixando"] = False
                    marcar("transformer_full baixado")
                open(os.path.join(completo, ".ok"), "w").write("ok")
                print(f"[servidor] transformer_full baixado em {time.time() - t:.0f} s", flush=True)
            tcls = type(self.pipe.transformer)
            antigo = self.pipe.transformer
            try:
                novo = tcls.from_pretrained(MODELO, subfolder="transformer_full", dtype=torch.bfloat16)
            except TypeError:
                novo = tcls.from_pretrained(MODELO, subfolder="transformer_full", torch_dtype=torch.bfloat16)
            self.pipe.transformer = novo
            del antigo
            self.modo = "bf16-completo"
        if self.vram < 70:
            try:
                self.pipe.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)
                self.modo = "fp8-armazenamento"
            except Exception as e:  # noqa
                print("[servidor] layerwise casting indisponível:", e, flush=True)
        self.na_gpu_ou_offload()
        if hasattr(self.pipe.vae, "enable_tiling"):
            self.pipe.vae.enable_tiling()
        self.tipo = tipo

    def na_gpu_ou_offload(self):
        """Com 70+ GB de VRAM deixa o pipeline inteiro na GPU (sem ida e volta pela RAM a cada clipe);
        se não couber, volta para o descarregamento por modelo."""
        if self.vram >= 70 and os.environ.get("GPU_SEM_OFFLOAD", "1") == "1":
            try:
                self.pipe.to("cuda")
                self.modo += "+gpu"
                return
            except torch.OutOfMemoryError:
                print("[servidor] não coube inteiro na GPU: usando offload", flush=True)
                self.pipe.to("cpu")
                torch.cuda.empty_cache()
        self.pipe.enable_model_cpu_offload()

    def carregar_qwen(self):
        from diffusers import QwenImageEditPlusPipeline
        if not os.path.isfile(os.path.join(QWEN_DIR, ".ok")):
            from huggingface_hub import snapshot_download
            t = time.time()
            ultimo_progresso["baixando"] = True
            try:
                snapshot_download(QWEN_REPO, local_dir=QWEN_DIR, token=os.environ.get("HF_TOKEN") or None)
            finally:
                ultimo_progresso["baixando"] = False
                marcar("Qwen baixado")
            open(os.path.join(QWEN_DIR, ".ok"), "w").write("ok")
            print(f"[servidor] pesos do Qwen baixados em {time.time() - t:.0f} s", flush=True)
        self.pipe = QwenImageEditPlusPipeline.from_pretrained(QWEN_DIR, torch_dtype=torch.bfloat16)
        self.lightning = False
        try:
            # atalho Lightning (8 passos) fundido nos pesos antes do fp8: LoRA solto quebra com layerwise casting
            self.pipe.load_lora_weights(LIGHTNING[0], weight_name=LIGHTNING[1])
            self.pipe.fuse_lora()
            self.pipe.unload_lora_weights()
            self.lightning = True
        except Exception as e:  # noqa
            print("[servidor] Lightning indisponível:", e, flush=True)
        self.modo = "bf16"
        if self.vram < 70:
            try:
                self.pipe.transformer.enable_layerwise_casting(storage_dtype=torch.float8_e4m3fn, compute_dtype=torch.bfloat16)
                self.modo = "fp8-armazenamento"
            except Exception as e:  # noqa
                print("[servidor] layerwise casting indisponível (qwen):", e, flush=True)
        self.na_gpu_ou_offload()
        self.tipo = "qwen"

    def sequencial(self):
        if "+gpu" in self.modo:
            # 1º degrau: estava inteiro na GPU e faltou memória → offload por modelo
            self.pipe.to("cpu")
            torch.cuda.empty_cache()
            self.pipe.enable_model_cpu_offload()
            self.modo = self.modo.replace("+gpu", "")
            return True
        if self.modo.startswith("sequencial"):
            return False
        self.pipe.remove_all_hooks()
        torch.cuda.empty_cache()
        self.pipe.enable_sequential_cpu_offload()
        self.modo = "sequencial+" + self.modo
        return True


def carregar_motor(motor, base, alta, job):
    """Carrega o pipeline; no modo alto usa o transformer completo. Se não der, volta para o rápido (e avisa)."""
    if alta:
        try:
            if motor.tipo != base + "_alta":
                progresso(job["id"], f"gerando na {estado['gpu']} (qualidade alta: carregando o transformer completo do LTX)")
            motor.carregar(base + "_alta")
            return True
        except Exception as erro:  # noqa
            progresso(job["id"], f"qualidade alta indisponível ({str(erro)[:200]}): gerando no modo rápido")
            motor.pipe, motor.tipo = None, None
            torch.cuda.empty_cache()
    motor.carregar(base)
    return False


AUDIO_SR = 16000  # entrada do VAE de áudio do LTX-2 (mel 64 bins, hop 160, n_fft 1024)


def _hz_para_mel_slaney(f):
    f = torch.as_tensor(f, dtype=torch.float64)
    f_sp, min_log_hz, min_log_mel, logstep = 200.0 / 3, 1000.0, 15.0, math.log(6.4) / 27.0
    mel = f / f_sp
    return torch.where(f >= min_log_hz, min_log_mel + torch.log(torch.clamp(f, min=1e-10) / min_log_hz) / logstep, mel)


def _mel_para_hz_slaney(m):
    m = torch.as_tensor(m, dtype=torch.float64)
    f_sp, min_log_hz, min_log_mel, logstep = 200.0 / 3, 1000.0, 15.0, math.log(6.4) / 27.0
    return torch.where(m >= min_log_mel, min_log_hz * torch.exp(logstep * (m - min_log_mel)), f_sp * m)


def banco_mel(sr=AUDIO_SR, n_fft=1024, n_mels=64):
    """Banco de filtros mel igual ao torchaudio (mel_scale="slaney", norm="slaney", f_min=0, f_max=sr/2),
    sem depender do torchaudio (não está instalado no pod). Saída: [n_freqs, n_mels]."""
    n_freqs = n_fft // 2 + 1
    freqs = torch.linspace(0, sr / 2, n_freqs, dtype=torch.float64)
    m_pts = torch.linspace(float(_hz_para_mel_slaney(0.0)), float(_hz_para_mel_slaney(sr / 2)), n_mels + 2, dtype=torch.float64)
    f_pts = _mel_para_hz_slaney(m_pts)
    f_diff = f_pts[1:] - f_pts[:-1]
    slopes = f_pts.unsqueeze(0) - freqs.unsqueeze(1)
    down = -slopes[:, :-2] / f_diff[:-1]
    up = slopes[:, 2:] / f_diff[1:]
    fb = torch.clamp(torch.minimum(down, up), min=0.0)
    fb = fb * (2.0 / (f_pts[2:n_mels + 2] - f_pts[:n_mels])).unsqueeze(0)
    return fb.float()


def log_mel(onda, sr=AUDIO_SR, n_fft=1024, hop=160, n_mels=64):
    """Onda [canais, amostras] (16 kHz) → log-mel [1, canais, tempo, n_mels], como o AudioProcessor do LTX-2
    (MelSpectrogram power=1, janela hann, center=True, reflect; log(clamp(1e-5)))."""
    espec = torch.stft(onda.float(), n_fft=n_fft, hop_length=hop, win_length=n_fft, window=torch.hann_window(n_fft),
                       center=True, pad_mode="reflect", return_complex=True).abs()  # [C, freqs, T]
    mel = torch.matmul(espec.transpose(1, 2), banco_mel(sr, n_fft, n_mels))  # [C, T, n_mels]
    return torch.log(torch.clamp(mel, min=1e-5)).unsqueeze(0)


def ler_audio(caminho, sr=AUDIO_SR, segundos=None):
    """Decodifica qualquer áudio (mp3/wav/m4a) com o ffmpeg em estéreo float32 → tensor [2, amostras]."""
    import numpy as np
    import imageio_ffmpeg
    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-loglevel", "error", "-i", caminho, "-ac", "2", "-ar", str(sr), "-f", "f32le", "-"]
    bruto = subprocess.run(cmd, check=True, capture_output=True).stdout
    onda = torch.from_numpy(np.frombuffer(bruto, dtype=np.float32).copy()).view(-1, 2).t().contiguous()
    if segundos is not None:
        alvo = int(round(segundos * sr))
        onda = onda[:, :alvo] if onda.shape[1] >= alvo else torch.nn.functional.pad(onda, (0, alvo - onda.shape[1]))
    return onda


def baixar_arquivo(url, destino):
    req = urllib.request.Request(url, headers={"user-agent": "darkfactory-gpu"})
    with urllib.request.urlopen(req, timeout=120) as r, open(destino, "wb") as f:
        f.write(r.read())
    return destino


def duracao_audio(caminho):
    return ler_audio(caminho).shape[1] / AUDIO_SR


def latentes_audio_fixo(pipe, caminho, segundos):
    """Voz fixa sincronizada (F-voz, 27/11): codifica a fala pronta (ElevenLabs) no VAE de áudio do LTX e devolve
    os latentes já normalizados e empacotados, no formato que o transformer recebe em audio_hidden_states."""
    onda = ler_audio(caminho, segundos=segundos)
    mel = log_mel(onda)
    vae = pipe.audio_vae
    dispositivo = next(vae.parameters()).device
    tipo = next(vae.parameters()).dtype
    with torch.no_grad():
        dist = vae.encode(mel.to(dispositivo, tipo)).latent_dist
        bruto = dist.mode() if hasattr(dist, "mode") else dist.mean  # [1, 8, L, 16]
    # o encoder causal devolve 1 quadro a mais; corta no tamanho que o pipeline usaria para essa duração (como o LTX oficial)
    por_s = getattr(pipe, "audio_sampling_rate", AUDIO_SR) / getattr(pipe, "audio_hop_length", 160) \
        / float(getattr(pipe, "audio_vae_temporal_compression_ratio", 4))
    bruto = bruto[:, :, :max(1, round(segundos * por_s))]
    limpo = pipe.prepare_audio_latents(latents=bruto.float(), noise_scale=0.0, dtype=torch.float32, device="cuda")
    print(f"[servidor] voz fixa: {segundos:.2f} s → mel {tuple(mel.shape)} → latentes {tuple(bruto.shape)}", flush=True)
    return bruto, limpo


def congelar_audio(transformer, limpo):
    """Durante toda a amostragem o transformer recebe o áudio LIMPO (timestep 0) no lugar do áudio que estaria sendo
    gerado: o vídeo é guiado pela fala pronta e a boca acompanha. Mesma ideia do A2VidPipeline oficial (áudio
    'frozen', noise_scale 0). Devolve o handle para remover o gancho depois."""
    def gancho(_modulo, args, kwargs):
        if "audio_hidden_states" in kwargs and kwargs["audio_hidden_states"] is not None:
            atual = kwargs["audio_hidden_states"]
            kwargs["audio_hidden_states"] = limpo.to(atual.device, atual.dtype).expand(atual.shape[0], -1, -1)
            if kwargs.get("audio_timestep") is not None:
                kwargs["audio_timestep"] = torch.zeros_like(kwargs["audio_timestep"])
            if kwargs.get("sigma") is not None:  # modelos que modulam pelo sigma: o do áudio também é 0 (áudio limpo)
                kwargs["audio_sigma"] = torch.zeros_like(kwargs["sigma"])
        return args, kwargs
    return transformer.register_forward_pre_hook(gancho, with_kwargs=True)


def gerar_clipe(motor, job):
    from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
    from diffusers.utils import encode_video, load_image
    import imageio_ffmpeg

    e = job.get("entrada") or {}
    # Voz fixa sincronizada: a fala chega pronta (audio_url, voz fixa do personagem) e o LTX só anima seguindo o áudio.
    audio_fixo = None
    if e.get("audio_url"):
        audio_fixo = baixar_arquivo(e["audio_url"], f"/root/fala-{job['id']}")
        dur_fala = duracao_audio(audio_fixo)
        folga = float(e.get("folga_s") if e.get("folga_s") is not None else 0.3)
        e = dict(e, duracao_s=max(float(e.get("duracao_s") or 0), dur_fala + folga))
        progresso(job["id"], f"voz fixa: fala de {dur_fala:.2f} s, clipe de {min(10.0, e['duracao_s']):.2f} s")
    dur = max(2.0, min(10.0, float(e.get("duracao_s") or 5)))
    seed = int(e.get("seed") or 1000)
    prompt = e.get("prompt_movimento") or e.get("prompt") or ""
    # Voz nativa (padrão das novelas desde 18/11): o próprio LTX gera a fala junto com o vídeo (boca sincronizada).
    nativa = audio_fixo is None and bool(e.get("voz_nativa")) and bool(str(e.get("fala_texto") or "").strip())
    if audio_fixo is not None:
        prompt = (prompt.rstrip(". ") + ". Only this character speaks, perfect lip sync"
                  + (", saying: \"" + str(e["fala_texto"]).strip() + "\"" if str(e.get("fala_texto") or "").strip() else "")
                  + ". The mouth moves only while the voice is heard and is closed and still before and after.")
    if nativa:
        prompt = (prompt.rstrip(". ") + ". Only this character speaks, in Brazilian Portuguese, with "
                  + (e.get("voz_descricao") or "an expressive voice") + ", perfect lip sync, saying: \""
                  + str(e["fala_texto"]).strip() + "\" Comedic soap-opera tone, quiet room ambience, no music.")
    quadros = round(dur * 24)
    gerar = 8 * math.ceil((quadros - 1) / 8) + 1
    vertical = e.get("aspecto") == "9:16"
    # Qualidade "alta" (só a novela das frutinhas, por decisão do Francisco em 18/11): amostragem completa do LTX
    # (mais passos, guidance e STG nos padrões do pipeline) em vez do atalho destilado de 8 passos. 4–6x mais lenta.
    alta = str(e.get("qualidade") or "").lower() == "alta"
    kwargs = dict(prompt=prompt, num_frames=gerar, frame_rate=24.0,
                  generator=torch.Generator("cuda").manual_seed(seed), output_type="np", return_dict=False)
    if alta:
        kwargs.update(num_inference_steps=int(e.get("passos") or os.environ.get("LTX_PASSOS_ALTA", "40")))
        if e.get("negative_prompt") or os.environ.get("LTX_NEGATIVO_ALTA"):
            kwargs["negative_prompt"] = e.get("negative_prompt") or os.environ["LTX_NEGATIVO_ALTA"]
        batida = {"t": time.time()}

        def a_cada_passo(pipe, i, t, cb_kwargs):
            # mantém o sinal "gerando na ..." vivo: um clipe alto leva 10–20 min e o tick religa a GPU após 15 min sem sinal
            if time.time() - batida["t"] > 90:
                batida["t"] = time.time()
                progresso(job["id"], f"gerando na {estado['gpu']} (qualidade alta, passo {i + 1}/{kwargs['num_inference_steps']})")
            return {}
    else:
        kwargs.update(sigmas=DISTILLED_SIGMA_VALUES, **DESTILADO)
    if e.get("imagem_url"):
        img = load_image(e["imagem_url"]).convert("RGB")
        img = ajustar_orientacao(img, e.get("aspecto"))
        w, h = tamanho_ltx(*img.size)
        if (w, h) != img.size:
            img = img.resize((w, h))
        alta = carregar_motor(motor, "i2v", alta, job)
        kwargs.update(image=img, width=w, height=h)
    else:
        w, h = (768, 1376) if vertical else (1376, 768)
        alta = carregar_motor(motor, "t2v", alta, job)
        kwargs.update(width=w, height=h)
    if not alta and "num_inference_steps" in kwargs:  # caiu para o rápido ao carregar
        for k in ("num_inference_steps", "negative_prompt"):
            kwargs.pop(k, None)
        kwargs.update(sigmas=DISTILLED_SIGMA_VALUES, **DESTILADO)
    if alta and "callback_on_step_end" not in kwargs:
        try:
            import inspect
            if "callback_on_step_end" in inspect.signature(motor.pipe.__call__).parameters:
                kwargs["callback_on_step_end"] = a_cada_passo
        except Exception:  # noqa
            pass
    gancho = None
    if audio_fixo is not None:
        bruto_lat, limpo = latentes_audio_fixo(motor.pipe, audio_fixo, gerar / 24.0)
        kwargs["audio_latents"] = bruto_lat.float()
        gancho = congelar_audio(motor.pipe.transformer, limpo)
    t1 = time.time()
    try:
        video, audio_ltx = _amostrar(motor, kwargs, alta, job, DISTILLED_SIGMA_VALUES)
    finally:
        if gancho is not None:
            gancho.remove()
    alta = kwargs.pop("_alta_final", alta)
    gpu_s = time.time() - t1
    quadros_np = video[0]
    audio_np = audio_ltx[0].float().cpu() if (nativa and audio_ltx is not None) else None
    taxa_audio = getattr(getattr(motor.pipe, "vocoder", None), "config", None)
    taxa_audio = getattr(taxa_audio, "output_sampling_rate", 24000) if taxa_audio is not None else 24000
    del video, audio_ltx
    modo = motor.modo

    def finalizar():
        bruto, final = f"/root/bruto-{job['id']}.mp4", f"/root/clipe-{job['id']}.mp4"
        if audio_np is not None:
            encode_video(quadros_np, fps=24, audio=audio_np, audio_sample_rate=taxa_audio, output_path=bruto)
        else:
            encode_video(quadros_np, fps=24, output_path=bruto)
        escala = "720:1280" if h > w else "1280:720"
        tem_audio = audio_np is not None or audio_fixo is not None
        entradas = ["-i", bruto] + (["-i", audio_fixo] if audio_fixo is not None else [])
        # voz fixa: a fala original (ElevenLabs) vai intacta para o clipe, completada com silêncio até o fim
        mapa = (["-map", "0:v:0", "-map", "1:a:0", "-af", "apad", "-t", f"{quadros / 24:.3f}"] if audio_fixo is not None else [])
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", *entradas, *mapa, "-frames:v", str(quadros),
                        "-vf", f"scale={escala}:flags=lanczos,setsar=1", "-r", "24",
                        *(["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] if tem_audio else ["-an"]),
                        "-c:v", "libx264", "-crf", "16",
                        "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final], check=True)
        url = enviar(job["id"], final, "clipe.mp4")
        for f in (bruto, final, audio_fixo):
            try:
                if f:
                    os.remove(f)
            except OSError:
                pass
        ew, eh = (int(x) for x in escala.split(":"))
        return {"url": url, "duracao_s": round(quadros / 24, 3), "largura": ew, "altura": eh, "quadros": quadros,
                "modo": modo + ("+alta" if alta else "") + ("+voz" if audio_np is not None else "")
                + ("+voz-fixa" if audio_fixo is not None else ""), "seed": seed,
                "tem_audio": tem_audio, "voz_fixa": audio_fixo is not None}

    return finalizar, gpu_s


def _amostrar(motor, kwargs, alta, job, DISTILLED_SIGMA_VALUES):
    """Roda o pipeline com as mesmas proteções de antes (alta recusada → rápido; falta de memória → offload).
    Se cair para o rápido, grava kwargs["_alta_final"] = False para o resultado informar o modo real."""
    for tentativa in range(3):
        try:
            try:
                return motor.pipe(**kwargs)
            except (TypeError, ValueError) as erro:
                if not alta:
                    raise
                # se o modo alto não for aceito por este checkpoint, entrega no modo rápido em vez de falhar
                progresso(job["id"], f"qualidade alta recusada ({str(erro)[:200]}): gerando no modo rápido")
                for k in ("num_inference_steps", "negative_prompt", "callback_on_step_end"):
                    kwargs.pop(k, None)
                kwargs.update(sigmas=DISTILLED_SIGMA_VALUES, **DESTILADO)
                alta = False
                resultado = motor.pipe(**kwargs)
                kwargs["_alta_final"] = False
                return resultado
        except torch.OutOfMemoryError:
            torch.cuda.empty_cache()
            if tentativa < 2 and motor.sequencial():
                progresso(job["id"], "sem memória: mudando para descarregamento sequencial")
                continue
            raise


def limpar_disco(minimo_gb=15):
    """Se o disco do pod estiver quase cheio, apaga sobras (vídeos/imagens temporários e caches de pip/HF)."""
    import shutil, glob
    livre = shutil.disk_usage("/root").free / 2**30
    if livre >= minimo_gb:
        return
    print(f"[servidor] disco com {livre:.1f} GB livres: limpando temporários", flush=True)
    # Não apaga /root/imagem-*, bruto-* e clipe-*: são de entregas ainda em andamento na thread de fundo
    # (apagar ali causava FileNotFoundError no envio e mandava a imagem para o fallback pago). Cada entrega
    # já remove o próprio arquivo depois do upload.
    for padrao in ("/root/work/ref-*.png",):
        for f in glob.glob(padrao):
            try:
                os.remove(f)
            except OSError:
                pass
    shutil.rmtree(os.path.expanduser("~/.cache/pip"), ignore_errors=True)
    for x in glob.glob("/tmp/*"):
        if os.path.isdir(x):
            shutil.rmtree(x, ignore_errors=True)
    print(f"[servidor] disco agora com {shutil.disk_usage('/root').free / 2**30:.1f} GB livres", flush=True)


def baixar_imagem(url):
    from PIL import Image
    import io
    req = urllib.request.Request(url, headers={"user-agent": "darkfactory-gpu"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGB")


def gerar_imagem(motor, job):
    e = job.get("entrada") or {}
    vertical = e.get("aspecto") == "9:16"
    largura = int(e.get("largura") or (768 if vertical else 1376))
    altura = int(e.get("altura") or (1376 if vertical else 768))
    if e.get("aspecto") in ("9:16", "16:9") and (largura < altura) != vertical:
        largura, altura = altura, largura  # pedido 9:16 nunca gera imagem deitada (e vice-versa)
    largura, altura = max(256, largura // 16 * 16), max(256, altura // 16 * 16)
    seed = int(e.get("seed") or 42)
    motor.carregar("qwen")
    passos = int(e.get("passos") or (8 if motor.lightning else 40))
    rapido = motor.lightning
    refs = [baixar_imagem(u) for u in (e.get("referencias_url") or [])][:3]
    prompt = (e.get("prompt") or "").strip()
    if refs:
        prompt = ("Keep the exact faces, hair and outfits of the characters in the reference image(s). " + prompt)
    if e.get("estilo"):
        prompt += f" Style: {e['estilo']}."
    kw = dict(prompt=prompt, width=largura, height=altura, num_inference_steps=passos,
              true_cfg_scale=1.0 if rapido else 4.0, negative_prompt=" ",
              generator=torch.Generator("cuda").manual_seed(seed))
    if refs:
        kw["image"] = refs
    else:
        # O Qwen-Image-Edit exige uma imagem de entrada: cena sem personagem/referência recebia image=None e
        # quebrava (AttributeError ... 'NoneType' has no attribute 'size'), caindo no fallback pago. Usa uma tela
        # neutra do tamanho pedido e manda o modelo criar a cena do zero sobre ela.
        from PIL import Image
        kw["image"] = [Image.new("RGB", (largura, altura), (128, 128, 128))]
        kw["prompt"] = ("Replace the plain gray canvas entirely with a brand-new, fully detailed scene. " + prompt)
    t1 = time.time()
    img = motor.pipe(**kw).images[0]
    gpu_s = time.time() - t1
    modo = motor.modo

    def finalizar():
        arq = f"/root/imagem-{job['id']}.png"
        img.save(arq)
        url = enviar(job["id"], arq, "imagem.png", "image/png")
        try:
            os.remove(arq)
        except OSError:
            pass
        return {"url": url, "largura": img.width, "altura": img.height, "modelo": "qwen-image-edit-2509",
                "passos": passos, "seed": seed, "modo": modo}

    return finalizar, gpu_s


def concluir_falha(job_id):
    erro = traceback.format_exc()[-1500:]
    print(erro, flush=True)
    try:
        api("jobs/concluir", {"job_id": job_id, "status": "falhou", "erro": erro, "gpu": estado["gpu"]})
    except Exception as e:  # noqa
        print("[servidor] concluir falhou:", e, flush=True)


def main():
    from concurrent.futures import ThreadPoolExecutor
    estado["gpu"] = torch.cuda.get_device_name(0)
    threading.Thread(target=batimento, daemon=True).start()
    threading.Thread(target=vigia_trava, daemon=True).start()
    motor = Motor()
    t0 = time.time()
    motor.carregar("i2v")
    estado["estado"] = "ligada"
    marcar("LTX carregado")
    sinal()
    print(f"[servidor] LTX carregado em {time.time() - t0:.0f} s na {estado['gpu']} ({motor.modo})", flush=True)

    # ffmpeg + upload + concluir rodam aqui, enquanto a GPU já gera o próximo job
    fundo = ThreadPoolExecutor(max_workers=1)
    pendentes = []

    def entregar(job, finalizar, gpu_s, t_job):
        try:
            resultado = finalizar()
            api("jobs/concluir", {"job_id": job["id"], "status": "pronto", "resultado": resultado,
                                  "segundos_gpu": round(gpu_s, 1), "gpu": estado["gpu"],
                                  "custo_usd": round(gpu_s / 3600 * CUSTO_HORA, 4)})
            marcar(f"job {job['id']} entregue")
            print(f"[servidor] {job['id']}: pronto ({gpu_s:.0f} s de GPU, {time.time() - t_job:.0f} s no total)", flush=True)
        except Exception:  # noqa
            concluir_falha(job["id"])

    ociosa_desde = time.time()
    while True:
        pendentes = [f for f in pendentes if not f.done()]
        while len(pendentes) >= 2:
            pendentes[0].result()
            pendentes = [f for f in pendentes if not f.done()]
        # Primeiro pede o tipo do modelo que já está carregado (evita trocar LTX<->Qwen a cada job, que custa
        # minutos de GPU); só quando acabar esse tipo pede o outro.
        atual = "imagem_gpu" if motor.tipo == "qwen" else "clipe"
        job = None
        for tipos in ([atual], ["clipe", "imagem_gpu"]):
            try:
                r = api("jobs/pegar", {"tipos": tipos, "gpu": estado["gpu"], "pod_id": POD})
            except Exception as e:  # noqa
                print("[servidor] pegar falhou:", e, flush=True)
                r = {}
            job = r.get("job")
            if job:
                break
        if job:
            limpar_disco()
        if not job:
            if pendentes:
                time.sleep(5)
                continue
            if estado["estado"] != "ociosa":
                estado["estado"] = "ociosa"
                sinal()
            if time.time() - ociosa_desde > OCIOSA_MIN * 60:
                print(f"[servidor] {OCIOSA_MIN:.0f} min sem trabalho: encerrando", flush=True)
                fundo.shutdown(wait=True)
                return
            marcar("ociosa")
            time.sleep(15)
            continue
        estado["estado"] = "ligada"
        t_job = time.time()
        try:
            progresso(job["id"], f"gerando na {estado['gpu']}")
            if job.get("tipo") == "imagem_gpu":
                finalizar, gpu_s = gerar_imagem(motor, job)
            else:
                finalizar, gpu_s = gerar_clipe(motor, job)
            pendentes.append(fundo.submit(entregar, job, finalizar, gpu_s, t_job))
            marcar(f"job {job['id']} gerado")
        except Exception:  # noqa
            concluir_falha(job["id"])
        ociosa_desde = time.time()


if __name__ == "__main__":
    main()
