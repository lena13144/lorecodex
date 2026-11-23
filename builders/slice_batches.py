#!/usr/bin/env python3
"""
LoreCodex batch slicer for Cloud AI / Agent builds (zero dependencies).

Sits between the offline split (build_novel.py --no-llm) and the summaries an agent
writes itself. tree_texts.json holds every scene of the book in one JSON file (tens of
MB for a long novel), which most agents cannot read in one go. This script cuts it into
numbered Markdown batches of bounded size, plus a manifest that records progress on disk,
so an agent reads one batch at a time and a new session can resume where the last stopped.

Usage:
  python3 builders/slice_batches.py --corpus-dir ./out/<slug> --batch-chars 40000
  python3 builders/slice_batches.py --corpus-dir ./out/<slug> --status
  python3 builders/slice_batches.py --corpus-dir ./out/<slug> --digest-series "第一卷"

Output (in <corpus-dir>/batches/):
  batch_001.md ...      scene texts, each under a "## [node_id=XXXX]" heading
  manifest.json         batch -> node_ids / arcs / series / chars / status

pack_lorepack.py --apply-meta updates the manifest: a batch becomes "done" once every
node_id in it has a summary in tree_index.json.
"""

import argparse
import json
import os
import sys

MANIFEST_NAME = "manifest.json"


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def scene_text(texts, nid):
    rec = texts.get(nid)
    if isinstance(rec, dict):
        return str(rec.get("text") or "")
    return str(rec or "")


def iter_scenes(index_data):
    """Yield (arc, scene, is_last_scene_of_arc) in reading order."""
    for arc in index_data.get("arcs") or []:
        scenes = arc.get("scenes") or []
        for i, sc in enumerate(scenes):
            yield arc, sc, i == len(scenes) - 1


def scene_done(sc):
    return bool(sc.get("_llm_done")) and bool(str(sc.get("summary") or "").strip())


def refresh_manifest_status(manifest, index_data):
    """Mark batches done/partial/pending from the summaries already applied to tree_index.json."""
    done_ids = {str(sc.get("node_id")) for _, sc, _ in iter_scenes(index_data) if scene_done(sc)}
    for b in manifest.get("batches") or []:
        ids = b.get("node_ids") or []
        hit = sum(1 for n in ids if n in done_ids)
        b["done_scenes"] = hit
        b["status"] = "done" if ids and hit == len(ids) else ("partial" if hit else "pending")
    batches = manifest.get("batches") or []
    manifest["done_batches"] = sum(1 for b in batches if b["status"] == "done")
    nxt = next((b for b in batches if b["status"] != "done"), None)
    manifest["next_batch"] = nxt["id"] if nxt else None
    return manifest


def build_batches(index_data, texts, batch_chars):
    batches = []
    cur = None

    def flush():
        if cur and cur["node_ids"]:
            batches.append(cur)

    arc_scene_count = {}
    for arc, _sc, _last in iter_scenes(index_data):
        aid = str(arc.get("arc_id"))
        arc_scene_count[aid] = arc_scene_count.get(aid, 0) + 1

    series_last_scene = {}
    for arc, sc, _last in iter_scenes(index_data):
        series_last_scene[str(arc.get("series") or "")] = str(sc.get("node_id"))

    for arc, sc, is_last in iter_scenes(index_data):
        nid = str(sc.get("node_id"))
        txt = scene_text(texts, nid)
        n = len(txt)
        # Start a new batch when this scene would overflow it (a single oversized scene still gets its own batch).
        if cur is None or (cur["chars"] and cur["chars"] + n > batch_chars):
            flush()
            cur = {"node_ids": [], "chars": 0, "arcs_complete": [], "multi_scene_arcs_complete": [], "series_complete": [], "_parts": []}
        aid = str(arc.get("arc_id"))
        series = str(arc.get("series") or "")
        cur["node_ids"].append(nid)
        cur["chars"] += n
        cur["_parts"].append((arc, sc, txt))
        if is_last:
            cur["arcs_complete"].append(aid)
            if arc_scene_count.get(aid, 0) > 1:
                cur["multi_scene_arcs_complete"].append(aid)
        if series and series_last_scene.get(series) == nid:
            cur["series_complete"].append(series)
    flush()
    return batches


def render_batch_md(corpus_name, bid, total, batch):
    lines = [
        f"# {corpus_name} · {bid} / {total:03d}",
        "",
        f"本批 {len(batch['node_ids'])} 幕，{batch['chars']} 字。写 `meta_{bid[6:]}.json` 时 `scene_summaries` 的键必须且只能是下面这些 node_id：",
        "",
        ", ".join(batch["node_ids"]),
        "",
    ]
    if batch["multi_scene_arcs_complete"]:
        lines += [f"本批结束的多幕篇章（需写 `arc_summaries`）：{', '.join(batch['multi_scene_arcs_complete'])}", ""]
    if batch["series_complete"]:
        lines += [
            f"本批结束的分卷（需写 `series_summaries`，先运行 `slice_batches.py --digest-series \"<卷名>\"` 看全卷已写摘要）：{'、'.join(batch['series_complete'])}",
            "",
        ]
    lines.append("---")
    prev_arc = None
    for arc, sc, txt in batch["_parts"]:
        aid = str(arc.get("arc_id"))
        if aid != prev_arc:
            n_sc = len(arc.get("scenes") or [])
            series = str(arc.get("series") or "")
            lines += ["", f"# 篇章 [arc_id={aid}] {series + ' › ' if series else ''}{arc.get('title') or ''}（共 {n_sc} 幕）"]
            prev_arc = aid
        title = str(sc.get("title") or sc.get("group_title") or "").strip()
        lines += ["", f"## [node_id={sc.get('node_id')}] {title}（{len(txt)} 字）", "", txt.strip()]
    lines.append("")
    return "\n".join(lines)


