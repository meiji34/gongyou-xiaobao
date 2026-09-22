#!/usr/bin/env python3
"""缺少正式素材时，生成高处作业安全微课占位视频。"""
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
FONT = "C\\:/Windows/Fonts/msyh.ttc"  # ffmpeg 滤镜路径转义
OUT_DIR = Path(__file__).parent.parent / "videos"
OUT_DIR.mkdir(exist_ok=True)

# 每个视频：背景色 + [(开始秒, 结束秒, 标题, 副标题)]
VIDEOS = {
    "safety_height.mp4": {
        "bg": "0xF26430",
        "slides": [
            (0, 6, "安全微课 · 第一课", "高处作业安全规范"),
            (6, 12, "上架子必须系安全带", "安全带要高挂低用"),
            (12, 18, "安全帽带子要扣紧", "下颏带松了等于白戴"),
            (18, 24, "六级大风停止登高", "大雨大雾天也一样"),
        ],
    },
}


def drawtext(text, y, size, t0, t1, bold=False):
    return (
        f"drawtext=fontfile='{FONT}':text='{text}':"
        f"fontcolor=white:fontsize={size}:"
        f"x=(w-text_w)/2:y={y}:"
        f"enable='between(t,{t0},{t1})'"
    )


for name, cfg in VIDEOS.items():
    filters = []
    for t0, t1, title, sub in cfg["slides"]:
        filters.append(drawtext(title, 520, 72, t0, t1))
        filters.append(drawtext(sub, 660, 46, t0, t1))
    vf = ",".join(filters)
    out = OUT_DIR / name
    if out.exists():
        print(f"SKIP {name}: 已有正式视频素材")
        continue
    cmd = [
        FFMPEG, "-y",
        "-f", "lavfi", "-i", f"color=c={cfg['bg']}:size=720x1280:rate=25:duration=24",
        "-vf", vf,
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-preset", "veryfast", "-crf", "26",
        "-movflags", "+faststart",
        str(out),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(f"FAIL {name}:", r.stderr[-500:])
        sys.exit(1)
    print(f"OK {name} {out.stat().st_size // 1024}KB")

print("高处作业视频检查完毕")
