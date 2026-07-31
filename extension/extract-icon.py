# -*- coding: utf-8 -*-
"""从 Reasonix 官方 exe 提取最大尺寸图标，输出 16/32/48/128 PNG。
用法: python extract-icon.py <exe路径> <输出目录>"""
import sys, os, struct
import pefile

def extract_icons(exe_path, out_dir):
    pe = pefile.PE(exe_path, fast_load=False)
    icons = {}  # size -> raw bytes (PNG or BMP-format DIB)

    def get_rsrc_dir():
        for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
            if entry.id == pefile.RESOURCE_TYPE["RT_ICON"]:
                return entry
        return None

    def walk_icon(entry, path=()):
        # entry -> directory or leaf (each id = icon id)
        if hasattr(entry, "directory"):
            for e in entry.directory.entries:
                walk_icon(e, path + (entry.id,))
        else:
            data = entry.data.struct
            icon_id = entry.id
            blob = pe.get_memory_mapped_image()[data.OffsetToData: data.OffsetToData + data.Size]
            icons[icon_id] = blob

    def get_group_sizes():
        sizes = {}
        for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
            if entry.id == pefile.RESOURCE_TYPE["RT_GROUP_ICON"]:
                def walk(e, path=()):
                    if hasattr(e, "directory"):
                        for x in e.directory.entries:
                            walk(x, path + (e.id,))
                    else:
                        data = e.data.struct
                        blob = pe.get_memory_mapped_image()[data.OffsetToData: data.OffsetToData + data.Size]
                        # ICONDIR: reserved(2) type(2) count(2)
                        count = struct.unpack_from("<H", blob, 4)[0]
                        for i in range(count):
                            # GRPICONDIRENTRY: w(1) h(1) cc(1) rsv(1) planes(2) bpp(2) size(4) id(2) = 14 字节
                            b, w, h, cc, planes, bpp, size, ico_id = struct.unpack_from("<BBBBHHIH", blob, 6 + i * 14)
                            sizes[ico_id] = (w or 256, h or 256)
                walk(entry)
        return sizes

    group = get_group_sizes()
    rsrc = get_rsrc_dir()
    if rsrc:
        for e in rsrc.directory.entries:
            walk_icon(e)

    # 按尺寸排序输出
    import zlib
    os.makedirs(out_dir, exist_ok=True)
    results = []
    for ico_id, blob in icons.items():
        w, h = group.get(ico_id, (0, 0))
        if blob[:8] == b"\x89PNG\r\n\x1a\n":
            ext = "png"
            results.append((w, h, ico_id, blob, "png"))
        elif blob[:4] == b"\x00\x00\x01\x00":
            # ICO 内嵌位图（BMP DIB）
            results.append((w, h, ico_id, blob, "ico"))
    results.sort(key=lambda x: -(x[0] or 0))
    return results

def dib_to_png(dib, out_path):
    """把 ICO 内嵌 BMP DIB（含 BITMAPINFOHEADER）转 PNG（用 zlib 手写）。"""
    import zlib, struct as st
    # BITMAPINFOHEADER
    header_size = struct.unpack_from("<I", dib, 0)[0]
    w = struct.unpack_from("<i", dib, 4)[0]
    h_raw = struct.unpack_from("<i", dib, 8)[0]
    planes = struct.unpack_from("<H", dib, 12)[0]
    bpp = struct.unpack_from("<H", dib, 14)[0]
    comp = struct.unpack_from("<I", dib, 16)[0]
    h = abs(h_raw)
    if bpp == 32 and comp == 0:
        row_size = w * 4
        and_size = ((w + 31) // 32) * 4 * h
        pixel_data = dib[header_size:header_size + row_size * h]
        # 反转行（DIB 自底向上）
        rows = [pixel_data[y * row_size:(y + 1) * row_size] for y in range(h)][::-1]
        raw = b"".join(b"\x00" + r for r in rows)
    else:
        raise ValueError(f"不支持的 DIB: bpp={bpp} comp={comp}")
    def chunk(tag, data):
        c = st.pack(">I", len(data)) + tag + data
        c += st.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c
    ihdr = st.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(out_path, "wb") as f:
        f.write(png)

def main():
    exe = sys.argv[1]
    out_dir = sys.argv[2]
    results = extract_icons(exe, out_dir)
    print(f"共 {len(results)} 个图标资源：")
    for w, h, iid, blob, kind in results[:12]:
        print(f"  id={iid} {w}x{h} ({kind}, {len(blob)} bytes)")
    # 取最大一个
    if not results:
        print("无图标资源"); sys.exit(1)
    w, h, iid, blob, kind = results[0]
    print(f"\n选用最大: id={iid} {w}x{h} {kind}")
    src_path = os.path.join(out_dir, f"source_{w}x{h}.{'png' if kind == 'png' else 'ico'}")
    with open(src_path, "wb") as f:
        f.write(blob)
    print("源文件:", src_path)

if __name__ == "__main__":
    main()
