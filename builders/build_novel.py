"""
Universal 3-level Tree Builder for Long-Form Fiction / Novels (.txt / .md / .epub / dir).
Produces tree_index.json (v2), tree_texts.json, and corpus.json in <out-dir>/<corpus-id>/.

Zero external dependencies (Python 3.12 standard library only).
"""

import argparse
import collections
import concurrent.futures
import html.parser
import json
import os
import posixpath
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CN_NUM_MAP = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    "百": 100, "千": 1000, "万": 10000,
}

VOL_RE = re.compile(
    r"^(?:#\s+(.+)|"
    r"第[零〇一二三四五六七八九十百千万\d]+[卷部篇册集](?:[\s　:：\-—]+.*)?|"
    r"[卷部][一二三四五六七八九十\d]+(?:[\s　:：\-—]+.*)?|"
    r"(?:Volume|Vol\.?|Book|Part)\s+[IVXLCDM\d]+(?:[:.\-\s]+.*)?)$",
    re.IGNORECASE,
)

CHAP_RE = re.compile(
    r"^(?:##\s+(.+)|"
    r"(?:序章|楔子|引子|终章|尾声|后记|番外[一二三四五六七八九十\d]*)(?:[\s　:：\-—].*)?|"
    r"第[零〇一二三四五六七八九十百千万\d]+[章节回幕](?:[\s　:：\-—]+.*)?|"
    r"(?:Prologue|Epilogue|Interlude|Chapter\s+\d+|Ch\.?\s*\d+)(?:[:.\-\s]+.*)?)$",
    re.IGNORECASE,
)

SCENE_BREAK_RE = re.compile(r"^(?:\*\s*\*\s*\*|-{3,}|={3,}|—{3,}|◆+|◇+|【场景切换】)$")


def read_text_auto(filepath):
    with open(filepath, "rb") as f:
        raw = f.read()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


class _XHTMLTextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self._skip = 0
        self._blocks = []
        self._cur = []
        self._heading_tag = None

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        if t in ("script", "style", "head", "noscript"):
            self._skip += 1
            return
        if self._skip:
            return
        if t in ("h1", "h2", "h3", "h4"):
            self._flush()
            self._heading_tag = t
        elif t in ("p", "div", "li", "blockquote", "section", "article"):
            self._flush()
        elif t == "br":
            self._cur.append("\n")

    def handle_endtag(self, tag):
        t = tag.lower()
        if t in ("script", "style", "head", "noscript"):
            if self._skip > 0:
                self._skip -= 1
            return
        if self._skip:
            return
        if t in ("h1", "h2", "h3", "h4"):
            text = "".join(self._cur).strip()
            self._cur = []
            if text:
                prefix = "# " if t == "h1" else "## "
                self._blocks.append(prefix + text)
            self._heading_tag = None
        elif t in ("p", "div", "li", "blockquote", "section", "article"):
            self._flush()

    def handle_data(self, data):
        if not self._skip:
            self._cur.append(data)

    def _flush(self):
        text = "".join(self._cur).strip()
        self._cur = []
        if text:
            for line in text.splitlines():
                s = line.strip()
                if s:
                    self._blocks.append(s)

    def get_lines(self):
        self._flush()
        return self._blocks


def read_epub_lines(epub_path):
    lines = []
    with zipfile.ZipFile(epub_path, "r") as zf:
        container_xml = zf.read("META-INF/container.xml").decode("utf-8", errors="replace")
        c_root = ET.fromstring(container_xml)
        opf_path = None
        for elem in c_root.iter():
            if elem.tag.endswith("rootfile") and elem.attrib.get("full-path"):
                opf_path = elem.attrib["full-path"]
                break
        if not opf_path:
            raise ValueError("EPUB missing rootfile in container.xml")

        opf_dir = posixpath.dirname(opf_path)
        opf_xml = zf.read(opf_path).decode("utf-8", errors="replace")
        o_root = ET.fromstring(opf_xml)

        manifest = {}
        spine_ids = []
        for elem in o_root.iter():
            tag = elem.tag.split("}")[-1]
            if tag == "item" and elem.attrib.get("id") and elem.attrib.get("href"):
                manifest[elem.attrib["id"]] = elem.attrib["href"]
            elif tag == "itemref" and elem.attrib.get("idref"):
                spine_ids.append(elem.attrib["idref"])

        if not spine_ids:
            spine_ids = list(manifest.keys())

        for sid in spine_ids:
            href = manifest.get(sid)
            if not href:
                continue
            item_path = posixpath.normpath(posixpath.join(opf_dir, href)) if opf_dir else href
            if item_path not in zf.namelist():
                continue
            raw = zf.read(item_path).decode("utf-8", errors="replace")
            parser = _XHTMLTextExtractor()
            parser.feed(raw)
            parser.close()
            extracted = parser.get_lines()
            if extracted:
                lines.extend(extracted)
    return lines


