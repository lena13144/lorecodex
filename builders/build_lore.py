"""
Universal Discrete Lore / SillyTavern Worldbook / Markdown Dossier Builder.
Supports standalone tree output OR idempotent merging (--merge-into) into an existing novel tree.

Zero external dependencies (Python 3.12 standard library only).
"""

import argparse
import collections
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

GAME_STAT_NOISE_RE = re.compile(
    r"伤害提高|暴击率|稳态伤害|导染指数|不可叠加|回合最多触发|造成.{0,12}伤害|"
    r"防御提高|攻击力提高|生命上限|暴击伤害|技能冷却|精准伤害|范围伤害|掩体|格挡|破稳|"
    r"活动期间|累计登录|活动奖励|充值|礼包|掉落率|穿甲等级|穿透等级|抽奖券|每周一重置|"
    r"是否确认选择序列|是否确认重置序列|敬请期待|版本更新|维护|可获赠|用于.{0,16}兑换"
)


BOILERPLATE_CSS_MACRO_RE = re.compile(r"<style[\s\S]*?</style>|<!--[\s\S]*?-->|<[^>]+>|\{\{[^}]*\}\}", re.I)


def is_noise_entry(text):
    clean = str(text or "").strip()
    if len(clean) < 20:
        return True
    stripped_markup = re.sub(r"\s+", " ", BOILERPLATE_CSS_MACRO_RE.sub(" ", clean)).strip()
    if re.search(r"<style\b|\{\{\s*(?:setvar|getvar|addvar)", clean, re.I) and len(stripped_markup) < 40:
        return True
    hits = len(GAME_STAT_NOISE_RE.findall(clean))
    if hits >= 2 or (hits >= 1 and len(clean) < 160):
        return True
    return False


def slugify(s):
    res = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "_", str(s or "")).strip("_")
    return res[:32] or "lore"


def _parse_keys(raw_keys):
    if isinstance(raw_keys, str):
        return [x.strip() for x in raw_keys.split(",") if x.strip()]
    if isinstance(raw_keys, list):
        return [str(x).strip() for x in raw_keys if str(x).strip()]
    return []


def load_lore_entries(input_path, filter_stats=False, include_disabled=False):
    entries = []
    if os.path.isdir(input_path):
        for root, _, files in sorted(os.walk(input_path)):
            rel_group = os.path.relpath(root, input_path)
            bucket = "通用档案" if rel_group == "." else rel_group.replace(os.sep, "/")
            for fname in sorted(files):
                if not fname.lower().endswith((".md", ".txt")):
                    continue
                fpath = os.path.join(root, fname)
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    txt = f.read().strip()
                if not txt or (filter_stats and is_noise_entry(txt)):
                    continue
                title = os.path.splitext(fname)[0]
                entries.append({
                    "id": slugify(title),
                    "bucket": bucket,
                    "title": title,
                    "keys": [],
                    "order": None,
                    "text": txt,
                })
        return entries

    if input_path.lower().endswith(".jsonl"):
        with open(input_path, "r", encoding="utf-8") as f:
            for idx, line in enumerate(f, 1):
                if not line.strip():
                    continue
                obj = json.loads(line)
                txt = str(obj.get("content") or obj.get("text") or "").strip()
                if not txt or (filter_stats and is_noise_entry(txt)):
                    continue
                title = str(obj.get("title") or obj.get("comment") or f"条目{idx}").strip()
                keys = obj.get("keys") or obj.get("key") or obj.get("characters") or []
                entries.append({
                    "id": str(obj.get("id") or f"L{idx:03d}"),
                    "bucket": str(obj.get("bucket") or obj.get("group") or "设定档案"),
                    "title": title,
                    "keys": [str(k).strip() for k in keys if str(k).strip()],
                    "order": obj.get("order"),
                    "text": txt,
                })
        return entries

    # SillyTavern Worldbook JSON OR Character Card V2/V3 JSON (data.character_book.entries)
    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    raw_list = []
    default_book_bucket = "世界观与技术档案"
    if isinstance(data, list):
        raw_list = data
    elif isinstance(data, dict):
        ents = data.get("entries")
        if ents is None and isinstance(data.get("data"), dict) and isinstance(data["data"].get("character_book"), dict):
            cb = data["data"]["character_book"]
            ents = cb.get("entries")
            if cb.get("name"):
                default_book_bucket = str(cb["name"]).strip()
        elif ents is None and isinstance(data.get("character_book"), dict):
            cb = data["character_book"]
            ents = cb.get("entries")
            if cb.get("name"):
                default_book_bucket = str(cb["name"]).strip()
        raw_list = list(ents.values()) if isinstance(ents, dict) else (ents if isinstance(ents, list) else [])

    for idx, item in enumerate(raw_list, 1):
        if not isinstance(item, dict):
            continue
        is_disabled = (item.get("disable") is True) or (item.get("disabled") is True) or (item.get("enabled") is False)
        if not include_disabled and is_disabled:
            continue
        txt = str(item.get("content") or item.get("text") or "").strip()
        if not txt or (filter_stats and is_noise_entry(txt)):
            continue
        title = str(item.get("comment") or item.get("title") or item.get("name") or f"世界书条目{idx}").strip()
        primary_keys = _parse_keys(item.get("key") if item.get("key") is not None else item.get("keys"))
        secondary_keys = _parse_keys(
            item.get("keysecondary") if item.get("keysecondary") is not None else item.get("secondary_keys")
        )
        keys = list(dict.fromkeys(primary_keys + secondary_keys))
        ext = item.get("extensions") if isinstance(item.get("extensions"), dict) else {}
        entries.append({
            "id": f"WB{idx:03d}",
            "bucket": str(item.get("group") or ext.get("group") or default_book_bucket),
            "title": title,
            "keys": keys,
            "order": item.get("lore_order") if item.get("lore_order") is not None else None,
            "text": txt,
        })
    return entries


