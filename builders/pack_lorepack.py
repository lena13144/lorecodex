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
                arc["summary"] = val.strip()
                arc_hits += 1
            elif isinstance(val, dict):
                if str(val.get("summary") or "").strip():
                    arc["summary"] = str(val["summary"]).strip()
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

        if all_done and scenes:
            arc["_llm_done"] = True
            if not str(arc.get("summary") or "").strip():
                arc["summary"] = str(scenes[0].get("summary") or "").strip()

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

    if isinstance(glossary_updates, dict) and glossary_updates:
        gl = dict(corpus_cfg.get("glossary") or index_data.get("glossary") or {})
        for k, v in glossary_updates.items():
            ks = str(k).strip()
            vs = str(v).strip()
            if ks and vs:
                gl[ks] = vs
        corpus_cfg["glossary"] = gl
        index_data["glossary"] = gl

    return scene_hits, arc_hits


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
            txt = texts_data.get(nid)
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
    for mp in args.apply_meta:
        sh, ah = apply_meta_file(index_data, corpus_cfg, mp)
        total_scene_hits += sh
        total_arc_hits += ah
        print(f"[pack_lorepack] applied {mp}: scenes={sh}, arcs={ah}")

    summary = recompute_stats(index_data, texts_data)

    if args.apply_meta:
        save_json(idx_path, index_data, compact=False)
        save_json(cfg_path, corpus_cfg, compact=False)

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
