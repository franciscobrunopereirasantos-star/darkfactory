#!/usr/bin/env bash
# Sintetiza os efeitos da vinheta em $1 (mesmas fórmulas do worker de montagem, src/historia.mjs)
set -euo pipefail
d="$1"
gera() { ffmpeg -nostdin -y -loglevel error -f lavfi -i "aevalsrc='$2':s=44100:d=$3" -af "afade=t=out:st=$(awk "BEGIN{print $3-0.05}"):d=0.05" "$d/$1"; }
gera pop.wav "0.6*sin(2*PI*(350+2600*t)*t)*exp(-22*t)" 0.16
gera plim.wav "0.35*(sin(2*PI*2093*t)+0.6*sin(2*PI*3136*t))*exp(-7*t)" 0.7
gera assinatura.wav "0.35*(sin(2*PI*523.25*t)*exp(-5*t)*lt(t,0.3)+sin(2*PI*659.25*(t-0.3))*exp(-5*(t-0.3))*gte(t,0.3)*lt(t,0.6)+sin(2*PI*783.99*(t-0.6))*exp(-3*(t-0.6))*gte(t,0.6))" 1.8
# whoosh: ruído filtrado com subida e descida (duas variações para não repetir)
ffmpeg -nostdin -y -loglevel error -f lavfi -i "anoisesrc=d=0.45:c=pink:a=0.5" -af "highpass=f=400,lowpass=f=5000,afade=t=in:d=0.3,afade=t=out:st=0.3:d=0.15,volume=0.8" "$d/whoosh.wav"
ffmpeg -nostdin -y -loglevel error -f lavfi -i "anoisesrc=d=0.4:c=pink:a=0.5:seed=7" -af "highpass=f=600,lowpass=f=6500,afade=t=in:d=0.25,afade=t=out:st=0.25:d=0.15,volume=0.8" "$d/whoosh2.wav"