def pack_entries_to_scenes(entries, target_chars=3200, max_chars=4600, max_scenes_per_arc=30):
    by_bucket = collections.OrderedDict()
    for ent in entries:
        by_bucket.setdefault(ent["bucket"], []).append(ent)

    packed_arcs = []
    for bucket, items in by_bucket.items():
        scenes = []
        buf = []
        buf_chars = 0

        def flush():
            nonlocal buf, buf_chars
            if not buf:
                return
            blocks = []
            keys_acc = []
            for x in buf:
                key_note = f" · 关键词:{','.join(x['keys'][:5])}" if x["keys"] else ""
                blocks.append(f"【{x['title']}{key_note}】\n{x['text']}")
                keys_acc.extend(x["keys"])
            text = "\n\n---\n\n".join(blocks)
            top_titles = [x["title"] for x in buf]
            scenes.append({
                "title": " / ".join(top_titles[:3])[:26],
                "summary": "；".join(f"{x['title']}：{x['text'][:55].replace(chr(10), ' ')}" for x in buf)[:180],
                "characters": list(dict.fromkeys(keys_acc))[:8],
                "text": text,
                "chars": len(text),
                "order": None,
                "tone_tags": ["设定/档案"],
            })
            buf = []
            buf_chars = 0

        for item in items:
            add_len = len(item["text"]) + len(item["title"]) + 24
            if buf and (buf_chars + add_len > max_chars or buf_chars >= target_chars):
                flush()
            buf.append(item)
            buf_chars += add_len
        flush()

        for part_idx in range(0, len(scenes), max_scenes_per_arc):
            chunk = scenes[part_idx : part_idx + max_scenes_per_arc]
            suffix = f"·卷{part_idx // max_scenes_per_arc + 1}" if len(scenes) > max_scenes_per_arc else ""
            packed_arcs.append({
                "bucket": bucket,
                "title": f"{bucket}{suffix}",
                "scenes": chunk,
            })
    return packed_arcs


