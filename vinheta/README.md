# Vinheta — Luma e Malu (Estúdio Pé de Aventura)

Vinheta de abertura de ~15 s feita em HyperFrames (HTML → MP4) sobre clipes do LTX gerados pela fábrica.

- Nenhuma mídia fica no repositório: o workflow `vinheta.yml` baixa os clipes e a música da fábrica na hora.
- `montar.mjs` mede a duração real de cada clipe e escreve o `index.html` (tempos, espelhamento, sons).
- `efeitos.sh` sintetiza pop/plim/whoosh/assinatura (mesmas fórmulas do worker de montagem).
- v1 e v3 são espelhados (`transform: scaleX(-1)`) para o ursinho ficar no braço DIREITO da Malu.

Rodar: Actions → "Vinheta Luma e Malu" → informar as URLs de v1, v2 e v3.
