#!/bin/bash
# Pod de TESTE de imagem na GPU (Qwen-Image-Edit-2509). Instala, baixa os pesos, roda img_teste.py e desliga.
set -x
export INICIO_POD=$(date +%s)
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export CUSTO_HORA=$(curl -s "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" -H 'content-type: application/json' \
  -d "{\"query\":\"query { pod(input: {podId: \\\"${RUNPOD_POD_ID}\\\"}) { costPerHr } }\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["pod"]["costPerHr"])' 2>/dev/null || echo 0)
desligar() {
  curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" -H 'content-type: application/json' \
    -d "{\"query\":\"mutation { podTerminate(input: {podId: \\\"${RUNPOD_POD_ID}\\\"}) }\"}"
}
trap desligar EXIT
aviso() {
  curl -s -X POST "${FABRICA_URL}/api/public/fabrica/worker/progresso" -H 'content-type: application/json' \
    -H "authorization: Bearer ${FABRICA_WORKER_TOKEN}" \
    -d "{\"pedido_id\":\"${PEDIDO_ID}\",\"etapa\":\"$1\",\"progresso\":$2,\"mensagem\":\"$3\"}" > /dev/null
}
aviso "img_instalando" 5 "GPU ligada: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader); US\$ ${CUSTO_HORA}/h"
mkdir -p /root/work && cd /root/work
pip install -q -U torch torchvision --index-url https://download.pytorch.org/whl/cu126 2>&1 | tail -2
pip install -q "git+https://github.com/huggingface/diffusers" transformers accelerate sentencepiece peft \
  "huggingface_hub[cli,hf_transfer]" pillow 2>&1 | tail -3
export HF_HUB_ENABLE_HF_TRANSFER=1
T0=$(date +%s)
python - <<'PY' 2>&1 | tail -3
import os
from huggingface_hub import snapshot_download
snapshot_download("Qwen/Qwen-Image-Edit-2509", local_dir="/root/work/qwen", token=os.environ.get("HF_TOKEN") or None)
PY
aviso "img_baixou" 30 "Pesos do Qwen-Image-Edit-2509 baixados em $(( $(date +%s) - T0 )) s (instalação+download desde ligar: $(( $(date +%s) - INICIO_POD )) s)"
curl -sL "https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/img_teste.py" -o img_teste.py
python -u img_teste.py > img.log 2>&1
CODIGO=$?
if [ $CODIGO -ne 0 ]; then
  aviso "img_erro" 99 "python terminou com código $CODIGO: $(tail -15 img.log | tr -d '"\\' | tr '\n' ' ' | cut -c1-1500)"
fi