def load_input_lines(input_path):
    if os.path.isdir(input_path):
        files = sorted(
            f for f in os.listdir(input_path)
            if os.path.isfile(os.path.join(input_path, f))
            and f.lower().endswith((".txt", ".md", ".epub"))
        )
        all_lines = []
        for fname in files:
            fpath = os.path.join(input_path, fname)
            stem = os.path.splitext(fname)[0]
            if fname.lower().endswith(".epub"):
                sub = read_epub_lines(fpath)
            else:
                sub = [l.rstrip() for l in read_text_auto(fpath).splitlines()]
            has_chap = any(CHAP_RE.match(l.strip()) for l in sub[:40])
            if not has_chap and sub:
                all_lines.append(f"## {stem}")
            all_lines.extend(sub)
        return all_lines

    if input_path.lower().endswith(".epub"):
        return read_epub_lines(input_path)
    return [l.rstrip() for l in read_text_auto(input_path).splitlines()]


def parse_structure(lines, default_series_name):
    volumes = []
    cur_series = default_series_name
    cur_chapters = []
    cur_title = None
    cur_buf = []

    def flush_chapter():
        nonlocal cur_title, cur_buf
        body_lines = [x for x in cur_buf if x.strip()]
        if body_lines:
            title = cur_title or "序章"
            cur_chapters.append({"series": cur_series, "title": title, "lines": body_lines})
        cur_title = None
        cur_buf = []

    for raw in lines:
        s = raw.strip()
        if not s:
            if cur_buf and cur_buf[-1] != "":
                cur_buf.append("")
            continue

        vm = VOL_RE.match(s)
        if vm and len(s) <= 80:
            flush_chapter()
            cur_series = (vm.group(1) or s).lstrip("#").strip()
            continue

        cm = CHAP_RE.match(s)
        if cm and len(s) <= 100:
            flush_chapter()
            cur_title = (cm.group(1) or s).lstrip("#").strip()
            continue

        cur_buf.append(s)

    flush_chapter()

    # Fallback if text had no chapter markers at all
    if len(cur_chapters) == 1 and sum(len(x) for x in cur_chapters[0]["lines"]) > 16000:
        big_lines = cur_chapters[0]["lines"]
        cur_chapters = []
        chunk_lines, chunk_len, part_idx = [], 0, 1
        for l in big_lines:
            chunk_lines.append(l)
            chunk_len += len(l) + 1
            if chunk_len >= 12000:
                cur_chapters.append({"series": cur_series, "title": f"第{part_idx}节", "lines": chunk_lines})
                chunk_lines, chunk_len = [], 0
                part_idx += 1
        if chunk_lines:
            cur_chapters.append({"series": cur_series, "title": f"第{part_idx}节", "lines": chunk_lines})

    for idx, ch in enumerate(cur_chapters, 1):
        ch["order"] = idx
        volumes.append(ch)
    return volumes


