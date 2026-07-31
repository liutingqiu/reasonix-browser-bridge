"""生成 Reasonix 插件图标（蓝底圆 + 白色 R 点阵字），输出 16/32/48/128 PNG。"""
import struct, zlib, os

R_BITMAP = [
    "1111000",
    "1000100",
    "1000100",
    "1111000",
    "1010000",
    "1001000",
    "1000100",
    "1000100",
]

def make_icon(size):
    # 背景渐变（中心浅蓝 -> 边缘深蓝），画成圆形
    cx = cy = (size - 1) / 2
    r = size / 2
    rows = []
    # 点阵 R 的绘制区域
    cell = size * 0.052
    r_w = len(R_BITMAP[0])
    r_h = len(R_BITMAP)
    grid_w = r_w * cell
    grid_h = r_h * cell
    ox = (size - grid_w) / 2
    oy = (size - grid_h) / 2 + size * 0.03
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = x - cx, y - cy
            dist = (dx * dx + dy * dy) ** 0.5
            if dist > r:
                row += b"\x00\x00\x00\x00"
                continue
            # 背景径向渐变
            t = dist / r
            r_c = int(0x4D + (0x19 - 0x4D) * t)
            g_c = int(0xAB + (0x71 - 0xAB) * t)
            b_c = int(0xF7 + (0xC2 - 0xF7) * t)
            # 白 R 字形
            gx = int((x - ox) / cell)
            gy = int((y - oy) / cell)
            if 0 <= gy < r_h and 0 <= gx < r_w and R_BITMAP[gy][gx] == "1":
                # 轻微抗锯齿：边缘半透明
                inner_x = (x - ox) / cell - gx
                inner_y = (y - oy) / cell - gy
                edge = min(inner_x, inner_y, 1 - inner_x, 1 - inner_y)
                alpha = 255 if edge > 0.18 else max(0, min(255, int(255 * (edge / 0.18))))
                row += bytes((255, 255, 255, alpha))
            else:
                row += bytes((r_c, g_c, b_c, 255))
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    return png

os.makedirs("icons", exist_ok=True)
for s in (16, 32, 48, 128):
    with open(f"icons/icon{s}.png", "wb") as f:
        f.write(make_icon(s))
    print(f"icon{s}.png  {os.path.getsize(f'icons/icon{s}.png')} bytes")
