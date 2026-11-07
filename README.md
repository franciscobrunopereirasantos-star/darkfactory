# DarkFactory — worker da fábrica de vídeos

Pega pedidos na fila do DarkFactory (`/api/public/fabrica/worker/*`), produz o vídeo e entrega o MP4.

**Etapas:** voz por cena (OpenAI TTS) → visual por cena (imagem do cliente, vídeo ou foto do Pexels, sem repetir) → montagem com FFmpeg (zoom lento, legenda grande em blocos de 5 palavras, rodapé e cartão final da marca) → conferência (formato, áudio, duração, tamanho, silêncio > 1,5 s, tela preta) → upload e conclusão.

Resultado da conferência: tudo ok = `pronto`; problema visual/silêncio = `revisar` (vídeo é entregue para alguém olhar); problema técnico = `falhou`.

## Onde roda
GitHub Actions (`.github/workflows/fabrica.yml`): 1x por hora como rede de segurança, pelo botão *Run workflow* ou por `repository_dispatch` (`novo-pedido`). Processa até a fila esvaziar ou 40 min.

## Secrets do repositório (Settings → Secrets and variables → Actions)
| Nome | O quê |
|---|---|
| `FABRICA_URL` | URL publicada do DarkFactory, sem barra no fim |
| `FABRICA_WORKER_TOKEN` | chave `dfw_...` gerada na tela Fábrica → Workers |
| `OPENAI_API_KEY` | voz e termos de busca |
| `PEXELS_API_KEY` | imagens e vídeos de banco |

## Teste local sem gastar nada
`node teste/simulado.mjs <pasta-com-a0.wav, v0.mp4, i1.jpg...> saida.mp4` — simula a API, a OpenAI e o Pexels e roda o worker inteiro.

## Formatos
`short_narrado` (9:16) e `video_narrado` (16:9). Próximos: narrador, história ilustrada.

Fonte Inter (SIL Open Font License, ver `fonts/LICENSE-Inter.txt`).
