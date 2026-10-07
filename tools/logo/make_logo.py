"""
Chorus logo generator.

Draws the icon programmatically with Pillow, so the artwork is reproducible and
versionable instead of being a binary someone has to edit.

The mark is the overlay itself: a three-line lyric carousel, the middle line
larger and cyan because it is the one being sung. That reads at 16 px and is
honest about what the app does.

    python tools/logo/make_logo.py

Outputs into assets/:
    chorus-512.png           app icon, rounded square
    chorus-256.png           ditto, smaller
    chorus-128.png           ditto
    chorus-64.png            ditto
    chorus-32.png            ditto
    chorus-16.png            ditto
    chorus.ico               multi-size Windows icon
    chorus-mark.png          transparent background, for the README and OBS
    chorus-banner.png        wide banner with the wordmark
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets"

# Matches the control panel's dark theme so the icon and the UI agree.
BG_DARK = (23, 23, 27)          # --bg-card-solid
BG_EDGE = (10, 10, 11)          # --bg-window
ACCENT = (76, 194, 255)         # --accent
ACCENT_DEEP = (28, 122, 186)    # a darker end for the gradient
TEXT_PRIMARY = (255, 255, 255)
TEXT_MUTED = (150, 158, 170)

# Everything is drawn at this multiple and downsampled, which is how Pillow gets
# clean edges — it has no antialiased vector drawing.
SS = 4


def vertical_gradient(size, top, bottom):
    """A vertical gradient image, used to fill the rounded tile."""
    w, h = size
    grad = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        grad.putpixel(
            (0, y),
            tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
        )
    return grad.resize((w, h), Image.NEAREST)


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255
    )
    return mask


def draw_mark(img, box, glow=True, weight=1.0):
    """
    Draw the three-line lyric carousel inside `box` (x0, y0, x1, y1).

    `weight` scales the bars up for small icons, where thin lines turn to mush.
    """
    x0, y0, x1, y1 = box
    w = x1 - x0
    h = y1 - y0
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2

    idle_h = h * 0.100 * weight
    active_h = h * 0.140 * weight
    gap = h * 0.185

    # Drawn on its own layer so the glow can be blurred without smearing the bars.
    if glow:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        pad = active_h * 0.9
        ld.rounded_rectangle(
            [cx - w * 0.34 - pad, cy - active_h / 2 - pad, cx + w * 0.34 + pad, cy + active_h / 2 + pad],
            radius=(active_h + pad * 2) / 2,
            fill=(ACCENT[0], ACCENT[1], ACCENT[2], 90),
        )
        from PIL.ImageFilter import GaussianBlur

        img.alpha_composite(layer.filter(GaussianBlur(h * 0.10)))

    draw = ImageDraw.Draw(img, "RGBA")

    # Idle lines first, then the active one on top.
    for cy_row, width, hh, colour in (
        (cy - gap, w * 0.44, idle_h, (150, 160, 174, 210)),
        (cy + gap, w * 0.44, idle_h, (150, 160, 174, 210)),
        (cy, w * 0.68, active_h, ACCENT + (255,)),
    ):
        draw.rounded_rectangle(
            [cx - width / 2, cy_row - hh / 2, cx + width / 2, cy_row + hh / 2],
            radius=hh / 2,
            fill=colour,
        )


def make_icon(size):
    """
    A rounded tile with the mark on it.

    The whole thing is drawn on one canvas and then masked to the rounded shape, so
    the mark's glow cannot bleed outside the tile edges.

    Small sizes are drawn differently on purpose: the glow and the hairline accent
    edge are dropped below 64 px, the bars are thickened, and the corner radius is
    eased off. Supersampling alone cannot rescue a 16 px icon from a soft glow —
    it has to change shape.
    """
    small = size < 64
    # 8x for small icons (there is little to lose) and 4x otherwise.
    big = size * (8 if small else SS)

    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # Gradient tile: lighter at the top, like the app's cards.
    tile = vertical_gradient((big, big), (34, 36, 43), BG_EDGE).convert("RGBA")
    canvas.alpha_composite(tile, (0, 0))

    # Small icons get a little more of the canvas and thicker bars.
    if small:
        draw_mark(canvas, (big * 0.10, big * 0.15, big * 0.90, big * 0.85), glow=False, weight=1.9)
    else:
        draw_mark(canvas, (big * 0.14, big * 0.17, big * 0.86, big * 0.83))

    if not small:
        # A thin accent edge, inset so it is visible against dark backgrounds.
        ImageDraw.Draw(canvas).rounded_rectangle(
            [big * 0.012, big * 0.012, big * 0.988, big * 0.988],
            radius=int(big * 0.215),
            outline=(ACCENT[0], ACCENT[1], ACCENT[2], 70),
            width=max(1, int(big * 0.007)),
        )

    # Clip everything to the rounded tile.
    radius = int(big * (0.26 if small else 0.225))
    canvas.putalpha(
        Image.composite(canvas.getchannel("A"), Image.new("L", (big, big), 0), rounded_mask((big, big), radius))
    )
    return canvas.resize((size, size), Image.LANCZOS)


def make_mark(size):
    """The mark alone on transparency — for OBS overlays and README headers."""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_mark(img, (big * 0.06, big * 0.16, big * 0.94, big * 0.84))
    return img.resize((size, size), Image.LANCZOS)


def make_banner(width=1280, height=320):
    """Wide banner: the icon on the left, the wordmark and tagline on the right."""
    big_w, big_h = width * 2, height * 2
    img = Image.new("RGBA", (big_w, big_h), (10, 10, 11, 255))

    # A faint accent bloom behind the icon, so it is not a flat black rectangle.
    bloom = Image.new("RGBA", (big_w, big_h), (0, 0, 0, 0))
    ImageDraw.Draw(bloom).ellipse(
        [big_w * 0.02, big_h * 0.02, big_w * 0.42, big_h * 0.98],
        fill=(ACCENT[0], ACCENT[1], ACCENT[2], 26),
    )
    from PIL.ImageFilter import GaussianBlur

    img.alpha_composite(bloom.filter(GaussianBlur(big_h * 0.09)))

    icon_size = int(big_h * 0.54)
    icon = make_icon(icon_size)
    icon_x = int(big_w * 0.085)
    img.alpha_composite(icon, (icon_x, int((big_h - icon_size) / 2)))

    try:
        title_font = ImageFont.truetype(r"C:\Windows\Fonts\seguisb.ttf", int(big_h * 0.235))
        tag_font = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", int(big_h * 0.079))
    except OSError:
        title_font = ImageFont.load_default()
        tag_font = ImageFont.load_default()

    draw = ImageDraw.Draw(img)
    text_x = icon_x + icon_size + int(big_w * 0.042)

    # Lay the block out from measured text heights so nothing collides. The title's
    # descenders are what a naive offset gets wrong.
    title = "Chorus"
    tagline = "Live lyrics for OBS, from Windows SMTC"
    tb = draw.textbbox((0, 0), title, font=title_font)
    gb = draw.textbbox((0, 0), tagline, font=tag_font)
    title_h = tb[3] - tb[1]
    block_h = title_h + (gb[3] - gb[1]) + big_h * 0.075
    top = (big_h - block_h) / 2

    draw.text((text_x, top - tb[1]), title, font=title_font, fill=TEXT_PRIMARY + (255,))
    # The rule sits in the gap between the two lines, clear of the descenders.
    rule_y = top + title_h + big_h * 0.028
    draw.rounded_rectangle(
        [text_x, rule_y, text_x + big_w * 0.052, rule_y + big_h * 0.014],
        radius=big_h * 0.007,
        fill=ACCENT + (255,),
    )
    draw.text(
        (text_x, rule_y + big_h * 0.042 - gb[1]),
        tagline,
        font=tag_font,
        fill=TEXT_MUTED + (255,),
    )

    return img.resize((width, height), Image.LANCZOS)


def circle_mask(size):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size[0] - 1, size[1] - 1], fill=255)
    return mask


def make_mark_circle(size=512):
    """
    The tile with the mark, cropped to a circle.

    GitHub strips inline styles and <style> blocks from README HTML, so a circular
    heading image has to be circular in the file itself rather than via CSS.
    """
    big = size * SS
    icon = make_icon(big)
    clipped = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    clipped.paste(icon, (0, 0), circle_mask((big, big)))
    return clipped.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    for size in (512, 256, 128, 64, 32, 16):
        path = OUT / f"chorus-{size}.png"
        make_icon(size).save(path, "PNG", optimize=True)
        print(f"  wrote {path.relative_to(ROOT)}")

    mark_path = OUT / "chorus-mark.png"
    make_mark(512).save(mark_path, "PNG", optimize=True)
    print(f"  wrote {mark_path.relative_to(ROOT)}")

    circle_path = OUT / "chorus-mark-circle.png"
    make_mark_circle(256).save(circle_path, "PNG", optimize=True)
    print(f"  wrote {circle_path.relative_to(ROOT)}")

    banner_path = OUT / "chorus-banner.png"
    make_banner().save(banner_path, "PNG", optimize=True)
    print(f"  wrote {banner_path.relative_to(ROOT)}")

    # A multi-size .ico, which is what Windows and the tray want.
    ico_path = OUT / "chorus.ico"
    make_icon(256).save(ico_path, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print(f"  wrote {ico_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
