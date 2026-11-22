import { ffmpegAnalise } from './util.mjs';
export const srtTempo = s => { const ms=Math.max(0,Math.round(s*1000));return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`; };
export function srtDaTimeline(falas){return falas.filter(f=>f.texto?.trim()&&f.fim_s>f.inicio_s).map((f,i)=>`${i+1}\n${srtTempo(f.inicio_s)} --> ${srtTempo(f.fim_s)}\n${f.texto.trim()}\n`).join('\n');}
export async function medirFalasNativas(c){
 if(!c.falas.length)return;
 const stderr=await ffmpegAnalise(['-i',c.arquivoClipe,'-vn','-af','silencedetect=noise=-35dB:d=0.15','-f','null','-']);
 const eventos=[...stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)].map(m=>({tipo:m[1],s:Number(m[2])}));
 const segmentos=[];let inicio=0;
 for(const e of eventos){if(e.tipo==='start'){if(e.s>inicio+0.05)segmentos.push({inicio,fim:Math.min(e.s,c.durCena)});}else inicio=e.s;}
 if(inicio<c.durCena-0.05 && !eventos.some(e=>e.tipo==='start'&&e.s>=inicio&&e.s<c.durCena))segmentos.push({inicio,fim:c.durCena});
 const validos=segmentos.filter(x=>x.fim>x.inicio+0.05);
 if(!validos.length)throw new Error(`cena ${c.id}: áudio nativo sem fala detectável; não inventar tempos de legenda`);
 if(validos.length<c.falas.length)throw new Error(`cena ${c.id}: faltam pausas para separar ${c.falas.length} falas; fornecer clipes separados para SRT fiel`);
 const gaps=validos.slice(0,-1).map((s,i)=>({i,gap:validos[i+1].inicio-s.fim})).sort((a,b)=>b.gap-a.gap).slice(0,c.falas.length-1).map(g=>g.i).sort((a,b)=>a-b);
 let start=0;const grupos=[];
 for(const end of [...gaps,validos.length-1]){grupos.push({inicio:validos[start].inicio,fim:validos[end].fim});start=end+1;}
 c.falas.forEach((f,i)=>{f.inicio=grupos[i].inicio;f.dur=grupos[i].fim-grupos[i].inicio;f.timing_origem='audio_original_silencedetect';});
}