def cmd_slice(cdir, index_data, texts, batch_chars, force):
    bdir = os.path.join(cdir, "batches")
    mpath = os.path.join(bdir, MANIFEST_NAME)
    if os.path.exists(mpath) and not force:
        manifest = refresh_manifest_status(load_json(mpath), index_data)
        save_json(mpath, manifest)
        print(f"[slice_batches] manifest exists, kept as is (pass --force to re-slice): {mpath}")
        print_status(manifest)
        return
    os.makedirs(bdir, exist_ok=True)
    for f in os.listdir(bdir):
        if f.startswith("batch_") and f.endswith(".md"):
            os.remove(os.path.join(bdir, f))

    corpus_cfg = load_json(os.path.join(cdir, "corpus.json"), default={}) or {}
    corpus_name = str(corpus_cfg.get("name") or index_data.get("corpus_name") or os.path.basename(cdir))
    batches = build_batches(index_data, texts, batch_chars)
    total = len(batches)
    out = []
    for i, b in enumerate(batches, 1):
        bid = f"batch_{i:03d}"
        fname = f"{bid}.md"
        with open(os.path.join(bdir, fname), "w", encoding="utf-8") as f:
            f.write(render_batch_md(corpus_name, bid, total, b))
        out.append({
            "id": bid,
            "file": fname,
            "meta_file": f"meta_{i:03d}.json",
            "node_ids": b["node_ids"],
            "arcs_complete": b["arcs_complete"],
            "multi_scene_arcs_complete": b["multi_scene_arcs_complete"],
            "series_complete": b["series_complete"],
            "chars": b["chars"],
            "status": "pending",
        })
    manifest = {
        "corpus_dir": os.path.basename(cdir),
        "batch_chars": batch_chars,
        "total_batches": total,
        "total_scenes": sum(len(b["node_ids"]) for b in out),
        "batches": out,
    }
    manifest = refresh_manifest_status(manifest, index_data)
    save_json(mpath, manifest)
    sizes = [b["chars"] for b in out] or [0]
    print(f"[slice_batches] wrote {total} batches to {bdir} (chars per batch: max={max(sizes)}, median={sorted(sizes)[len(sizes) // 2]})")
    print_status(manifest)


def print_status(manifest):
    total = manifest.get("total_batches", 0)
    done = manifest.get("done_batches", 0)
    nxt = manifest.get("next_batch")
    print(f"[slice_batches] progress: {done}/{total} batches done" + (f", next: {nxt}" if nxt else ", all done"))
    partial = [b["id"] for b in manifest.get("batches") or [] if b.get("status") == "partial"]
    if partial:
        print(f"[slice_batches] partial (some node_ids missing a summary): {', '.join(partial[:10])}")


def cmd_digest(index_data, series):
    hit = False
    for arc in index_data.get("arcs") or []:
        if str(arc.get("series") or "") != series:
            continue
        hit = True
        print(f"# [arc_id={arc.get('arc_id')}] {arc.get('title') or ''}")
        for sc in arc.get("scenes") or []:
            mark = "" if scene_done(sc) else "（未写摘要）"
            print(f"- [{sc.get('node_id')}] {str(sc.get('summary') or '').strip()}{mark}")
    if not hit:
        avail = sorted({str(a.get("series") or "") for a in index_data.get("arcs") or []})
        print(f"[slice_batches] no such series: {series!r}. Available: {avail}", file=sys.stderr)
        sys.exit(2)


def main():
    parser = argparse.ArgumentParser(description="Slice a split LoreCodex corpus into bounded batches for agent summarization.")
    parser.add_argument("--corpus-dir", required=True, help="Corpus directory containing tree_index.json & tree_texts.json")
    parser.add_argument("--batch-chars", type=int, default=40000, help="Max source characters per batch (default 40000)")
    parser.add_argument("--force", action="store_true", help="Re-slice even if batches/manifest.json already exists")
    parser.add_argument("--status", action="store_true", help="Refresh and print progress from tree_index.json, then exit")
    parser.add_argument("--digest-series", default="", help="Print the summaries already written for one series (for series_summaries)")
    args = parser.parse_args()

    cdir = os.path.abspath(args.corpus_dir)
    index_data = load_json(os.path.join(cdir, "tree_index.json"))
    if not isinstance(index_data, dict):
        print(f"[slice_batches] ERROR: missing tree_index.json in {cdir}", file=sys.stderr)
        sys.exit(2)

    if args.digest_series:
        cmd_digest(index_data, args.digest_series)
        return
    if args.status:
        mpath = os.path.join(cdir, "batches", MANIFEST_NAME)
        manifest = load_json(mpath)
        if not manifest:
            print(f"[slice_batches] ERROR: {mpath} not found; run without --status first", file=sys.stderr)
            sys.exit(2)
        manifest = refresh_manifest_status(manifest, index_data)
        save_json(mpath, manifest)
        print_status(manifest)
        return

    texts = load_json(os.path.join(cdir, "tree_texts.json"))
    if not isinstance(texts, dict):
        print(f"[slice_batches] ERROR: missing tree_texts.json in {cdir}", file=sys.stderr)
        sys.exit(2)
    if args.batch_chars < 2000:
        print("[slice_batches] ERROR: --batch-chars must be >= 2000", file=sys.stderr)
        sys.exit(2)
    cmd_slice(cdir, index_data, texts, args.batch_chars, args.force)


if __name__ == "__main__":
    main()
