#!/bin/bash
# Pod SERVIDOR da API de geração: atende a fila de clipes e desliga sozinho depois de ficar ocioso.
set -x
export INICIO_POD=$(date +%s)
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export PIP_NO_CACHE_DIR=1
# preço real deste pod (para o custo de cada clipe)
export CUSTO_HORA=$(curl -s "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" -H 'content-type: application/json' \
  -d "{\"query\":\"query { pod(input: {podId: \\\"${RUNPOD_POD_ID}\\\"}) { costPerHr } }\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["pod"]["costPerHr"])' 2>/dev/null || echo 0)
desligar() {
  echo "[servidor] desligando a GPU"
  curl -s -m 15 -X POST "${FABRICA_URL}/api/public/fabrica/worker/gpu/sinal" -H 'content-type: application/json' \
    -H "authorization: Bearer ${FABRICA_WORKER_TOKEN}" \
    -d "{\"pod_id\":\"${RUNPOD_POD_ID}\",\"gpu\":\"\",\"estado\":\"desligada\",\"custo_hora\":${CUSTO_HORA:-0}}" > /dev/null
  curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" -H 'content-type: application/json' \
    -d "{\"query\":\"mutation { podTerminate(input: {podId: \\\"${RUNPOD_POD_ID}\\\"}) }\"}"
}
trap desligar EXIT

aviso() {
  # sinal de vida da GPU para a fábrica (estado "ligando" até o modelo carregar)
  curl -s -X POST "${FABRICA_URL}/api/public/fabrica/worker/gpu/sinal" -H 'content-type: application/json' \
    -H "authorization: Bearer ${FABRICA_WORKER_TOKEN}" \
    -d "{\"pod_id\":\"${RUNPOD_POD_ID}\",\"gpu\":\"$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)\",\"estado\":\"ligando\",\"custo_hora\":${CUSTO_HORA:-0},\"etapa\":\"$1\",\"mensagem\":\"$2\",\"segundos_desde_ligar\":$(( $(date +%s) - INICIO_POD ))}" > /dev/null
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
  pip install -q "git+https://github.com/huggingface/diffusers" transformers accelerate sentencepiece peft \
    "huggingface_hub[cli,hf_transfer]" imageio imageio-ffmpeg av kernels pillow 2>&1 | tail -3
  python -c "import torch; assert torch.cuda.is_available()" && touch $BASE/venv/.ok
else
  . $BASE/venv/bin/activate
fi
aviso "ambiente" "Python pronto ($(python -c 'import torch;print(torch.__version__)'))"

export HF_HUB_ENABLE_HF_TRANSFER=1
if [ ! -f $BASE/ltx/.ok ]; then
  aviso "baixando" "Baixando os pesos do LTX-2.5 $([ $BASE = /workspace ] && echo "para o volume (só na 1ª vez)" || echo "(sem volume)")"
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
aviso "pesos" "Pesos prontos; disco livre: $(df -h /root | tail -1 | awk '{print $4}')"

curl -sL "https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/servidor_gpu.py" -o $BASE/servidor_gpu.py
LTX_DIR=$BASE/ltx timeout 5h python -u $BASE/servidor_gpu.py > /root/servidor.log 2>&1
CODIGO=$?
if [ $CODIGO -ne 0 ]; then
  aviso "erro" "python terminou com código $CODIGO: $(tail -12 /root/servidor.log | tr -d '"\\' | tr '\n' ' ' | cut -c1-1400)"
fi
