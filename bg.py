#!/usr/bin/env python3
"""dsh-session-bg 命令行：按会话给对话栏配背景图。

用法：
  python bg.py list
  python bg.py current
  python bg.py set --session current --image "D:\\pics\\xxx.png" [--dim 0.35] [--fit cover] [--position center]
  python bg.py set --session <sessionId> --image "..."
  python bg.py clear --session current
  python bg.py clear --all
  python bg.py enable / disable

说明：--session current 读取插件目录下的 current-session.json（Host 在会话事件里写入最近活跃会话）。
改完配置后在 GUI 里切换一次会话（或等 15 秒）即可看到新背景，无需重启 DSH。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
CONFIG_FILE = PLUGIN_DIR / "config.json"
CURRENT_FILE = PLUGIN_DIR / "current-session.json"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg"}


def load_config() -> dict:
    try:
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {"enabled": True, "sessions": {}}
    except json.JSONDecodeError as error:
        sys.exit(f"config.json 解析失败：{error}")
    if not isinstance(raw, dict):
        return {"enabled": True, "sessions": {}}
    raw.setdefault("enabled", True)
    sessions = raw.get("sessions")
    if not isinstance(sessions, dict):
        raw["sessions"] = {}
    return raw


def save_config(config: dict) -> None:
    if CONFIG_FILE.exists():
        shutil.copyfile(CONFIG_FILE, CONFIG_FILE.with_suffix(".json.bak"))
    tmp = CONFIG_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, CONFIG_FILE)


def current_session() -> dict | None:
    try:
        data = json.loads(CURRENT_FILE.read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) and data.get("id") else None


def resolve_session(value: str) -> str:
    if value.lower() != "current":
        return value
    current = current_session()
    if current is None:
        sys.exit(
            "还没有记录当前会话：先在 GUI 里打开一个会话（插件会在会话事件时写入 "
            f"{CURRENT_FILE.name}），或直接传 --session <sessionId>。"
        )
    return str(current["id"])


def normalize_image(value: str) -> str:
    if value.startswith(("http://", "https://", "data:")):
        return value
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    path = path.resolve()
    if not path.is_file():
        sys.exit(f"图片不存在：{path}")
    if path.suffix.lower() not in IMAGE_EXTS:
        print(f"提示：{path.suffix or '(无扩展名)'} 不是常见图片格式，仍会按文件内容类型尝试发送。", file=sys.stderr)
    return str(path)


def cmd_list() -> None:
    config = load_config()
    current = current_session()
    print(f"enabled: {config.get('enabled', True)}")
    print(f"current session: {current['id'] if current else '(未记录)'}")
    sessions = config.get("sessions", {})
    if not sessions:
        print("sessions: (空)")
        return
    print("sessions:")
    for sid, entry in sessions.items():
        image = entry.get("image", "")
        mark = " <当前会话>" if current and current["id"] == sid else ""
        local = image if image.startswith(("http://", "https://", "data:")) else str(Path(image))
        exists = "" if image.startswith(("http://", "https://", "data:")) or Path(image).is_file() else "  [文件缺失]"
        print(f"  {sid}{mark}")
        print(f"    image: {local}{exists}")
        print(
            f"    dim: {entry.get('dim', 0.35)}  fit: {entry.get('fit', 'cover')}  "
            f"position: {entry.get('position', 'center')}"
        )


def cmd_current() -> None:
    current = current_session()
    if current is None:
        print("(未记录当前会话)")
        return
    print(json.dumps(current, ensure_ascii=False, indent=2))


def cmd_set(args: argparse.Namespace) -> None:
    session_id = resolve_session(args.session)
    image = normalize_image(args.image)
    if not 0 <= args.dim <= 1:
        sys.exit("--dim 需在 0 到 1 之间")
    if args.fit not in {"cover", "contain", "repeat"}:
        sys.exit("--fit 只能是 cover / contain / repeat")
    config = load_config()
    config.setdefault("sessions", {})[session_id] = {
        "image": image,
        "dim": args.dim,
        "fit": args.fit,
        "position": args.position,
    }
    save_config(config)
    print(f"已设置会话背景：{session_id}")
    print(f"  image: {image}")
    print(f"  dim: {args.dim}  fit: {args.fit}  position: {args.position}")
    print("GUI 中切换一次会话（或等 15 秒刷新）即可看到效果，无需重启。")


def cmd_clear(args: argparse.Namespace) -> None:
    config = load_config()
    sessions = config.setdefault("sessions", {})
    if args.all:
        sessions.clear()
        save_config(config)
        print("已清空全部会话背景。")
        return
    session_id = resolve_session(args.session)
    if session_id not in sessions:
        print(f"该会话没有配置背景：{session_id}")
        return
    del sessions[session_id]
    save_config(config)
    print(f"已清除会话背景：{session_id}")


def cmd_toggle(enabled: bool) -> None:
    config = load_config()
    config["enabled"] = enabled
    save_config(config)
    print(f"enabled = {enabled}")


def main() -> None:
    parser = argparse.ArgumentParser(description="按会话给 DSH 对话栏配背景图")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="查看已配置的背景")
    sub.add_parser("current", help="查看最近活跃会话 ID")
    sub.add_parser("enable", help="启用背景功能")
    sub.add_parser("disable", help="停用背景功能")

    set_parser = sub.add_parser("set", help="给会话设置背景图")
    set_parser.add_argument("--session", required=True, help="sessionId，或 current")
    set_parser.add_argument("--image", required=True, help="本地图片路径，或 http(s)/data URL")
    set_parser.add_argument("--dim", type=float, default=0.35, help="压暗层透明度 0~1（默认 0.35）")
    set_parser.add_argument("--fit", default="cover", help="cover / contain / repeat（默认 cover）")
    set_parser.add_argument("--position", default="center", help="background-position（默认 center）")

    clear_parser = sub.add_parser("clear", help="清除会话背景")
    clear_parser.add_argument("--session", default="current", help="sessionId，或 current")
    clear_parser.add_argument("--all", action="store_true", help="清空所有会话")

    args = parser.parse_args()
    if args.command == "list":
        cmd_list()
    elif args.command == "current":
        cmd_current()
    elif args.command == "set":
        cmd_set(args)
    elif args.command == "clear":
        cmd_clear(args)
    elif args.command == "enable":
        cmd_toggle(True)
    elif args.command == "disable":
        cmd_toggle(False)


if __name__ == "__main__":
    main()
