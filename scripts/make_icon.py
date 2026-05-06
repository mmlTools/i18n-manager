"""Generate a 256×256 PNG icon for the i18n Data Manager marketplace listing."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

SIZE = 256
OUT = Path(__file__).parent.parent / "media" / "icon.png"

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded-square background a calm indigo, reads well in both light & dark UI lists
BG_TOP = (79, 70, 229)      # #4F46E5
BG_BOT = (124, 58, 237)     # #7C3AED

# Vertical gradient
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
    g = int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
    b = int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
    draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

# Apply rounded corners by masking
radius = 56
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (SIZE, SIZE)], radius=radius, fill=255)
rounded = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
rounded.paste(img, (0, 0), mask)
img = rounded
draw = ImageDraw.Draw(img)

# ── Globe ──
cx, cy = SIZE // 2, SIZE // 2
r = 78
white = (255, 255, 255, 255)
soft = (255, 255, 255, 200)

# Outer circle
draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], outline=white, width=6)
# Equator
draw.line([(cx - r, cy), (cx + r, cy)], fill=soft, width=4)
# Prime meridian
draw.line([(cx, cy - r), (cx, cy + r)], fill=soft, width=4)
# Two latitude curves (vertical ellipses → meridians)
draw.ellipse([(cx - r // 2, cy - r), (cx + r // 2, cy + r)], outline=soft, width=3)
# Two longitude curves (horizontal ellipses → parallels)
draw.ellipse([(cx - r, cy - r // 2), (cx + r, cy + r // 2)], outline=soft, width=3)

# ── Translation indicator: "A 文" badge in the bottom-right ──
badge_r = 38
bx, by = SIZE - badge_r - 22, SIZE - badge_r - 22
draw.ellipse([(bx - badge_r, by - badge_r), (bx + badge_r, by + badge_r)], fill=white)

# Try to render "A文" using a font that supports CJK; fall back gracefully
def find_font(candidates, size):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:
            continue
    return ImageFont.load_default()

cjk_fonts = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
font = find_font(cjk_fonts, 38)

text = "A文"
# Center the text in the badge
bbox = draw.textbbox((0, 0), text, font=font)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
draw.text(
    (bx - tw / 2 - bbox[0], by - th / 2 - bbox[1]),
    text,
    fill=BG_TOP,
    font=font,
)

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, "PNG", optimize=True)
print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")
