#!/bin/bash
# Pod do LOTE: prepara o ambiente (no volume de rede, quando houver), gera todos os clipes do lote e desliga.
set -x
export INICIO_POD=$(date +%s)
desligar() {
  echo "[lote] desligando a GPU"
  curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" -H 'content-type: application/json' \
    -d "{\"query\":\"mutation { podTerminate(input: {podId: \\\"${RUNPOD_POD_ID}\\\"}) }\"}"
}
trap desligar EXIT

aviso() {
  curl -s -X POST "${FABRICA_URL}/api/public/fabrica/worker/lote/progresso" -H 'content-type: application/json' \
    -H "authorization: Bearer ${FABRICA_WORKER_TOKEN}" \
    -d "{\"lote_id\":\"${LOTE_ID}\",\"etapa\":\"$1\",\"mensagem\":\"$2\",\"dados\":{\"segundos_desde_ligar\":$(( $(date +%s) - INICIO_POD ))}}" > /dev/null
}

if [ "$COM_VOLUME" = "1" ] && [ -d /workspace ]; then BASE=/workspace; else BASE=/root/work; fi
mkdir -p $BASE && cd $BASE
aviso "gpu_ligada" "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader); volume: $([ $BASE = /workspace ] && echo sim || echo não)"

# Ambiente Python no volume: instalado uma vez, reaproveitado nas próximas ligações.
if [ ! -f $BASE/venv/.ok ]; then
  python -m venv $BASE/venv
  . $BASE/venv/bin/activate
  pip install -q -U pip
  pip install -q torch torchvision --index-url https://download.pytorch.org/whl/cu126 2>&1 | tail -2
  pip install -q "git+https://github.com/huggingface/diffusers" transformers accelerate sentencepiece \
    "huggingface_hub[cli,hf_transfer]" imageio imageio-ffmpeg av kernels pillow 2>&1 | tail -3
  python -c "import torch; assert torch.cuda.is_available()" && touch $BASE/venv/.ok
else
  . $BASE/venv/bin/activate
fi
aviso "ambiente" "Python pronto ($(python -c 'import torch;print(torch.__version__)'))"

export HF_HUB_ENABLE_HF_TRANSFER=1
if [ ! -f $BASE/ltx/.ok ]; then
  aviso "baixando" "Baixando os pesos do LTX-2.5 para o volume (só na 1ª vez)"
  python - <<'PY'
import os
from huggingface_hub import snapshot_download
base = "/workspace" if os.path.isdir("/workspace/venv") else "/root/work"
snapshot_download("Lightricks/LTX-2.5-Diffusers", local_dir=f"{base}/ltx", token=os.environ.get("HF_TOKEN") or None,
                  ignore_patterns=["transformer_full/*"])
open(f"{base}/ltx/.ok", "w").write("ok")
PY
fi
[ -f $BASE/ltx/.ok ] || { aviso "erro" "pesos do LTX não baixaram"; exit 1; }
aviso "pesos" "Pesos prontos"

curl -sL "https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/lote_gpu.py" -o $BASE/lote_gpu.py
LTX_DIR=$BASE/ltx python -u $BASE/lote_gpu.py > /root/lote.log 2>&1
CODIGO=$?
if [ $CODIGO -ne 0 ]; then
  aviso "erro" "python terminou com código $CODIGO: $(tail -12 /root/lote.log | tr -d '"\\' | tr '\n' ' ' | cut -c1-1400)"
fi