def split_chapter_to_scenes(lines, min_chars=1800, target_chars=3400, max_chars=4800):
    segments = []
    cur_seg = []
    for l in lines:
        s = l.strip()
        if not s:
            continue
        if SCENE_BREAK_RE.match(s):
            if cur_seg:
                segments.append(cur_seg)
                cur_seg = []
        else:
            cur_seg.append(s)
    if cur_seg:
        segments.append(cur_seg)

    scenes = []
    for seg in segments:
        buf, buf_len = [], 0
        for p in seg:
            if len(p) > max_chars:
                if buf:
                    scenes.append("\n".join(buf))
                    buf, buf_len = [], 0
                # Split super-long single paragraph at sentence boundary
                sentences = re.split(r"(?<=[。！？!?\.])\s*", p)
                sbuf, slen = [], 0
                for sent in sentences:
                    if not sent:
                        continue
                    sbuf.append(sent)
                    slen += len(sent)
                    if slen >= target_chars:
                        scenes.append("".join(sbuf))
                        sbuf, slen = [], 0
                if sbuf:
                    scenes.append("".join(sbuf))
                continue

            if buf and (buf_len + len(p) + 1 > max_chars or (buf_len >= target_chars)):
                scenes.append("\n".join(buf))
                buf, buf_len = [], 0
            buf.append(p)
            buf_len += len(p) + 1
            if buf_len >= target_chars:
                scenes.append("\n".join(buf))
                buf, buf_len = [], 0
        if buf:
            txt = "\n".join(buf)
            if scenes and len(txt) < max(700, min_chars // 2) and len(scenes[-1]) + len(txt) <= max_chars + 1000:
                scenes[-1] = scenes[-1] + "\n" + txt
            else:
                scenes.append(txt)
    return [s for s in scenes if s.strip()]


def infer_tones_heuristic(text):
    tags = []
    if re.search(r"战斗|炮火|枪声|激战|爆炸|刀锋|刺杀|敌袭|鲜血|撤离|危机|追杀|防线|截击机|激光", text):
        tags.append("战斗/危机")
    if re.search(r"温暖|笑意|茶馆|热茶|黑麦面包|微风|篝火|拥抱|闲聊|晚饭|安静|微笑|温柔|炉火", text):
        tags.append("温情/日常")
    if re.search(r"心想|想起|愧疚|梦境|孤独|犹豫|沉默|凝视|独白|自语|往事|绝望|平静", text):
        tags.append("心理/独白")
    if re.search(r"真相|密钥|密码|密谋|监视|议会|密令|伪装|调查|线索|清场协议", text):
        tags.append("权谋/悬疑")
    if re.search(r"参数|推进器|重力锚|技术档案|维护协议|编年纪|加速度|型号为", text):
        tags.append("设定/档案")
    if not tags:
        tags.append("叙事/剧情")
    return tags[:3]


def infer_characters_heuristic(text, alias_pool=None):
    counts = collections.Counter()
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9\u4e00-\u9fff·_-]{2,10})[：:]", line.strip())
        if m and m.group(1) not in ("注", "提示", "档案", "时间", "地点"):
            counts[m.group(1)] += 3
    if alias_pool:
        for name in alias_pool:
            c = text.count(name)
            if c > 0:
                counts[name] += c
    return [k for k, _ in counts.most_common(6)]


