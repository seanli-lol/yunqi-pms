"""登录滑块验证码：Pillow 2× HiDPI PNG 异形凹凸拼图 + 干扰缺口 + 轨迹行为风控

安全设计要点：
1. PNG 光栅渲染（彻底替代 SVG）：像素级合成，返回值不含任何坐标文本，消除源码解析漏洞；
2. 随机异形凹凸拼图 + 1~2 个不同轮廓干扰假缺口：至少 1 个假缺口与真缺口同水平带，对抗条带扫描；
3. 云栖景观程序化底图 + 全图密码学随机微颗粒噪点 + 拼图块亮度微扰：对抗模板匹配与像素差分；
4. 四维联合校验：位置容差 + 服务端真实耗时 + 人机拖动轨迹动力学分析 + 客户端 IP/UA 指纹防重放；
5. 动态升阶风控：同一 IP 5 分钟内失败 ≥2 次自动升阶为 2 个干扰缺口 + 容差收紧至 ±4px。
"""
import base64
import io
import math
import random
import secrets
import statistics
import time
from collections import defaultdict, deque

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

from app.config import CAPTCHA_ENABLED

W = 320                  # 背景图宽（逻辑坐标）
H = 160                  # 背景图高（逻辑坐标）
PIECE_BOX = 58           # 拼图画布盒边长（逻辑坐标，含四边耳扣余量）
SCALE = 2                # 2× HiDPI 输出（640×320 背景 + 116×116 拼图块）
MASK_AA = 2              # 拼图掩码额外 2× 超采样（总 4× 抗锯齿）

TOLERANCE = 5            # 常规允许偏差（逻辑像素）
ESCALATED_TOLERANCE = 4  # 强化验证允许偏差（逻辑像素）
TTL = 120                # 挑战 / 票据有效期（秒）
FAIL_WINDOW = 300        # IP 失败统计滑动窗口（秒）
ESCALATE_FAILS = 2       # 触发强化验证的近期失败次数

MIN_SERVER_ELAPSED = 0.35  # 服务端最短真实响应间隔（秒）
MIN_DURATION_MS = 200      # 客户端拖动最短耗时（毫秒）
MAX_DURATION_MS = 15000    # 客户端拖动最长耗时（毫秒）

# 5 套贴合云栖精品酒店气质的克制景观色板：(天空顶, 天空底, 远山深, 晨曦/暖阳点缀, 雾气/高光)
_PALETTES = [
    ("#2d4356", "#7b9eb0", "#1d2d3b", "#e6b88a", "#f4f7f9"),  # 西湖暮岚
    ("#3b4d45", "#8ca696", "#23312b", "#e3c08d", "#f5f7f4"),  # 青松晨雾
    ("#4a3f55", "#a3899d", "#2b2435", "#f0c49a", "#faf5f2"),  # 云台破晓
    ("#2a4a5e", "#6f9eb2", "#19303f", "#f2cf94", "#f2f7fa"),  # 湖岸晴岚
    ("#4b453e", "#a99985", "#2c2722", "#e8b67c", "#faf7f2"),  # 暖阳庭院
]

_enabled = CAPTCHA_ENABLED
_challenges: dict[str, dict] = {}
_tickets: dict[str, dict] = {}
_fail_hits: dict[str, deque] = defaultdict(deque)


def enabled() -> bool:
    return _enabled


def set_enabled(value: bool) -> None:
    """测试/自动化切换开关"""
    global _enabled
    _enabled = value


def reset_state() -> None:
    """测试辅助：清空内存中的挑战、票据与失败升阶计数"""
    _challenges.clear()
    _tickets.clear()
    _fail_hits.clear()


def _purge(store: dict, now: float) -> None:
    for key in [k for k, v in store.items() if now - v["created"] > TTL]:
        store.pop(key, None)


def _recent_fails(ip: str, now: float) -> int:
    q = _fail_hits.get(ip)
    if not q:
        return 0
    while q and now - q[0] > FAIL_WINDOW:
        q.popleft()
    if not q:
        _fail_hits.pop(ip, None)
        return 0
    return len(q)


def _record_fail(ip: str, now: float) -> None:
    if not ip:
        return
    q = _fail_hits[ip]
    while q and now - q[0] > FAIL_WINDOW:
        q.popleft()
    q.append(now)


