#!/bin/bash
# Teste 2 das frutinhas: instala o LatentSync (ByteDance) na GPU, roda o lipsync_teste.py e desliga a GPU.
set -x
export INICIO_POD=$(date +%s)
SCRIPT=${SCRIPT:-lipsync_teste.py}
desligar() {
  echo "[lipsync] desligando a GPU"
  curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" -H 'content-type: application/json' \
    -d "{\"query\":\"mutation { podTerminate(input: {podId: \\\"${RUNPOD_POD_ID}\\\"}) }\"}"
}
trap desligar EXIT
aviso() {
  curl -s -X POST "${FABRICA_URL}/api/public/fabrica/worker/progresso" -H 'content-type: application/json' \
    -H "authorization: Bearer ${FABRICA_WORKER_TOKEN}" \
    -d "{\"pedido_id\":\"${PEDIDO_ID}\",\"etapa\":\"$1\",\"progresso\":$2,\"mensagem\":\"$3\"}" > /dev/null
}
aviso "instalando" 5 "GPU ligada (teste de sincronia labial): $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader)"
mkdir -p /root/work && cd /root/work
apt-get update -qq && apt-get install -y -qq ffmpeg libgl1 > /dev/null 2>&1
git clone -q https://github.com/bytedance/LatentSync.git
cd LatentSync
python -m venv /root/ls && . /root/ls/bin/activate
pip install -q -U pip
pip install -q -r requirements.txt 2>&1 | tail -3
pip install -q "huggingface_hub[cli,hf_transfer]" 2>&1 | tail -1
export HF_HUB_ENABLE_HF_TRANSFER=1
aviso "baixando" 20 "Instalado; baixando os pesos ByteDance/LatentSync-1.6"
python - <<'PY' 2>&1 | tail -3
from huggingface_hub import snapshot_download
snapshot_download("ByteDance/LatentSync-1.6", local_dir="checkpoints")
PY
ls -la checkpoints checkpoints/whisper 2>&1 | head
aviso "baixou" 35 "Pesos do LatentSync prontos"
curl -sL "https://raw.githubusercontent.com/franciscobrunopereirasantos-star/darkfactory/main/ltx/${SCRIPT}" -o /root/work/teste.py
python -u /root/work/teste.py > /root/work/teste.log 2>&1
CODIGO=$?
if [ $CODIGO -ne 0 ] || ! grep -q "Teste concluído" /root/work/teste.log; then
  aviso "erro" 99 "python terminou com código $CODIGO. Últimas linhas: $(tail -15 /root/work/teste.log | tr -d '"\\' | tr '\n' ' ' | cut -c1-1500)"
fi
