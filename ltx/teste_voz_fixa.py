# Testes do modo "voz fixa sincronizada" do servidor_gpu.py, sem GPU e sem pesos do LTX.
# Uso: FABRICA_URL=x FABRICA_WORKER_TOKEN=x python ltx/teste_voz_fixa.py
import math, os, subprocess, sys, tempfile

os.environ.setdefault("FABRICA_URL", "http://teste")
os.environ.setdefault("FABRICA_WORKER_TOKEN", "teste")
sys.path.insert(0, os.path.dirname(__file__))
import torch  # noqa: E402
import servidor_gpu as s  # noqa: E402


def teste_mel_igual_torchaudio():
    import torchaudio
    torch.manual_seed(0)
    onda = torch.randn(2, 16000) * 0.1 + torch.sin(torch.linspace(0, 440 * 2 * math.pi, 16000))
    ref = torchaudio.transforms.MelSpectrogram(sample_rate=16000, n_fft=1024, win_length=1024, hop_length=160, f_min=0.0,
                                               f_max=8000.0, n_mels=64, window_fn=torch.hann_window, center=True,
                                               pad_mode="reflect", power=1.0, mel_scale="slaney", norm="slaney")(onda)
    ref = torch.log(torch.clamp(ref, min=1e-5)).permute(0, 2, 1).unsqueeze(0)
    nosso = s.log_mel(onda)
    assert nosso.shape == ref.shape == (1, 2, 101, 64), (nosso.shape, ref.shape)
    erro = (nosso - ref).abs().max().item()
    assert erro < 1e-3, erro
    print(f"ok mel igual ao torchaudio (erro máx {erro:.2e})")


def teste_ler_audio_e_duracao():
    d = tempfile.mkdtemp()
    arq = os.path.join(d, "fala.mp3")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=1.7",
                    "-ac", "1", "-ar", "44100", arq], check=True)
    dur = s.duracao_audio(arq)
    assert abs(dur - 1.7) < 0.08, dur
    onda = s.ler_audio(arq, segundos=2.375)
    assert onda.shape == (2, 38000), onda.shape
    assert onda[:, -1000:].abs().max() == 0  # completado com silêncio
    print(f"ok ler_audio (fala {dur:.2f} s, completada até 2,375 s)")


def teste_gancho_congela_audio():
    class Falso(torch.nn.Module):
        def forward(self, hidden_states=None, audio_hidden_states=None, timestep=None, audio_timestep=None, **kw):
            return audio_hidden_states, audio_timestep

    t = Falso()
    limpo = torch.arange(12.0).view(1, 3, 4)
    h = s.congelar_audio(t, limpo)
    a, ts = t(hidden_states=torch.zeros(2), audio_hidden_states=torch.randn(2, 3, 4), timestep=torch.tensor([0.7, 0.7]),
              audio_timestep=torch.tensor([0.7, 0.7]))
    assert torch.equal(a, limpo.expand(2, -1, -1)) and torch.equal(ts, torch.zeros(2)), (a, ts)
    h.remove()
    a2, ts2 = t(audio_hidden_states=torch.ones(1, 3, 4), audio_timestep=torch.tensor([0.5]))
    assert torch.equal(a2, torch.ones(1, 3, 4)) and ts2.item() == 0.5
    print("ok gancho: áudio limpo + timestep 0 durante a amostragem; removido depois")


def teste_mux_voz_fixa():
    """Mesmo comando ffmpeg do finalizar(): vídeo mudo + fala → clipe com a duração exata do vídeo."""
    import imageio_ffmpeg
    d = tempfile.mkdtemp()
    bruto, fala, final = (os.path.join(d, x) for x in ("bruto.mp4", "fala.mp3", "final.mp4"))
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1376x768:rate=24:duration=2.4",
                    "-c:v", "libx264", bruto], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=1.7", fala], check=True)
    quadros = 55
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", bruto, "-i", fala,
                    "-map", "0:v:0", "-map", "1:a:0", "-af", "apad", "-t", f"{quadros / 24:.3f}", "-frames:v", str(quadros),
                    "-vf", "scale=1280:720:flags=lanczos,setsar=1", "-r", "24",
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-c:v", "libx264", "-crf", "16",
                    "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final], check=True)
    sai = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", final],
                         capture_output=True, text=True).stdout.split()
    tipos = {x.split(",")[0]: float(x.split(",")[1]) for x in sai}
    assert set(tipos) == {"video", "audio"}, sai
    assert abs(tipos["video"] - quadros / 24) < 0.05 and abs(tipos["audio"] - quadros / 24) < 0.06, tipos
    print(f"ok mux: vídeo {tipos['video']:.3f} s, áudio {tipos['audio']:.3f} s (fala de 1,7 s + silêncio)")


if __name__ == "__main__":
    teste_mel_igual_torchaudio()
    teste_ler_audio_e_duracao()
    teste_gancho_congela_audio()
    teste_mux_voz_fixa()
    print("todos os testes passaram")