def _hex_rgb(code: str) -> tuple[int, int, int]:
    h = code.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _lerp_rgb(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(a[0] + (b[0] - a[0]) * t),
        int(a[1] + (b[1] - a[1]) * t),
        int(a[2] + (b[2] - a[2]) * t),
    )


def _cubic_bezier(p0, p1, p2, p3, steps: int = 12) -> list[tuple[float, float]]:
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1.0 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def _quad_bezier(p0, p1, p2, steps: int = 8) -> list[tuple[float, float]]:
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1.0 - t
        x = mt**2 * p0[0] + 2 * mt * t * p1[0] + t**2 * p2[0]
        y = mt**2 * p0[1] + 2 * mt * t * p1[1] + t**2 * p2[1]
        pts.append((x, y))
    return pts


def _random_tabs(rng: random.Random, exclude: tuple[int, int, int, int] | None = None) -> tuple[int, int, int, int]:
    """随机生成四边凹凸配置 ∈ {-1, 0, +1}^4（至少 2 条非平直边；干扰缺口至少 2 条边与真缺口不同）"""
    dirs = (-1, 0, 1)
    for _ in range(50):
        t = (rng.choice(dirs), rng.choice(dirs), rng.choice(dirs), rng.choice(dirs))
        if sum(1 for v in t if v != 0) < 2:
            continue
        if exclude is not None:
            if sum(1 for a, b in zip(t, exclude) if a != b) < 2:
                continue
        return t
    if exclude is None:
        return (1, -1, 0, 1)
    return (-exclude[0] or 1, 0 if exclude[1] else 1, -exclude[2] or -1, -exclude[3] if exclude[3] else -1)


def _jigsaw_polygon(body: float, tabs: tuple[int, int, int, int], scale: float) -> list[tuple[float, float]]:
    """全周 C1 连续平滑拼图路径：四圆角 + 4 段无尖角贝塞尔圆润耳扣（与原型 1:1 一致）"""
    pad = (PIECE_BOX - body) / 2.0
    x0, y0 = pad * scale, pad * scale
    span = body * scale
    x1, y1 = x0 + span, y0 + span
    cr = span * 0.12

    pts: list[tuple[float, float]] = [(x0 + cr, y0)]

    def add_side(ax: float, ay: float, bx: float, by: float, direction: int) -> None:
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length
        # 顺时针路径外法向
        nx, ny = uy * direction, -ux * direction

        def pt(s: float, h: float) -> tuple[float, float]:
            return (ax + ux * (s * length) + nx * (h * length), ay + uy * (s * length) + ny * (h * length))

        if direction == 0:
            pts.append(pt(0.88, 0.0))
            return

        p0 = pt(0.34, 0.0)
        s1c1, s1c2, n1 = pt(0.38, 0.0), pt(0.415, 0.025), pt(0.40, 0.055)
        s2c1, s2c2, top = pt(0.375, 0.105), pt(0.395, 0.245), pt(0.50, 0.245)
        s3c1, s3c2, n2 = pt(0.605, 0.245), pt(0.625, 0.105), pt(0.60, 0.055)
        s4c1, s4c2, p1 = pt(0.585, 0.025), pt(0.62, 0.0), pt(0.66, 0.0)
        end = pt(0.88, 0.0)

        pts.append(p0)
        pts.extend(_cubic_bezier(p0, s1c1, s1c2, n1, 10))
        pts.extend(_cubic_bezier(n1, s2c1, s2c2, top, 14))
        pts.extend(_cubic_bezier(top, s3c1, s3c2, n2, 14))
        pts.extend(_cubic_bezier(n2, s4c1, s4c2, p1, 10))
        pts.append(end)

    add_side(x0, y0, x1, y0, tabs[0])
    pts.extend(_quad_bezier(pts[-1], (x1, y0), (x1, y0 + cr), 8))
    add_side(x1, y0, x1, y1, tabs[1])
    pts.extend(_quad_bezier(pts[-1], (x1, y1), (x1 - cr, y1), 8))
    add_side(x1, y1, x0, y1, tabs[2])
    pts.extend(_quad_bezier(pts[-1], (x0, y1), (x0, y1 - cr), 8))
    add_side(x0, y1, x0, y0, tabs[3])
    pts.extend(_quad_bezier(pts[-1], (x0, y0), (x0 + cr, y0), 8))
    return pts