def heuristic_scene_meta(arc_title, scene_idx, total_in_arc, text, alias_pool=None):
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    first = lines[0][:24] if lines else f"{arc_title} 第{scene_idx}幕"
    title = f"{arc_title}·幕{scene_idx}" if total_in_arc > 1 else arc_title
    if lines and 4 <= len(first) <= 18 and not re.search(r"[，。！？]$", first):
        title = first
    summary_parts = []
    if lines:
        summary_parts.append(lines[0][:90])
    if len(lines) > 2:
        summary_parts.append(lines[len(lines) // 2][:70])
    summary = " ".join(summary_parts)[:160]
    return {
        "title": title,
        "summary": summary,
        "characters": infer_characters_heuristic(text, alias_pool),
        "tone_tags": infer_tones_heuristic(text),
    }


def llm_json(cfg, prompt, max_tokens=280, retries=4):
    url = cfg["chatBase"].rstrip("/") + "/chat/completions"
    disable_thinking = cfg.get("disableThinking", True)
    last_err = None
    for attempt in range(retries):
        payload = {
            "model": cfg["chatModel"],
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "max_tokens": max_tokens,
        }
        if disable_thinking:
            payload["thinking"] = {"type": "disabled"}
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {cfg['chatKey']}",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            txt = data["choices"][0]["message"]["content"]
            usage = data.get("usage", {})
            m = re.search(r"```(?:json)?\s*([\s\S]*?)```", txt)
            raw = m.group(1) if m else txt
            m2 = re.search(r"(\{[\s\S]*\})", raw)
            parsed = json.loads(m2.group(1) if m2 else raw)
            return parsed, usage
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            if e.code == 400 and disable_thinking and re.search(r"thinking|unrecognized|unknown", err_body, re.I):
                disable_thinking = False
                continue
            last_err = f"HTTP {e.code}: {err_body[:150]}"
            time.sleep(1.2 * (attempt + 1))
        except Exception as e:
            last_err = str(e)
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"LLM failed after {retries} attempts: {last_err}")


def main():
    parser = argparse.ArgumentParser(description="LoreCodex universal novel/TXT/MD/EPUB tree builder")
    parser.add_argument("--input", required=True, help="Path to .txt / .md / .epub file or directory")
    parser.add_argument("--corpus-id", required=True, help="Target corpus ID (e.g. my-novel)")
    parser.add_argument("--name", required=True, help="Display name of the work")
    parser.add_argument("--out-dir", default="corpora", help="Corpora root directory (default: corpora)")
    parser.add_argument("--config", default="config.json", help="Config file with chatBase/chatKey/chatModel")
    parser.add_argument("--category", default="正文", help="Default category label (default: 正文)")
    parser.add_argument("--min-chars", type=int, default=1800)
    parser.add_argument("--target-chars", type=int, default=3400)
    parser.add_argument("--max-chars", type=int, default=4800)
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--no-llm", action="store_true", help="Build deterministically without calling LLM API")
    parser.add_argument("--overwrite-config", action="store_true", help="Overwrite existing corpus.json if present")
    args = parser.parse_args()

    out_corpus_dir = os.path.join(args.out_dir, args.corpus_id)
    os.makedirs(out_corpus_dir, exist_ok=True)

    # Load optional existing aliases from corpus.json for heuristic character matching
    alias_pool = []
    corpus_cfg_path = os.path.join(out_corpus_dir, "corpus.json")
    if os.path.exists(corpus_cfg_path):
        try:
            with open(corpus_cfg_path, "r", encoding="utf-8") as f:
                cc = json.load(f)
            for grp in cc.get("aliases", []):
                alias_pool.extend(grp)
        except Exception:
            pass

    lines = load_input_lines(args.input)
    chapters = parse_structure(lines, default_series_name="正文卷")
    if not chapters:
        raise RuntimeError(f"No readable chapters parsed from {args.input}")

    arcs = []
    texts_map = {}
    node_counter = 1

    def next_nid():
        nonlocal node_counter
        v = f"{node_counter:04d}"
        node_counter += 1
        return v

    for ch in chapters:
        arc_id = next_nid()
        raw_scenes = split_chapter_to_scenes(
            ch["lines"],
            min_chars=args.min_chars,
            target_chars=args.target_chars,
            max_chars=args.max_chars,
        )
        leaf_nodes = []
        for idx, sc_text in enumerate(raw_scenes, 1):
            nid = next_nid()
            texts_map[nid] = {
                "arc_id": arc_id,
                "arc_key": f"ch_{ch['order']:04d}",
                "arc_title": ch["title"],
                "group": f"ch_{ch['order']:04d}_{idx:02d}",
                "group_title": ch["title"],
                "chars": len(sc_text),
                "text": sc_text,
            }
            leaf_nodes.append({
                "node_id": nid,
                "group": f"ch_{ch['order']:04d}_{idx:02d}",
                "group_title": ch["title"],
                "scene_ids": [nid],
                "chars": len(sc_text),
                "order": ch["order"],
                "title": "",
                "summary": "",
                "tone_tags": [],
            })

        arcs.append({
            "arc_id": arc_id,
            "arc_key": f"ch_{ch['order']:04d}",
            "series": ch["series"],
            "category": args.category,
            "order": ch["order"],
            "title": ch["title"],
            "description": "",
            "characters": [],
            "tone_tags": [],
            "groups": [s["group"] for s in leaf_nodes],
            "total_chars": sum(s["chars"] for s in leaf_nodes),
            "scenes": leaf_nodes,
            "key_items": [],
        })

    cfg = {}
    if not args.no_llm:
        if not os.path.exists(args.config):
            raise RuntimeError(f"Config file not found: {args.config} (pass --no-llm for offline heuristic build)")
        with open(args.config, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if not cfg.get("chatBase") or not cfg.get("chatKey"):
            raise RuntimeError("chatBase/chatKey missing in config.json (pass --no-llm for offline build)")

    ckpt_path = os.path.join(out_corpus_dir, ".build_novel.ckpt.jsonl")
    ckpt = {}
    if not args.no_llm and os.path.exists(ckpt_path):
        with open(ckpt_path, "r", encoding="utf-8") as f:
            for l in f:
                if l.strip():
                    rec = json.loads(l)
                    ckpt[rec["key"]] = rec
    ckpt_lock = threading.Lock()

    def save_ckpt(rec):
        with ckpt_lock:
            ckpt[rec["key"]] = rec
            with open(ckpt_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    if args.no_llm:
        for a in arcs:
            arc_chars = collections.Counter()
            arc_tones = collections.Counter()
            for idx, sc in enumerate(a["scenes"], 1):
                meta = heuristic_scene_meta(a["title"], idx, len(a["scenes"]), texts_map[sc["node_id"]]["text"], alias_pool)
                sc["title"] = meta["title"]
                sc["summary"] = meta["summary"]
                sc["tone_tags"] = meta["tone_tags"]
                for c in meta["characters"]:
                    arc_chars[c] += 1
                for t in meta["tone_tags"]:
                    arc_tones[t] += 1
            a["characters"] = [k for k, _ in arc_chars.most_common(8)]
            a["tone_tags"] = [k for k, _ in arc_tones.most_common(3)]
            a["description"] = "；".join(s["summary"][:60] for s in a["scenes"][:2])[:140]
            a["key_items"] = [s["title"] for s in a["scenes"][:8] if s["title"]]
    else:
        todo_leaves = []
        for a in arcs:
            for sc in a["scenes"]:
                key = f"leaf:{sc['node_id']}"
                if key in ckpt:
                    sc["title"] = ckpt[key].get("title", "")
                    sc["summary"] = ckpt[key].get("summary", "")
                    sc["tone_tags"] = ckpt[key].get("tone_tags", [])
                    sc["_chars"] = ckpt[key].get("characters", [])
                else:
                    todo_leaves.append((a, sc, key))

        def _run_leaf(item):
            a, sc, key = item
            txt = texts_map[sc["node_id"]]["text"][:5200]
            prompt = (
                f"你是《{args.name}》文本目录索引员。请为下面这段完整场景生成检索索引（注意把人称代词消解为具体人名）：\n"
                "1. title: 6-14字场景标题，概括地点/人物或核心事件；\n"
                "2. summary: 2句话（70-130字），保留人名、专有名词、重要物品、数字和事件转折；\n"
                "3. characters: 本幕直接出场或被明确提及的关键人物数组（最多6人）；\n"
                "4. tone_tags: 从 [战斗/危机, 温情/日常, 心理/独白, 权谋/悬疑, 设定/档案, 叙事/剧情] 中选 1-2 个标签。\n"
                "只输出严格 JSON：{\"title\":\"...\",\"summary\":\"...\",\"characters\":[],\"tone_tags\":[]}\n\n"
                f"所属篇章：{a['series']} / {a['title']}\n正文：\n{txt}"
            )
            parsed, _ = llm_json(cfg, prompt, max_tokens=300)
            rec = {
                "key": key,
                "title": str(parsed.get("title", "")).strip() or f"{a['title']}·片段",
                "summary": str(parsed.get("summary", "")).strip(),
                "characters": list(parsed.get("characters", []))[:6],
                "tone_tags": list(parsed.get("tone_tags", []))[:2] or ["叙事/剧情"],
            }
            save_ckpt(rec)
            return sc, rec

        if todo_leaves:
            print(f"[build_novel] summarizing {len(todo_leaves)} scenes with LLM...")
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
                futs = [ex.submit(_run_leaf, it) for it in todo_leaves]
                for fut in concurrent.futures.as_completed(futs):
                    sc, rec = fut.result()
                    sc["title"] = rec["title"]
                    sc["summary"] = rec["summary"]
                    sc["tone_tags"] = rec["tone_tags"]
                    sc["_chars"] = rec["characters"]

        todo_arcs = []
        for a in arcs:
            key = f"arc:{a['arc_id']}"
            if key in ckpt:
                a["description"] = ckpt[key].get("description", "")
                a["characters"] = ckpt[key].get("characters", [])
                a["tone_tags"] = ckpt[key].get("tone_tags", [])
                a["key_items"] = ckpt[key].get("key_items", [])
            else:
                todo_arcs.append((a, key))

        def _run_arc(item):
            a, key = item
            sc_lines = "\n".join(f"- [{s['node_id']}] {s['title']}: {s['summary']}" for s in a["scenes"][:25])
            prompt = (
                f"根据《{args.name}》篇章的子场景摘要提炼篇章总目信息：\n"
                "1. description: 1-2句话（50-100字）概括全章核心人物与事件；\n"
                "2. characters: 核心出场人物数组（最多8人）；\n"
                "3. tone_tags: 1-2个氛围标签。\n"
                "只输出 JSON：{\"description\":\"...\",\"characters\":[],\"tone_tags\":[]}\n\n"
                f"篇章：{a['series']} / {a['title']}\n子场景：\n{sc_lines}"
            )
            parsed, _ = llm_json(cfg, prompt, max_tokens=280)
            rec = {
                "key": key,
                "description": str(parsed.get("description", "")).strip(),
                "characters": list(parsed.get("characters", []))[:8],
                "tone_tags": list(parsed.get("tone_tags", []))[:2] or ["叙事/剧情"],
                "key_items": [s["title"] for s in a["scenes"][:8] if s.get("title")],
            }
            save_ckpt(rec)
            return a, rec

        if todo_arcs:
            print(f"[build_novel] summarizing {len(todo_arcs)} arcs with LLM...")
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
                futs = [ex.submit(_run_arc, it) for it in todo_arcs]
                for fut in concurrent.futures.as_completed(futs):
                    a, rec = fut.result()
                    a["description"] = rec["description"]
                    a["characters"] = rec["characters"]
                    a["tone_tags"] = rec["tone_tags"]
                    a["key_items"] = rec["key_items"]

        for a in arcs:
            for sc in a["scenes"]:
                sc.pop("_chars", None)

    total_scenes = sum(len(a["scenes"]) for a in arcs)
    total_chars = sum(a["total_chars"] for a in arcs)
    index_doc = {
        "version": 2,
        "source": os.path.basename(os.path.normpath(args.input)),
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stats": {
            "arcs": len(arcs),
            "groups": total_scenes,
            "scenes": total_scenes,
            "total_chars": total_chars,
        },
        "arcs": arcs,
    }

    with open(os.path.join(out_corpus_dir, "tree_index.json"), "w", encoding="utf-8") as f:
        json.dump(index_doc, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_corpus_dir, "tree_texts.json"), "w", encoding="utf-8") as f:
        json.dump(texts_map, f, ensure_ascii=False)

    if args.overwrite_config or not os.path.exists(corpus_cfg_path):
        corpus_cfg = {
            "id": args.corpus_id,
            "name": args.name,
            "description": f"《{args.name}》长文本典籍树（共 {len(arcs)} 卷 / {total_scenes} 幕 / {total_chars:,} 字）。",
            "language": "zh-CN",
            "world_premise": f"当前语料库收录了《{args.name}》的章节正文与相关背景资料。请严格基于已核实的章节原文提供角色扮演回忆或设定解答。",
            "aliases": [],
            "glossary": [],
            "spoiler_gate": {
                "enabled": True,
                "order_label": "章节进度",
                "default_max_order": None,
            },
            "hierarchy": {"auto_series_threshold": 250},
            "prompt_framing": {
                "xml_tag": "lore_source_reference",
                "header": f"以下为《{args.name}》典籍中检索并核实的原文片段与设定。请将其作为既有经历或背景常识自然融入扮演，不要机械复读。",
                "priority_rule": "【事实优先级】若原作片段细节与本局当前设定或新发展存在冲突，一律以本局当前时间线为准。",
                "follow_up_hint": "如需继续追查其他细节，可在回复末尾附带【查原文：具体问题或人物事件】。",
            },
            "ui": {
                "subtitle": f"{args.name} · 典籍与树检索工作台",
                "default_char": "",
                "default_user": "用户",
                "presets": [],
            },
        }
        with open(corpus_cfg_path, "w", encoding="utf-8") as f:
            json.dump(corpus_cfg, f, ensure_ascii=False, indent=2)

    print(
        f"[build_novel] DONE corpus={args.corpus_id}: arcs={len(arcs)}, scenes={total_scenes}, chars={total_chars} -> {out_corpus_dir}"
    )


if __name__ == "__main__":
    main()
