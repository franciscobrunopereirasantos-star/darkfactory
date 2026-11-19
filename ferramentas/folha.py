# Monta uma folha de contato (grade com rótulos) a partir de URLs de imagens.
# Uso: python3 ferramentas/folha.py saida.jpg "ROTULO|URL" "ROTULO|URL" ...
import sys, io, urllib.request
from PIL import Image, ImageDraw, ImageFont
saida, itens = sys.argv[1], [a.split("|", 1) for a in sys.argv[2:]]
W, H, COLS = 640, 366, 3
linhas = (len(itens) + COLS - 1) // COLS
folha = Image.new("RGB", (W * COLS, (H + 34) * linhas), "white")
try:
    fonte = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
except Exception:
    fonte = ImageFont.load_default()
d = ImageDraw.Draw(folha)
for i, (rotulo, url) in enumerate(itens):
    req = urllib.request.Request(url, headers={"User-Agent": "fabrica-folha"})
    im = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=60).read())).convert("RGB")
    im.thumbnail((W, H))
    x, y = (i % COLS) * W, (i // COLS) * (H + 34)
    folha.paste(im, (x + (W - im.width) // 2, y + 34))
    d.text((x + 8, y + 5), rotulo, fill="black", font=fonte)
folha.save(saida, quality=85)
print("ok", saida, folha.size)