def _jigsaw_mask(body: float, tabs: tuple[int, int, int, int]) -> Image.Image:
    """4× 超采样生成平滑抗锯齿拼图灰度掩码（输出尺寸 PIECE_BOX*SCALE）"""
    hi = PIECE_BOX * SCALE * MASK_AA
    mask_hi = Image.new("L", (hi, hi), 0)
    draw = ImageDraw.Draw(mask_hi)
    draw.polygon(_jigsaw_polygon(body, tabs, SCALE * MASK_AA), fill=255)
    out_size = PIECE_BOX * SCALE
    return mask_hi.resize((out_size, out_size), Image.Resampling.LANCZOS)


def _render_scene(rng: random.Random) -> Image.Image:
    """生成 2× HiDPI 云栖景观防 CV 底图（RGB → RGBA）"""
    pw, ph = W * SCALE, H * SCALE
    pal = [_hex_rgb(c) for c in rng.choice(_PALETTES)]
    c_top, c_mid, c_deep, c_warm, c_light = pal

    # 1. 柔和斜向天际渐变（低分辨率生成再双线性放大，极速且丝滑）
    gw, gh = 48, 24
    grad_img = Image.new("RGB", (gw, gh))
    gpx = []
    for y in range(gh):
        ty = y / (gh - 1)
        for x in range(gw):
            tx = x / (gw - 1)
            t = min(1.0, max(0.0, ty * 0.82 + tx * 0.24))
            if t < 0.62:
                gpx.append(_lerp_rgb(c_top, c_mid, t / 0.62))
            else:
                gpx.append(_lerp_rgb(c_mid, c_deep, (t - 0.62) / 0.38))
    grad_img.putdata(gpx)
    canvas = grad_img.resize((pw, ph), Image.Resampling.BILINEAR).convert("RGBA")

    # 2. 晨曦 / 月晕径向柔光
    sun_x = rng.uniform(54, W - 54) * SCALE
    sun_y = rng.uniform(26, 74) * SCALE
    sun_r = rng.uniform(52, 86) * SCALE
    glow = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    for step in range(5, 0, -1):
        rad = sun_r * (step / 5.0)
        alpha = int(28 + (6 - step) * 20)
        gdraw.ellipse((sun_x - rad, sun_y - rad, sun_x + rad, sun_y + rad), fill=(*c_warm, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=14))
    canvas = Image.alpha_composite(canvas, glow)

    # 3. 3 层平滑远近山峦剪影（双谐波叠加，无分段折角）
    for layer in range(3):
        layer_img = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
        ldraw = ImageDraw.Draw(layer_img)
        base_y = (68 + layer * 28) * SCALE
        a1 = rng.uniform(10, 18) * SCALE
        a2 = rng.uniform(4, 9) * SCALE
        f1 = rng.uniform(1.6, 2.8) * math.pi / pw
        f2 = rng.uniform(3.6, 6.2) * math.pi / pw
        p1, p2 = rng.uniform(0, math.tau), rng.uniform(0, math.tau)
        poly: list[tuple[float, float]] = [(0, ph)]
        for x in range(0, pw + 8, 8):
            y = base_y + a1 * math.sin(f1 * x + p1) + a2 * math.sin(f2 * x + p2)
            poly.append((float(x), y))
        poly.append((float(pw), float(ph)))
        fill_col = c_deep if layer == 2 else (c_top if layer == 1 else c_light)
        fill_alpha = 42 if layer == 0 else (88 if layer == 1 else 158)
        ldraw.polygon(poly, fill=(*fill_col, fill_alpha))
        canvas = Image.alpha_composite(canvas, layer_img)

    # 4. 抽象建筑窗格 / 叠层半透明几何块（增加纹理复杂度）
    for i in range(5):
        rw = int(rng.uniform(28, 76) * SCALE)
        rh = int(rng.uniform(18, 48) * SCALE)
        pad_box = max(rw, rh) + 24
        tile = Image.new("RGBA", (pad_box, pad_box), (0, 0, 0, 0))
        tdraw = ImageDraw.Draw(tile)
        ox = (pad_box - rw) // 2
        oy = (pad_box - rh) // 2
        col = c_light if i % 2 == 0 else c_warm
        alpha = rng.randint(16, 38)
        tdraw.rounded_rectangle((ox, oy, ox + rw, oy + rh), radius=8 * SCALE, fill=(*col, alpha))
        tile = tile.rotate(rng.uniform(-22, 22), resample=Image.Resampling.BICUBIC)
        px = int(rng.uniform(10, W - 10) * SCALE) - pad_box // 2
        py = int(rng.uniform(10, H - 10) * SCALE) - pad_box // 2
        canvas.alpha_composite(tile, (px, py))

    # 5. 细腻平滑水波 / 等高曲线
    wave_img = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    wdraw = ImageDraw.Draw(wave_img)
    for _ in range(5):
        y0 = rng.uniform(18, H - 14) * SCALE
        amp1 = rng.uniform(5, 13) * SCALE
        amp2 = rng.uniform(2, 6) * SCALE
        fr1 = rng.uniform(1.8, 3.4) * math.pi / pw
        fr2 = rng.uniform(4.2, 7.2) * math.pi / pw
        ph1, ph2 = rng.uniform(0, math.tau), rng.uniform(0, math.tau)
        pts = [
            (float(x), y0 + amp1 * math.sin(fr1 * x + ph1) + amp2 * math.sin(fr2 * x + ph2))
            for x in range(-8, pw + 16, 8)
        ]
        wdraw.line(pts, fill=(*c_light, rng.randint(24, 52)), width=rng.choice((2, 3)))
    canvas = Image.alpha_composite(canvas, wave_img)

    # 6. 全图密码学随机胶片微颗粒噪点（极速 C 路径，阻断像素精确匹配）
    noise_l = Image.frombytes("L", (W, H), secrets.token_bytes(W * H)).resize((pw, ph), Image.Resampling.NEAREST)
    noise_rgba = Image.merge("RGBA", (noise_l, noise_l, noise_l, Image.new("L", (pw, ph), 16)))
    canvas = Image.alpha_composite(canvas, noise_rgba)
    return canvas