def main():
    parser = argparse.ArgumentParser(description="LoreCodex universal worldbook/dossier lore builder")
    parser.add_argument("--input", required=True, help="Worldbook .json, .jsonl, or directory of .md/.txt")
    parser.add_argument("--corpus-id", required=True, help="Corpus ID")
    parser.add_argument("--name", default="", help="Display name (used when creating standalone corpus)")
    parser.add_argument("--out-dir", default="corpora", help="Corpora root dir (if not using --merge-into)")
    parser.add_argument("--category", default="档案设定", help="Category name for lore arcs (default: 档案设定)")
    parser.add_argument("--series", default="设定与技术档案", help="Series name for lore arcs")
    parser.add_argument("--merge-into", default="", help="Existing corpus directory to idempotently merge into")
    parser.add_argument("--filter-game-stats", action="store_true", help="Filter RPG combat stats and promotional noise")
    parser.add_argument("--include-disabled", action="store_true", help="Include disabled worldbook entries")
    parser.add_argument("--no-llm", action="store_true", help="Build deterministically without LLM calls")
    args = parser.parse_args()

    entries = load_lore_entries(
        args.input,
        filter_stats=args.filter_game_stats,
        include_disabled=args.include_disabled,
    )
    if not entries:
        raise RuntimeError(f"No valid lore entries extracted from {args.input}")

    packed = pack_entries_to_scenes(entries)
    target_dir = args.merge_into or os.path.join(args.out_dir, args.corpus_id)
    os.makedirs(target_dir, exist_ok=True)

    index_path = os.path.join(target_dir, "tree_index.json")
    texts_path = os.path.join(target_dir, "tree_texts.json")

    arc_prefix = f"lore_{slugify(args.category)}_"
    existing_arcs = []
    existing_texts = {}
    max_id_num = 0

    if args.merge_into and os.path.exists(index_path) and os.path.exists(texts_path):
        with open(index_path, "r", encoding="utf-8") as f:
            old_idx = json.load(f)
        with open(texts_path, "r", encoding="utf-8") as f:
            old_texts = json.load(f)

        removed_node_ids = set()
        for a in old_idx.get("arcs", []):
            if str(a.get("arc_key", "")).startswith(arc_prefix):
                for s in a.get("scenes", []):
                    removed_node_ids.add(s["node_id"])
            else:
                existing_arcs.append(a)
                if str(a.get("arc_id", "")).isdigit():
                    max_id_num = max(max_id_num, int(a["arc_id"]))
                for s in a.get("scenes", []):
                    if str(s.get("node_id", "")).isdigit():
                        max_id_num = max(max_id_num, int(s["node_id"]))

        for nid, val in old_texts.items():
            if nid not in removed_node_ids:
                existing_texts[nid] = val
    else:
        old_idx = {"version": 2, "source": os.path.basename(os.path.normpath(args.input))}

    node_counter = max_id_num + 1

    def next_nid():
        nonlocal node_counter
        v = f"{node_counter:04d}"
        node_counter += 1
        return v

    new_arcs = []
    for idx, pa in enumerate(packed, 1):
        arc_id = next_nid()
        arc_key = f"{arc_prefix}{idx:03d}"
        leaf_nodes = []
        arc_chars_set = []

        for s_idx, sc in enumerate(pa["scenes"], 1):
            nid = next_nid()
            grp = f"{arc_key}_{s_idx:02d}"
            existing_texts[nid] = {
                "arc_id": arc_id,
                "arc_key": arc_key,
                "arc_title": pa["title"],
                "group": grp,
                "group_title": pa["title"],
                "chars": sc["chars"],
                "text": sc["text"],
            }
            leaf_nodes.append({
                "node_id": nid,
                "group": grp,
                "group_title": pa["title"],
                "scene_ids": [nid],
                "chars": sc["chars"],
                "order": sc["order"],
                "tone_tags": sc["tone_tags"],
                "title": sc["title"],
                "summary": sc["summary"],
            })
            for ch in sc["characters"]:
                if ch not in arc_chars_set:
                    arc_chars_set.append(ch)

        new_arcs.append({
            "arc_id": arc_id,
            "arc_key": arc_key,
            "series": args.series,
            "category": args.category,
            "order": None,
            "title": pa["title"],
            "description": f"收录《{pa['bucket']}》相关世界观、技术设定与背景词条（共 {len(leaf_nodes)} 幕）。",
            "characters": arc_chars_set[:10],
            "tone_tags": ["设定/档案"],
            "groups": [s["group"] for s in leaf_nodes],
            "total_chars": sum(s["chars"] for s in leaf_nodes),
            "scenes": leaf_nodes,
            "key_items": [s["title"] for s in leaf_nodes[:10]],
        })

    all_arcs = existing_arcs + new_arcs
    total_scenes = sum(len(a.get("scenes", [])) for a in all_arcs)
    total_chars = sum(a.get("total_chars", 0) for a in all_arcs)

    out_idx = {
        "version": 2,
        "source": old_idx.get("source") or os.path.basename(os.path.normpath(args.input)),
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stats": {
            "arcs": len(all_arcs),
            "groups": total_scenes,
            "scenes": total_scenes,
            "total_chars": total_chars,
        },
        "arcs": all_arcs,
    }

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(out_idx, f, ensure_ascii=False, indent=2)
    with open(texts_path, "w", encoding="utf-8") as f:
        json.dump(existing_texts, f, ensure_ascii=False)

    corpus_cfg_path = os.path.join(target_dir, "corpus.json")
    if not os.path.exists(corpus_cfg_path):
        disp = args.name or args.corpus_id
        with open(corpus_cfg_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "id": args.corpus_id,
                    "name": disp,
                    "description": f"《{disp}》设定集树索引。",
                    "spoiler_gate": {"enabled": False, "order_label": "章节进度", "default_max_order": None},
                },
                f,
                ensure_ascii=False,
                indent=2,
            )

    print(
        f"[build_lore] DONE: added {len(new_arcs)} lore arcs ({sum(len(a['scenes']) for a in new_arcs)} scenes, {len(entries)} entries) -> {target_dir} (total arcs={len(all_arcs)}, scenes={total_scenes})"
    )


if __name__ == "__main__":
    main()
