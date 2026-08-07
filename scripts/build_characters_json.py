# -*- coding: utf-8 -*-
"""
build_characters_json.py — 从 waiIllustrious 角色 tag 数据源构建前端数据文件

输入（来自 mirabarukaso/character_select_stand_alone_app 的 data/ 目录）：
  - waiIllustriousSDXL_v160_characters.csv  中文名,英文tag（5090 行）
  - waiIllustriousSDXL_v160_tag_assist.json  { 英文tag: 追加词 }
  - view_tags.json                           分组 tag 列表（角度/镜头/背景/风格）
  - wildcards/wildcardPoses.txt              姿势 wildcard（每行一个姿势）

输出：data/characters.json
  {
    "version": "waiIllustriousSDXL_v160",
    "characters": [{ "cn": "中文名", "en": "英文tag" }, ...],
    "tagAssist": { "en-tag": "追加词", ... },
    "viewTags": { "angle": [...], ... },
    "poses": ["standing", "sitting", ...]
  }

前端一次 fetch + 本地缓存，中文名模糊搜索英文 tag。
运行：python3 scripts/build_characters_json.py
"""
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "..", "data")
OUT_PATH = os.path.join(DATA_DIR, "characters.json")

# 数据源文件（若不存在则提示从 GitHub 下载）
SOURCES = {
    "characters": os.path.join(DATA_DIR, "waiIllustriousSDXL_v160_characters.csv"),
    "tag_assist": os.path.join(DATA_DIR, "waiIllustriousSDXL_v160_tag_assist.json"),
    "view_tags": os.path.join(DATA_DIR, "view_tags.json"),
    "poses": os.path.join(DATA_DIR, "wildcardPoses.txt"),
}

HF_BASE = "https://raw.githubusercontent.com/mirabarukaso/character_select_stand_alone_app/main/data"


def _missing_hint():
    lines = [
        "缺少数据源文件。请从以下 URL 下载到 data/ 目录：",
        f"  {HF_BASE}/waiIllustriousSDXL_v160_characters.csv",
        f"  {HF_BASE}/waiIllustriousSDXL_v160_tag_assist.json",
        f"  {HF_BASE}/view_tags.json",
        f"  {HF_BASE}/wildcards/wildcardPoses.txt",
    ]
    return "\n".join(lines)


def load_characters(path):
    """解析 '中文名,英文tag' CSV，跳过空行与表头。"""
    chars = []
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split(",", 1)
            if len(parts) != 2:
                continue
            cn, en = parts[0].strip(), parts[1].strip()
            if cn and en:
                chars.append({"cn": cn, "en": en})
    return chars


def load_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return fallback


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    missing = [name for name, p in SOURCES.items() if not os.path.isfile(p)]
    if missing:
        print(_missing_hint())
        print("缺失：%s" % ", ".join(missing))
        sys.exit(1)

    characters = load_characters(SOURCES["characters"])
    tag_assist = load_json(SOURCES["tag_assist"], {})
    view_tags = load_json(SOURCES["view_tags"], {})
    poses = []
    with open(SOURCES["poses"], "r", encoding="utf-8") as f:
        poses = [ln.strip() for ln in f if ln.strip()]

    data = {
        "version": "waiIllustriousSDXL_v160",
        "characters": characters,
        "tagAssist": tag_assist,
        "viewTags": view_tags,
        "poses": poses,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    print("已生成 %s" % OUT_PATH)
    print("  角色数: %d, tagAssist: %d, viewTags 分组: %d, poses: %d" % (
        len(characters), len(tag_assist), len(view_tags), len(poses),
    ))


if __name__ == "__main__":
    main()