def _draw_recessed_hole(bg: Image.Image, hx: int, hy: int, mask: Image.Image) -> None:
    """在背景图上叠加凹刻质感缺口（柔焦方向内阴影 + 下沿微弱反光唇 + 极细收边）"""
    sz = mask.width
    px, py = hx * SCALE, hy * SCALE

    # 1. 半透明深石板凹底
    recess = Image.new("RGBA", (sz, sz), (10, 14, 22, 114))
    recess.putalpha(mask.point(lambda v: (v * 114) // 255))
    bg.alpha_composite(recess, (px, py))

    # 2. 真实方向性内阴影（反相掩码微移后高斯模糊，仅保留洞内区域）
    inv = ImageChops.invert(mask)
    shifted_inv = ImageChops.offset(inv, 3, 4)
    # 清除回绕边，避免外缘亮线
    sdraw = ImageDraw.Draw(shifted_inv)
    sdraw.rectangle((0, 0, 3, sz), fill=255)
    sdraw.rectangle((0, 0, sz, 4), fill=255)
    inner_blur = shifted_inv.filter(ImageFilter.GaussianBlur(radius=4.0))
    inner_alpha = ImageChops.multiply(inner_blur, mask).point(lambda v: (v * 175) // 255)
    shadow_layer = Image.new("RGBA", (sz, sz), (0, 0, 0, 255))
    shadow_layer.putalpha(inner_alpha)
    bg.alpha_composite(shadow_layer, (px, py))

    # 3. 洞内右下沿环境受光唇
    shifted_up = ImageChops.offset(mask, -2, -2)
    lip_alpha = ImageChops.subtract(mask, shifted_up).point(lambda v: (v * 72) // 255)
    lip_layer = Image.new("RGBA", (sz, sz), (255, 255, 255, 255))
    lip_layer.putalpha(lip_alpha)
    bg.alpha_composite(lip_layer, (px, py))

    # 4. 极细外轮廓收边
    outer_ring = ImageChops.subtract(mask.filter(ImageFilter.MaxFilter(3)), mask)
    rim_layer = Image.new("RGBA", (sz, sz), (255, 255, 255, 255))
    rim_layer.putalpha(outer_ring.point(lambda v: (v * 82) // 255))
    bg.alpha_composite(rim_layer, (px, py))


def _cut_piece(clean_bg: Image.Image, tx: int, ty: int, mask: Image.Image, rng: random.Random) -> Image.Image:
    """从底图裁出拼图块：施加 ±3% 亮度微扰（抗像素差分）+ 立体倒角高光/暗边"""
    sz = mask.width
    px, py = tx * SCALE, ty * SCALE
    crop = clean_bg.crop((px, py, px + sz, py + sz))

    # 轻微亮度微扰（人眼无感，阻断逐像素相减定位）
    crop = ImageEnhance.Brightness(crop).enhance(rng.uniform(0.97, 1.03)).convert("RGBA")

    # 左上受光倒角
    shift_br = ImageChops.offset(mask, 2, 2)
    hi_alpha = ImageChops.subtract(mask, shift_br).point(lambda v: (v * 170) // 255)
    hi_layer = Image.new("RGBA", (sz, sz), (255, 255, 255, 255))
    hi_layer.putalpha(hi_alpha)
    crop = Image.alpha_composite(crop, hi_layer)

    # 右下背光暗边
    shift_tl = ImageChops.offset(mask, -2, -2)
    lo_alpha = ImageChops.subtract(mask, shift_tl).point(lambda v: (v * 98) // 255)
    lo_layer = Image.new("RGBA", (sz, sz), (10, 14, 24, 255))
    lo_layer.putalpha(lo_alpha)
    crop = Image.alpha_composite(crop, lo_layer)

    # 极细玻璃切边
    inner_edge = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(3)))
    edge_layer = Image.new("RGBA", (sz, sz), (255, 255, 255, 255))
    edge_layer.putalpha(inner_edge.point(lambda v: (v * 125) // 255))
    crop = Image.alpha_composite(crop, edge_layer)

    crop.putalpha(mask)
    return crop


def _png_data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=6)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _jpeg_data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=86, subsampling=0)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def new_challenge(client_ip: str = "", fingerprint: str = "") -> dict:
    """生成一道新题（PNG 位图）；x 仅存服务端内存，不出现在返回值中"""
    now = time.time()
    _purge(_challenges, now)
    _purge(_tickets, now)

    escalated = _recent_fails(client_ip, now) >= ESCALATE_FAILS
    rng = random.Random(secrets.randbits(64))

    body = rng.randint(33, 36)
    tabs = _random_tabs(rng)
    tx = rng.randint(76, W - PIECE_BOX - 12)
    ty = rng.randint(10, H - PIECE_BOX - 10)

    clean_bg = _render_scene(rng)
    real_mask = _jigsaw_mask(body, tabs)
    piece_img = _cut_piece(clean_bg, tx, ty, real_mask, rng)

    bg_img = clean_bg.copy()
    decoy_count = 2 if escalated else 1
    placed = [(tx, ty)]
    for idx in range(decoy_count):
        for _ in range(36):
            dx = rng.randint(44, W - PIECE_BOX - 10)
            dy = (
                max(10, min(H - PIECE_BOX - 10, ty + rng.randint(-12, 12)))
                if idx == 0
                else rng.randint(10, H - PIECE_BOX - 10)
            )
            if all(math.hypot(px - dx, py - dy) >= PIECE_BOX + 4 for px, py in placed):
                placed.append((dx, dy))
                decoy_mask = _jigsaw_mask(body, _random_tabs(rng, exclude=tabs))
                _draw_recessed_hole(bg_img, dx, dy, decoy_mask)
                break

    _draw_recessed_hole(bg_img, tx, ty, real_mask)

    cid = secrets.token_urlsafe(12)
    _challenges[cid] = {
        "x": tx,
        "y": ty,
        "created": now,
        "fp": fingerprint,
        "tol": ESCALATED_TOLERANCE if escalated else TOLERANCE,
    }
    return {
        "id": cid,
        "bg": _jpeg_data_uri(bg_img),
        "piece": _png_data_uri(piece_img),
        "y": ty,
        "width": W,
        "height": H,
        "size": PIECE_BOX,
        "escalated": escalated,
    }


def _is_human_trail(trail: list[tuple[int, int, int]], target_x: int, duration_ms: int) -> bool:
    """多因子人机拖动轨迹分析：拦截直调接口与等速机器人，兼容鼠标/触控板/手机触屏"""
    if not (6 <= len(trail) <= 200):
        return False
    if not (MIN_DURATION_MS <= duration_ms <= MAX_DURATION_MS):
        return False

    t0, x0, _ = trail[0]
    t_last, x_last, _ = trail[-1]
    if t0 != 0 or abs(x0) > 4:
        return False
    if abs(x_last - target_x) > 2:
        return False
    if abs(t_last - duration_ms) > 150:
        return False

    speeds: list[float] = []
    reversals = 0
    prev_dir = 0
    ys = [trail[0][2]]

    for i in range(1, len(trail)):
        t_prev, x_prev, _ = trail[i - 1]
        t_cur, x_cur, y_cur = trail[i]
        if t_cur < t_prev:
            return False
        ys.append(y_cur)
        dt = t_cur - t_prev
        dx = x_cur - x_prev
        if dx != 0:
            cur_dir = 1 if dx > 0 else -1
            if prev_dir != 0 and cur_dir != prev_dir:
                reversals += 1
            prev_dir = cur_dir
        if dt > 0:
            speeds.append(abs(dx) / dt)

    if len(speeds) < 4:
        return False

    mean_v = statistics.fmean(speeds)
    if mean_v <= 0:
        return False
    cv = statistics.pstdev(speeds) / mean_v
    # 硬门槛：完全等速直线脚本 cv ≈ 0，一律拦截
    if cv < 0.12:
        return False

    # 末段瞄准减速特征：后 25% 平均速度低于中段 50%
    n = len(speeds)
    mid_slice = speeds[max(1, n // 4) : max(2, (3 * n) // 4)]
    tail_slice = speeds[max(1, (3 * n) // 4) :]
    has_decel = bool(mid_slice and tail_slice and statistics.fmean(tail_slice) < statistics.fmean(mid_slice) * 0.92)
    y_range = max(ys) - min(ys)

    # 多因子自然度（满足任意一项即可，避免触控板水平滑行误杀）
    return cv >= 0.22 or y_range >= 1 or has_decel or reversals >= 1


def verify(
    cid: str,
    x: int,
    duration_ms: int = 0,
    trail: list[tuple[int, int, int]] | None = None,
    client_ip: str = "",
    fingerprint: str = "",
) -> str | None:
    """四维联合校验：成功返回一次性 ticket 并重置失败计数，失败返回 None（无论成败题目作废）"""
    now = time.time()
    item = _challenges.pop(cid or "", None)
    if not item or now - item["created"] > TTL:
        _record_fail(client_ip, now)
        return None
    if item["fp"] and fingerprint and item["fp"] != fingerprint:
        _record_fail(client_ip, now)
        return None

    elapsed = now - item["created"]
    if elapsed < MIN_SERVER_ELAPSED:
        _record_fail(client_ip, now)
        return None
    if duration_ms > elapsed * 1000 + 600:
        _record_fail(client_ip, now)
        return None
    if abs(x - item["x"]) > item["tol"]:
        _record_fail(client_ip, now)
        return None
    if not _is_human_trail(trail or [], x, duration_ms):
        _record_fail(client_ip, now)
        return None

    if client_ip:
        _fail_hits.pop(client_ip, None)
    ticket = secrets.token_urlsafe(18)
    _tickets[ticket] = {"created": now, "fp": fingerprint}
    return ticket


def consume(ticket: str | None, fingerprint: str = "") -> bool:
    """登录时一次性消费票据并校验客户端指纹；验证码关闭时直接放行"""
    if not _enabled:
        return True
    if not ticket:
        return False
    rec = _tickets.pop(ticket, None)
    if not rec or time.time() - rec["created"] > TTL:
        return False
    if rec["fp"] and fingerprint and rec["fp"] != fingerprint:
        return False
    return True
