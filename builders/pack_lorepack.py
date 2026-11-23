#!/usr/bin/env python3
"""
LoreCodex Standalone Packager & Agent Metadata Applier (Zero Dependencies)

Designed for Cloud AI Agents (Gemini App Task, Muse, Grok, Qoder, WorkBuddy, Claude Code)
and CLI power users to:
  1. Apply LLM-synthesized scene summaries, arc summaries, series summaries, character
     aliases, and glossary terms into an offline-split corpus directory safely.
  2. Validate corpus integrity (scene ID alignment, LLM TOC coverage, JSON structure).
  3. Export a single self-contained `<corpus_id>.lorepack.json` file ready for 1-second
     import into SillyTavern / TauriTavern (mobile or desktop) or LoreCodex Workbench.

Usage:
  python3 builders/pack_lorepack.py --corpus-dir ./out/my-book --out my-book.lorepack.json
  python3 builders/pack_lorepack.py --corpus-dir ./out/my-book --apply-meta meta1.json --apply-meta meta2.json --out my-book.lorepack.json
"""

import argparse
import datetime
import json
import os
import sys


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, obj, compact=False):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2)


def merge_alias_groups(existing, incoming):
    groups = []
    for g in (existing or []):
        if isinstance(g, list):
            cleaned = [str(x).strip() for x in g if str(x).strip()]
            if len(cleaned) >= 2:
                groups.append(list(dict.fromkeys(cleaned)))
    for g in (incoming or []):
        if not isinstance(g, list):
            continue
        cleaned = [str(x).strip() for x in g if str(x).strip()]
        if len(cleaned) < 2:
            continue
        cset = set(cleaned)
        merged = False
        for idx, eg in enumerate(groups):
            if cset.intersection(eg):
                groups[idx] = list(dict.fromkeys(eg + cleaned))
                merged = True
                break
        if not merged:
            groups.append(list(dict.fromkeys(cleaned)))
    return groups


def glossary_to_list(val):
    """Normalize glossary to the runtime format: a list of "术语：释义" strings.

    Accepts the list format and the {"术语": "释义"} object format (older SOP); the
    runtime (prompt_builder / browser_engine) drops anything that is not a list.
    """
    if isinstance(val, dict):
        items = []
        for k, v in val.items():
            ks, vs = str(k).strip(), str(v).strip()
            if ks and vs:
                items.append(f"{ks}：{vs}")
            elif ks:
                items.append(ks)
        return items
    if isinstance(val, list):
        return [str(x).strip() for x in val if str(x).strip()]
    return []


def _glossary_head(item):
    for sep in ("：", ":"):
        if sep in item:
            h = item.split(sep, 1)[0].strip().lstrip("- ").lower()
            if h:
                return h
    return item.strip().lstrip("- ").lower()


def merge_glossary(existing, incoming, max_items=80):
    """Merge by term head (the text before "："); a longer definition replaces a shorter one."""
    out, head_idx = [], {}
    for item in glossary_to_list(existing) + glossary_to_list(incoming):
        if len(item) > 240:
            continue
        h = _glossary_head(item)
        if h in head_idx:
            if len(item) > len(out[head_idx[h]]):
                out[head_idx[h]] = item
            continue
        head_idx[h] = len(out)
        out.append(item)
    return out[:max_items]


def scene_text(texts_data, nid):
    """tree_texts.json values are {"text": ..., ...} records (older builds stored plain strings)."""
    rec = texts_data.get(nid)
    if isinstance(rec, dict):
        return rec.get("text")
    return rec


