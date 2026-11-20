"""登录滑块验证码：服务端生成拼图缺口，校验拖动偏移（演示级，内存态）

设计要点：
- 图片是服务端随机生成的 SVG（渐变 + 图形 + 纹理线），不加 Pillow 依赖；
- 缺口位置（x/y）只留在服务端内存，前端拿不到答案；
- 校验通过签发一次性 captcha_token，登录接口消费掉（登录失败也消耗，须重新滑动）；
- 沿用 auth.py 限流的内存字典风格，5 分钟 TTL + 每次访问顺带清理。
"""
import base64
import random
import secrets
import time

from app.config import CAPTCHA_ENABLED

W = 320          # 背景图宽（逻辑坐标）
H = 160          # 背景图高
PIECE = 50       # 拼图块边长
TOLERANCE = 6    # 允许的偏移误差（逻辑像素）
TTL = 300        # challenge / ticket 有效期（秒）

_BASES = ["#8ec5fc", "#fbc2eb", "#a1c4fd", "#fddb92", "#d4fc79", "#84fab0", "#ffd3a5", "#c2e9fb"]
_BLOBS = ["#ffffff", "#0071e3", "#ff9500", "#34c759", "#af52de", "#ff3b30", "#5e5ce6"]

_enabled = CAPTCHA_ENABLED
_challenges: dict[str, dict] = {}
_tickets: dict[str, float] = {}


def enabled() -> bool:
    return _enabled


def set_enabled(value: bool) -> None:
    """测试/自动化切换开关"""
    global _enabled
    _enabled = value


def _purge(store: dict, now: float) -> None:
    for key in [k for k, v in store.items() if now - (v["created"] if isinstance(v, dict) else v) > TTL]:
        store.pop(key, None)


def _scene(rng: random.Random) -> tuple[str, str]:
    """返回 (defs, body)：同一份背景元素在两张图里复用，保证拼图块与背景严格同源"""
    base = rng.choice(_BASES)
    accent = rng.choice(_BASES)
    defs = (
        '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{base}"/><stop offset="1" stop-color="{accent}"/>'
        "</linearGradient>"
    )
    parts = [f'<rect width="{W}" height="{H}" fill="url(#g)"/>']
    for _ in range(rng.randint(4, 7)):
        parts.append(
            f'<circle cx="{rng.uniform(0, W):.0f}" cy="{rng.uniform(0, H):.0f}" '
            f'r="{rng.uniform(18, 62):.0f}" fill="{rng.choice(_BLOBS)}" '
            f'opacity="{rng.uniform(.12, .32):.2f}"/>'
        )
    for _ in range(rng.randint(2, 4)):
        x, y = rng.uniform(-20, W), rng.uniform(-20, H)
        w, h = rng.uniform(40, 120), rng.uniform(30, 90)
        parts.append(
            f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" rx="12" '
            f'fill="{rng.choice(_BLOBS)}" opacity="{rng.uniform(.08, .22):.2f}" '
            f'transform="rotate({rng.randint(-25, 25)} {x + w / 2:.0f} {y + h / 2:.0f})"/>'
        )
    for _ in range(rng.randint(3, 5)):
        y0, x = rng.uniform(0, H), -10.0
        d = f"M -10 {y0:.0f}"
        while x < W + 10:
            x += rng.uniform(30, 70)
            d += f" Q {x - 15:.0f} {y0 + rng.uniform(-28, 28):.0f} {x:.0f} {y0 + rng.uniform(-10, 10):.0f}"
        parts.append(
            f'<path d="{d}" fill="none" stroke="#fff" '
            f'stroke-opacity="{rng.uniform(.10, .22):.2f}" stroke-width="{rng.uniform(1, 2.4):.1f}"/>'
        )
    return defs, "".join(parts)


def _data_uri(svg: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


def _bg_svg(defs: str, body: str, x: int, y: int) -> str:
    hole = (
        f'<rect x="{x}" y="{y}" width="{PIECE}" height="{PIECE}" rx="8" '
        'fill="rgba(0,0,0,.42)" stroke="rgba(255,255,255,.85)" stroke-width="1.5"/>'
    )
    return _data_uri(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
        f"<defs>{defs}</defs>{body}{hole}</svg>"
    )


def _piece_svg(defs: str, body: str, x: int, y: int) -> str:
    clip = f'<clipPath id="c"><rect width="{PIECE}" height="{PIECE}" rx="8"/></clipPath>'
    return _data_uri(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{PIECE}" height="{PIECE}" '
        f'viewBox="0 0 {PIECE} {PIECE}"><defs>{defs}{clip}</defs>'
        f'<g clip-path="url(#c)"><g transform="translate({-x},{-y})">{body}</g></g>'
        f'<rect x="0.75" y="0.75" width="{PIECE - 1.5}" height="{PIECE - 1.5}" rx="8" '
        'fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.5"/></svg>'
    )


def new_challenge() -> dict:
    """生成一道新题；x 不出现在返回值里（答案只在内存）"""
    now = time.time()
    _purge(_challenges, now)
    _purge(_tickets, now)
    rng = random.Random(secrets.randbits(64))
    x = rng.randint(60, W - PIECE - 12)
    y = rng.randint(8, H - PIECE - 8)
    defs, body = _scene(rng)
    cid = secrets.token_urlsafe(12)
    _challenges[cid] = {"x": x, "y": y, "created": now}
    return {
        "id": cid,
        "bg": _bg_svg(defs, body, x, y),
        "piece": _piece_svg(defs, body, x, y),
        "y": y,
        "width": W,
        "height": H,
        "size": PIECE,
    }


def verify(cid: str, x: int) -> str | None:
    """校验拖动偏移；成功返回一次性 ticket，失败返回 None（无论成败题目都作废）"""
    now = time.time()
    item = _challenges.pop(cid or "", None)
    if not item or now - item["created"] > TTL:
        return None
    if abs(x - item["x"]) > TOLERANCE:
        return None
    ticket = secrets.token_urlsafe(16)
    _tickets[ticket] = now
    return ticket


def consume(ticket: str | None) -> bool:
    """登录时消费一次性票据；验证码关闭时直接放行"""
    if not _enabled:
        return True
    if not ticket:
        return False
    created = _tickets.pop(ticket, None)
    return created is not None and time.time() - created <= TTL
