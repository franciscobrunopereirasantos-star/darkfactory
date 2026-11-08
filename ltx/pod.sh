#!/bin/bash
# Roda dentro da GPU do RunPod: instala, baixa o LTX-2.5 oficial, testa e desliga a própria GPU no final.
set -x
desligar() {
  echo "[ltx] desligando a GPU"
  curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" -H 'content-type: application/json' \
    -d "{\"query\":\"mutation { podTerminate(input: {podId: \\\"${RUNPOD_POD_ID}\\\"}) }\"}"
}
trap desligar EXIT

aviso() {
  curl -s -X POST "${FABRICA_URL}/api/public/fabrica/worker/progresso" -H 'content-type: application/json' \
    -H "authorization: Bearer ${FABRICA_WORKER_TOKEN}" \
    -d "{\"pedido_id\":\"${PEDIDO_ID}\",\"etapa\":\"$1\",\"progresso\":$2,\"mensagem\":\"$3\"}" > /dev/null
}

aviso "instalando" 5 "GPU ligada: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader)"
mkdir -p /root/work && cd /root/work
# torch mais novo (o LTX-2.5 usa recursos recentes); se a GPU não aceitar, volta para o da imagem
pip install -q -U torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126 2>&1 | tail -2
python -c "import torch; assert torch.cuda.is_available(); print('torch', torch.__version__)" || \
  pip install -q "torch==2.4.1" "torchvision==0.19.1" "torchaudio==2.4.1" --index-url https://download.pytorch.org/whl/cu124
aviso "instalando" 10 "torch $(python -c 'import torch;print(torch.__version__)')"
pip install -q "git+https://github.com/huggingface/diffusers" transformers accelerate sentencepiece \
  "huggingface_hub[cli,hf_transfer]" imageio imageio-ffmpeg av kernels 2>&1 | tail -3
export HF_HUB_ENABLE_HF_TRANSFER=1
aviso "baixando" 15 "Baixando os pesos oficiais Lightricks/LTX-2.5-Diffusers (~72 GB)"
T0=$(date +%s)
python - <<'PY' 2>&1 | tail -5
import os, sys
from huggingface_hub import snapshot_download
try:
    snapshot_download("Lightricks/LTX-2.5-Diffusers", local_dir="/root/work/ltx", token=os.environ.get("HF_TOKEN") or None,
                      ignore_patterns=["transformer_full/*"])
except Exception as e:
    open("/root/work/erro_download.txt", "w").write(str(e)[:600])
    sys.exit(1)
PY
if [ -f /root/work/erro_download.txt ]; then
  aviso "erro" 15 "Download recusado pelo Hugging Face: $(tr -d '\n"' < /root/work/erro_download.txt | cut -c1-400)"
  exit 1
fi
aviso "baixou" 35 "Download em $(( $(date +%s) - T0 )) s"
curl -sL "https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/teste.py" -o teste.py
aviso "memoria" 38 "RAM livre: $(free -g | awk '/Mem:/{print $7}') GB de $(free -g | awk '/Mem:/{print $2}') GB"
python -u teste.py > teste.log 2>&1
CODIGO=$?
if [ $CODIGO -ne 0 ] || ! grep -q "Teste concluído" teste.log; then
  OOM=$(dmesg 2>/dev/null | grep -i -m1 "killed process" | tr -d '"')
  aviso "erro" 99 "python terminou com código $CODIGO. ${OOM} Últimas linhas: $(tail -15 teste.log | tr -d '"\\' | tr '\n' ' ' | cut -c1-1500)"
fi