def apply_meta_file(index_data, corpus_cfg, meta_path):
    meta = load_json(meta_path)
    if not isinstance(meta, dict):
        raise ValueError(f"Meta file must be a JSON object: {meta_path}")

    scene_updates = meta.get("scene_summaries") or meta.get("scenes") or {}
    arc_updates = meta.get("arc_summaries") or meta.get("arcs") or {}
    series_updates = meta.get("series_summaries") or {}
    alias_updates = meta.get("aliases") or []
    glossary_updates = meta.get("glossary") or {}

    scene_hits = 0
    arc_hits = 0

    for arc in index_data.get("arcs") or []:
        aid = str(arc.get("arc_id") or "")
        if aid and aid in arc_updates:
            val = arc_updates[aid]
            if isinstance(val, str) and val.strip():
                arc["description"] = val.strip()
                arc_hits += 1
            elif isinstance(val, dict):
                desc = str(val.get("summary") or val.get("description") or "").strip()
                if desc:
                    arc["description"] = desc
                if isinstance(val.get("characters"), list):
                    arc["characters"] = [str(x).strip() for x in val["characters"] if str(x).strip()]
                arc_hits += 1

        scenes = arc.get("scenes") or []
        all_done = bool(scenes)
        for sc in scenes:
            nid = str(sc.get("node_id") or "")
            if nid and nid in scene_updates:
                val = scene_updates[nid]
                if isinstance(val, str) and val.strip():
                    sc["summary"] = val.strip()
                    sc["_llm_done"] = True
                    scene_hits += 1
                elif isinstance(val, dict):
                    if str(val.get("summary") or "").strip():
                        sc["summary"] = str(val["summary"]).strip()
                        sc["_llm_done"] = True
                    if isinstance(val.get("characters"), list):
                        sc["characters"] = [str(x).strip() for x in val["characters"] if str(x).strip()]
                    if isinstance(val.get("keywords"), list):
                        sc["keywords"] = [str(x).strip() for x in val["keywords"] if str(x).strip()]
                    scene_hits += 1
            if not sc.get("_llm_done"):
                all_done = False

        scene_chars = []
        for sc in scenes:
            for c in sc.get("characters") or []:
                if c not in scene_chars:
                    scene_chars.append(c)
        if scene_chars and not (isinstance(arc_updates.get(aid), dict) and arc_updates[aid].get("characters")):
            arc["characters"] = list(dict.fromkeys(scene_chars + list(arc.get("characters") or [])))[:8]

        if all_done and scenes:
            arc["_llm_done"] = True
            # Single-scene arcs: the scene summary is the arc description (same as build_novel.py --upgrade).
            if len(scenes) == 1 and aid not in arc_updates:
                arc["description"] = str(scenes[0].get("summary") or "").strip() or arc.get("description", "")
                if scenes[0].get("characters"):
                    arc["characters"] = list(scenes[0]["characters"])[:8]

    if isinstance(series_updates, dict) and series_updates:
        ss = index_data.setdefault("series_summaries", {})
        for k, v in series_updates.items():
            ks = str(k).strip()
            vs = str(v).strip()
            if ks and vs:
                ss[ks] = vs

    if alias_updates:
        merged_aliases = merge_alias_groups(
            corpus_cfg.get("aliases") or index_data.get("aliases") or [],
            alias_updates,
        )
        corpus_cfg["aliases"] = merged_aliases
        index_data["aliases"] = merged_aliases

    if glossary_to_list(glossary_updates):
        gl = merge_glossary(corpus_cfg.get("glossary") or index_data.get("glossary") or [], glossary_updates)
        corpus_cfg["glossary"] = gl
        index_data["glossary"] = gl

    known_scenes = {str(sc.get("node_id")) for a in index_data.get("arcs") or [] for sc in a.get("scenes") or []}
    known_arcs = {str(a.get("arc_id")) for a in index_data.get("arcs") or []}
    unknown_scenes = [k for k in scene_updates if str(k) not in known_scenes]
    unknown_arcs = [k for k in arc_updates if str(k) not in known_arcs]
    return scene_hits, arc_hits, unknown_scenes, unknown_arcs


