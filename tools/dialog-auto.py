# -*- coding: utf-8 -*-
"""操作"选择扩展目录"对话框：WM_SETTEXT 填路径 + BM_CLICK 点"选择文件夹"按钮。"""
import ctypes
import time
import sys

user32 = ctypes.windll.user32

WM_SETTEXT = 0x000C
BM_CLICK = 0x00F5
EXT_DIR = r"D:\makemoneyreasonix\edge-extension"

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
CHILDPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

dlgs = []
def cb(hwnd, lp):
    if user32.IsWindowVisible(hwnd):
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        t = buf.value
        # Chrome: "选择扩展程序目录"; Edge: "选择扩展目录"; 英文: "Select the extension directory"
        if ("选择扩展" in t and "目录" in t) or "Select the extension directory" in t or "Select Folder" in t or "选择文件夹" in t or "Browse" in t:
            dlgs.append(hwnd)
    return True
user32.EnumWindows(WNDENUMPROC(cb), 0)
if not dlgs:
    print("未找到对话框")
    sys.exit(1)
dlg = dlgs[0]
print("对话框:", hex(dlg))

# 收集子控件
edits = []
buttons = []
def child_cb(hwnd, lp):
    cls = ctypes.create_unicode_buffer(128)
    user32.GetClassNameW(hwnd, cls, 128)
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    if cls.value == "Edit":
        edits.append(hwnd)
    elif cls.value == "Button":
        buttons.append((hwnd, buf.value))
    return True
user32.EnumChildWindows(dlg, CHILDPROC(child_cb), 0)
print("Edit 控件:", [hex(e) for e in edits])
print("Button 控件:", [(hex(b), t) for b, t in buttons])

if not edits:
    print("没有 Edit 控件")
    sys.exit(1)
edit = edits[0]

# 设置路径
user32.SendMessageW(edit, WM_SETTEXT, 0, EXT_DIR)
print("已填入路径:", EXT_DIR)
time.sleep(0.5)

# 确认路径生效（读回）
buf = ctypes.create_unicode_buffer(512)
user32.SendMessageW(edit, 0x000D, 512, buf)  # WM_GETTEXT
print("读回:", buf.value)

# 找"选择文件夹"按钮并点击
target = None
for b, t in buttons:
    if "选择文件夹" in t or "Select Folder" in t or "选择" in t:
        target = b
        print("确认按钮:", hex(b), t)
        break
if not target:
    # 退而求其次：点第一个非取消按钮
    for b, t in buttons:
        if "取消" not in t and "Cancel" not in t:
            target = b
            print("兜底按钮:", hex(b), t)
            break
if not target:
    print("未找到确认按钮")
    sys.exit(1)

user32.SendMessageW(target, BM_CLICK, 0, 0)
print("已点击确认按钮，等待加载…")
time.sleep(3)

# 检查对话框是否关闭
dlgs2 = []
user32.EnumWindows(WNDENUMPROC(cb), 0)
print("对话框仍打开:", len(dlgs2) > 0)
sys.exit(0 if not dlgs2 else 2)