def recompute_stats(index_data, texts_data):
    arcs = index_data.get("arcs") or []
    total_scenes = 0
    llm_scenes = 0
    llm_arcs = 0
    total_chars = 0
    max_order = 0
    missing_texts = []

    for arc in arcs:
        ord_val = arc.get("order")
        if isinstance(ord_val, (int, float)) and ord_val > max_order:
            max_order = int(ord_val)
        scenes = arc.get("scenes") or []
        arc_done = bool(scenes)
        for sc in scenes:
            total_scenes += 1
            nid = str(sc.get("node_id") or "")
            txt = scene_text(texts_data, nid)
            if txt is None:
                missing_texts.append(nid)
                chars = int(sc.get("chars") or 0)
            else:
                chars = len(txt)
                sc["chars"] = chars
            total_chars += chars
            if sc.get("_llm_done") and str(sc.get("summary") or "").strip():
                llm_scenes += 1
            else:
                arc_done = False
        if arc_done and scenes:
            arc["_llm_done"] = True
            llm_arcs += 1

    stats = index_data.setdefault("stats", {})
    stats["arcs"] = len(arcs)
    stats["scenes"] = total_scenes
    stats["llm_arcs"] = llm_arcs
    stats["llm_scenes"] = llm_scenes
    stats["total_chars"] = total_chars
    if max_order > 0:
        stats["max_order"] = max_order

    return {
        "arcs": len(arcs),
        "scenes": total_scenes,
        "llm_arcs": llm_arcs,
        "llm_scenes": llm_scenes,
        "total_chars": total_chars,
        "missing_texts": missing_texts,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Apply Agent-synthesized metadata and package a LoreCodex corpus into a single .lorepack.json file."
    )
    parser.add_argument("--corpus-dir", required=True, help="Path to corpus directory containing tree_index.json & tree_texts.json")
    parser.add_argument(
        "--apply-meta",
        action="append",
        default=[],
        help="Optional JSON file(s) containing scene_summaries, arc_summaries, series_summaries, aliases, glossary (repeatable)",
    )
    parser.add_argument("--out", default="", help="Output .lorepack.json path (default: <corpus_id>.lorepack.json)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print output JSON instead of compact single-line JSON")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero if any scene node_id is missing from tree_texts.json")
    args = parser.parse_args()

    cdir = os.path.abspath(args.corpus_dir)
    idx_path = os.path.join(cdir, "tree_index.json")
    txt_path = os.path.join(cdir, "tree_texts.json")
    cfg_path = os.path.join(cdir, "corpus.json")
    graph_path = os.path.join(cdir, "graph.json")

    if not os.path.exists(idx_path) or not os.path.exists(txt_path):
        print(f"[pack_lorepack] ERROR: missing tree_index.json or tree_texts.json in {cdir}", file=sys.stderr)
        sys.exit(2)

    index_data = load_json(idx_path)
    texts_data = load_json(txt_path)
    corpus_cfg = load_json(cfg_path, default={}) or {}
    graph_data = load_json(graph_path, default=[])
    if not isinstance(graph_data, list):
        graph_data = []

    cid = str(corpus_cfg.get("id") or index_data.get("corpus_id") or os.path.basename(cdir)).strip()
    cname = str(corpus_cfg.get("name") or index_data.get("corpus_name") or cid).strip()
    corpus_cfg.setdefault("id", cid)
    corpus_cfg.setdefault("name", cname)
    index_data.setdefault("corpus_id", cid)
    index_data.setdefault("corpus_name", cname)

    total_scene_hits = 0
    total_arc_hits = 0
    unknown_total = 0
    for mp in args.apply_meta:
        sh, ah, bad_sc, bad_arc = apply_meta_file(index_data, corpus_cfg, mp)
        total_scene_hits += sh
        total_arc_hits += ah
        print(f"[pack_lorepack] applied {mp}: scenes={sh}, arcs={ah}")
        if bad_sc or bad_arc:
            unknown_total += len(bad_sc) + len(bad_arc)
            print(
                f"[pack_lorepack] WARN: {mp} has ids not in tree_index.json (ignored): "
                f"node_ids={bad_sc[:8]} arc_ids={bad_arc[:8]}",
                file=sys.stderr,
            )

    summary = recompute_stats(index_data, texts_data)

    if args.apply_meta:
        save_json(idx_path, index_data, compact=False)
        save_json(cfg_path, corpus_cfg, compact=False)
        manifest_path = os.path.join(cdir, "batches", "manifest.json")
        if os.path.exists(manifest_path):
            # Keep slice_batches.py progress in sync with the summaries just applied.
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from slice_batches import refresh_manifest_status, print_status

            manifest = refresh_manifest_status(load_json(manifest_path), index_data)
            save_json(manifest_path, manifest)
            print_status(manifest)
        if unknown_total and args.strict:
            sys.exit(4)

    if summary["missing_texts"]:
        msg = f"[pack_lorepack] WARN: {len(summary['missing_texts'])} scene(s) missing in tree_texts.json: {summary['missing_texts'][:5]}"
        print(msg, file=sys.stderr)
        if args.strict:
            sys.exit(3)

    out_path = os.path.abspath(args.out) if args.out else os.path.abspath(f"{cid}.lorepack.json")
    pack = {
        "format": "lorecodex-pack-v2",
        "id": cid,
        "corpus_id": cid,
        "corpus_name": cname,
        "config": corpus_cfg,
        "indexData": index_data,
        "textsData": texts_data,
        "graphData": graph_data,
        "exportedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    save_json(out_path, pack, compact=(not args.pretty))
    size_kb = os.path.getsize(out_path) / 1024.0
    cov = (summary["llm_scenes"] / summary["scenes"] * 100.0) if summary["scenes"] else 0.0
    print(
        f"[pack_lorepack] DONE: {out_path} ({size_kb:.1f} KB) | "
        f"arcs={summary['arcs']}, scenes={summary['scenes']}, "
        f"llm_toc={summary['llm_scenes']}/{summary['scenes']} ({cov:.1f}%), "
        f"aliases={len(corpus_cfg.get('aliases') or [])}, "
        f"glossary={len(corpus_cfg.get('glossary') or {})}"
    )


if __name__ == "__main__":
    main()
