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
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

CN_NUM_MAP = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    "百": 100, "千": 1000, "万": 10000,
}

VOL_RE = re.compile(
    r"^(?:#\s+(.+)|"
    r"第([零〇一二三四五六七八九十百千万两\d]+)[卷部篇册集](?:[\s　:：\-—\.、,，]+.*)?|"
    r"[卷部]([零〇一二三四五六七八九十两\d]+)(?:[\s　:：\-—\.、]+.*)?|"
    r"(?:Volume|Vol\.?|Book|Part)\s+([IVXLCDM\d]+)(?:[:.\-\s]+.*)?)$",
    re.IGNORECASE,
)

VOL_TEASER_EXCLUDE_RE = re.compile(r"敬请期待|·完$|完结|求订阅|求月票|求推荐|感谢大家|新书|感言|音乐|曲目|攫欝")

CHAP_RE = re.compile(
    r"^(?:##\s+(.+)|"
    r"(?:【\s*)?(?:正文[\s　]*)?第([零〇一二三四五六七八九十百千万两\d]+)[章节回幕话](?:\s*】)?(?:[\s　:：\-—\.、]*[^\n]*)?|"
    r"(?:序章|楔子|引子|终章|尾声|后记|外传|间章|幕间|番外)(?:[零〇一二三四五六七八九十两\d]*)(?:[\s　:：·•、\-—].*)?|"
    r"(?:Prologue|Epilogue|Interlude|Intermission|Chapter\s+(\d+)|Ch\.?\s*(\d+))(?:[:.\-\s]+.*)?)$",
    re.IGNORECASE,
)

FAKE_CHAP_NOTE_RE = re.compile(r"，[^，\n]*(?:用的是|唱的是|取自|这个是|歌单|片尾曲|插曲|主题曲|歌词)")

AD_LINE_RE = re.compile(
    r"爱下电子书|ixdzs|笔趣阁|妙笔坊|爱阅小说|恋上你看书|请退出转码页面|"
    r"网页版章节内容慢|为你提供最快的.*更新|免费阅读[。.]?\s*https?://|"
    r"^-{4,}\s*章节内容开始\s*-{4,}$|^『还在连载中|更多电子书请访问"
)

SCENE_BREAK_RE = re.compile(r"^(?:\*\s*\*\s*\*|-{3,}|={3,}|—{3,}|◆+|◇+|【场景切换】)$")


def parse_cn_or_int(raw):
    s = str(raw or "").strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    roman = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8, "IX": 9, "X": 10}
    if s.upper() in roman:
        return roman[s.upper()]
    total = 0
    section = 0
    num = 0
    seen = False
    for ch in s:
        if ch not in CN_NUM_MAP:
            return None
        seen = True
        val = CN_NUM_MAP[ch]
        if val < 10:
            num = val
        elif val == 10000:
            section = (section + num) if (section + num) > 0 else 1
            total += section * 10000
            section = 0
            num = 0
        else:
            if num == 0 and val == 10 and section == 0 and total == 0:
                num = 1
            elif num == 0:
                num = 1
            section += num * val
            num = 0
    return (total + section + num) if seen else None


def clean_inline_noise(line):
    s = re.sub(r"巘戅[^巘\n]{1,16}巘戅[。.]?", "", line)
    s = re.sub(r"攫欝(?:攫欝)?", "", s)
    s = re.sub(r"(?:&#\d{2,5};?){3,}", "", s)
    return s.strip()


def clean_input_lines(lines, book_name="", clean_ads=True):
    if not clean_ads:
        return lines
    out = []
    in_header_banner = False
    passed_first_content = False
    book_re = re.compile(rf"^[，,、\s]*(?:《)?{re.escape(book_name)}(?:》)?[，,。:\s]*$") if book_name else None

    for raw in lines:
        s = raw.strip()
        if not passed_first_content:
            if s.startswith("『") and not s.endswith("』"):
                in_header_banner = True
                continue
            if in_header_banner:
                if s.endswith("』") or s == "』":
                    in_header_banner = False
                continue
            if s.startswith("『") and s.endswith("』") and re.search(r"作者:|状态:|内容简介|连载中", s):
                continue

        if AD_LINE_RE.search(s):
            continue
        if book_re and book_re.match(s):
            continue

        cleaned = clean_inline_noise(s) if s else ""
        if cleaned:
            passed_first_content = True
            out.append(cleaned)
        elif not s:
            out.append("")
    return out


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
        self._in_title = False
        self.doc_title = ""

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        attr_map = dict(attrs or [])
        cls = str(attr_map.get("class") or "").lower()
        if t == "title":
            self._in_title = True
            self._cur = []
            return
        if t in ("script", "style", "head", "noscript"):
            self._skip += 1
            return
        if self._skip:
            return
        if t in ("h1", "h2", "h3", "h4"):
            self._flush()
            self._heading_tag = t
        elif t in ("p", "div") and re.search(r"\b(?:title|chapter|chap|head(?:ing)?)\b", cls):
            self._flush()
            self._heading_tag = "cls-head"
        elif t in ("p", "div", "li", "blockquote", "section", "article"):
            self._flush()
        elif t == "br":
            self._cur.append("\n")

    def handle_endtag(self, tag):
        t = tag.lower()
        if t == "title":
            self.doc_title = "".join(self._cur).strip()
            self._cur = []
            self._in_title = False
            return
        if t in ("script", "style", "head", "noscript"):
            if self._skip > 0:
                self._skip -= 1
            return
        if self._skip:
            return
        if t in ("h1", "h2", "h3", "h4") or self._heading_tag == "cls-head":
            text = "".join(self._cur).strip()
            self._cur = []
            if text and len(text) <= 65:
                prefix = "# " if t == "h1" else "## "
                self._blocks.append(prefix + text)
            elif text:
                self._blocks.append(text)
            self._heading_tag = None
        elif t in ("p", "div", "li", "blockquote", "section", "article"):
            self._flush()

    def handle_data(self, data):
        if self._in_title:
            self._cur.append(data)
        elif not self._skip:
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
        zip_names = zf.namelist()
        exact_map = {posixpath.normpath(n): n for n in zip_names}
        lower_map = {posixpath.normpath(n).lower(): n for n in zip_names}

        container_name = exact_map.get("META-INF/container.xml") or lower_map.get("meta-inf/container.xml")
        if not container_name:
            raise ValueError("EPUB missing META-INF/container.xml")
        container_xml = zf.read(container_name).decode("utf-8", errors="replace")
        c_root = ET.fromstring(container_xml)
        opf_path = None
        for elem in c_root.iter():
            if elem.tag.endswith("rootfile") and elem.attrib.get("full-path"):
                opf_path = urllib.parse.unquote(elem.attrib["full-path"])
                break
        if not opf_path:
            raise ValueError("EPUB missing rootfile in container.xml")

        opf_member = exact_map.get(posixpath.normpath(opf_path)) or lower_map.get(posixpath.normpath(opf_path).lower()) or opf_path
        opf_dir = posixpath.dirname(opf_member)
        opf_xml = zf.read(opf_member).decode("utf-8", errors="replace")
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
            clean_href = urllib.parse.unquote(href.split("#", 1)[0]).lstrip("./")
            raw_joined = posixpath.join(opf_dir, clean_href) if opf_dir else clean_href
            norm_joined = posixpath.normpath(raw_joined)
            member = exact_map.get(norm_joined) or lower_map.get(norm_joined.lower())
            if not member:
                continue
            raw = zf.read(member).decode("utf-8", errors="replace")
            parser = _XHTMLTextExtractor()
            parser.feed(raw)
            parser.close()
            extracted = parser.get_lines()
            if not extracted or sum(len(x) for x in extracted) < 30:
                continue
            has_head = any(l.startswith(("# ", "## ")) or CHAP_RE.match(l.strip()) for l in extracted[:5])
            if not has_head and parser.doc_title and sum(len(x) for x in extracted) >= 120:
                dt = parser.doc_title.strip()
                if len(dt) <= 50 and not re.search(r"封面|版权|目录|cover|copyright|toc", dt, re.I):
                    extracted.insert(0, f"## {dt}")
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


def _strip_glued_chap_prefix(lines, book_name, chap_title):
    if not lines:
        return lines
    first = lines[0]
    norm_title = re.sub(r"\s+", "", chap_title)
    if book_name and norm_title:
        m = re.match(rf"^(?:{re.escape(book_name)})?(?:正文卷|正文|VIP卷)?\s*", first)
        rest = first[m.end():] if m else first
        if re.sub(r"\s+", "", rest[: len(chap_title) + 8]).startswith(norm_title):
            idx = 0
            matched = 0
            while idx < len(rest) and matched < len(norm_title):
                if not rest[idx].isspace():
                    matched += 1
                idx += 1
            trimmed = rest[idx:].lstrip(" ：:.-—")
            if trimmed:
                lines[0] = trimmed
            else:
                lines = lines[1:]
    return lines


def parse_structure(lines, default_series_name="正文卷", book_name="", clean_ads=True):
    lines = clean_input_lines(lines, book_name=book_name, clean_ads=clean_ads)
    volumes = []
    cur_series = default_series_name
    cur_vol_num = 0
    explicit_vol_just_set = False
    auto_vol_idx = 1
    prev_chap_num = None
    cur_chapters = []
    cur_title = None
    cur_buf = []

    def flush_chapter():
        nonlocal cur_title, cur_buf
        body_lines = [x for x in cur_buf if x.strip()]
        if body_lines:
            if cur_title is None:
                joined = "\n".join(body_lines)
                if clean_ads and (len(joined) < 400 or re.search(r"推荐一本书|作者[:：]|状态[:：]|内容简介", joined[:300])):
                    cur_buf = []
                    return
                title = "序章"
            else:
                title = cur_title
                if clean_ads:
                    body_lines = _strip_glued_chap_prefix(body_lines, book_name, title)
            if body_lines:
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
        if vm and len(s) <= 65 and not re.search(r"[。！？；]$", s) and not (clean_ads and VOL_TEASER_EXCLUDE_RE.search(s)):
            v_num = parse_cn_or_int(vm.group(2) or vm.group(3) or vm.group(4))
            # Ignore backward or repeated volume headings (typically author notes/song indexes mid-volume)
            if v_num is not None and cur_vol_num > 0 and v_num <= cur_vol_num and len(cur_chapters) > 5:
                cur_buf.append(s)
                continue
            flush_chapter()
            cur_series = (vm.group(1) or s).lstrip("#").strip()
            if v_num is not None:
                cur_vol_num = v_num
                auto_vol_idx = max(auto_vol_idx, v_num)
            explicit_vol_just_set = True
            continue

        cm = CHAP_RE.match(s)
        if (
            cm
            and len(s) <= 60
            and not re.search(r"[。！？；，,:：]$", s)
            and not (clean_ads and FAKE_CHAP_NOTE_RE.search(s))
        ):
            chap_num = parse_cn_or_int(cm.group(2) or cm.group(3) or cm.group(4))
            # Ignore stray index lines jumping far backwards mid-chapter unless resetting at Chapter 1
            if (
                prev_chap_num is not None
                and chap_num is not None
                and prev_chap_num >= 10
                and 1 < chap_num < prev_chap_num - 3
                and len("".join(cur_buf)) < 200
            ):
                cur_buf.append(s)
                continue

            flush_chapter()

            if chap_num is not None:
                if prev_chap_num is not None and prev_chap_num >= 10 and chap_num == 1 and not explicit_vol_just_set:
                    if all(c["series"] == default_series_name for c in cur_chapters):
                        for c in cur_chapters:
                            c["series"] = "第1卷"
                    auto_vol_idx += 1
                    cur_series = f"第{auto_vol_idx}卷"
                    cur_vol_num = max(cur_vol_num, auto_vol_idx)
                prev_chap_num = chap_num

            cur_title = (cm.group(1) or s).lstrip("#").strip()
            explicit_vol_just_set = False
            continue

        explicit_vol_just_set = False
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


def split_chapter_to_scenes(lines, min_chars=1800, target_chars=3600, max_chars=6500):
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

    if len(segments) == 1:
        single_txt = "\n".join(segments[0]).strip()
        if single_txt and len(single_txt) <= max_chars:
            return [single_txt]

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
    if re.search(r"战斗|炮火|枪声|激战|爆炸|刀锋|刺杀|敌袭|鲜血|撤离|危机|追杀|防线|魔法|剑气|骑士|战斗", text):
        tags.append("战斗/危机")
    if re.search(r"温暖|笑意|茶馆|热茶|美食|微风|篝火|拥抱|闲聊|晚饭|安静|微笑|温柔|炉火|日常|休憩", text):
        tags.append("温情/日常")
    if re.search(r"心想|想起|愧疚|梦境|孤独|犹豫|沉默|凝视|独白|自语|往事|绝望|平静|回忆", text):
        tags.append("心理/独白")
    if re.search(r"真相|密钥|密码|密谋|监视|议会|密令|伪装|调查|线索|王国|帝国|贵族|阴谋", text):
        tags.append("权谋/悬疑")
    if re.search(r"序列|资料|技术档案|协议|传承|文献|历史|纪元|铭文|原理|设定", text):
        tags.append("设定/档案")
    if not tags:
        tags.append("叙事/剧情")
    return tags[:3]


CAST_STOPWORDS = {
    "此时", "然后", "不过", "但是", "虽然", "如果", "因为", "所以", "或者", "于是", "然而",
    "他们", "她们", "我们", "你们", "自己", "什么", "怎么", "这个", "那个", "这样", "那样",
    "这里", "那里", "现在", "以前", "之后", "大家", "众人", "少女", "少年", "男子", "女子",
    "男人", "女人", "老师", "学生", "陛下", "殿下", "将军", "骑士", "魔女", "魔法", "系统",
    "世界", "时间", "地方", "问题", "事情", "东西", "声音", "时候", "眼神", "脸上", "心里",
    "心中", "口中", "面前", "身后", "旁边", "其中", "所有", "一些", "一个", "没有", "已经",
    "只是", "还是", "就是", "其实", "大概", "可能", "应该", "似乎", "仿佛", "一边", "一面",
    "突然", "渐渐", "慢慢", "连忙", "立刻", "终于", "实在", "真是", "难道", "不禁", "随即",
    "缓缓", "继续", "微微", "开口", "轻声", "低声", "沉声", "冷声", "悄悄", "轻轻", "默默",
    "略微", "稍微", "依旧", "依然", "接着", "随后", "再度", "再次", "顿时", "忽然", "赶忙",
    "急忙", "赶紧", "摇头", "点头", "转身", "起身", "抬手", "伸手", "皱眉", "叹气", "微笑",
    "犹豫", "尴尬", "无奈", "好奇", "惊讶", "高兴", "得意", "平静", "认真", "仔细", "小心",
    "冷漠", "柔和", "淡然", "兴奋", "激动", "紧张", "羞涩", "疑惑", "不解", "不满", "满意",
    "能力", "获得", "身份", "天赋", "任务", "种族", "技能", "领域", "属性", "等级", "状态",
    "力量", "敏捷", "体力", "魔力", "评价", "品质", "介绍", "说明", "备注", "效果", "类型",
    "名称", "编号", "称号", "职业", "武器", "防具", "装备", "物品", "奖励", "条件", "目标",
    "进度", "防御", "位置", "部位", "消耗", "冷却", "来源", "范围", "身高", "体重", "年龄",
    "性别", "阵营", "所属", "备注", "资料", "序列", "作者", "注", "提示", "档案", "重点",
    "如此", "然后", "道具", "姓名", "ps", "PS", "Ps", "结局", "目录", "序章", "终章",
}

COLON_IGNORE_LABELS = CAST_STOPWORDS | {"时间", "地点", "事件", "背景", "总结", "标题", "正文", "附录"}

SPEECH_ATTR_RE = re.compile(
    r"(?:^|[，。！？\s“”\"「」])([一-龥·]{2,4})(?:说道|笑道|问道|轻声道|低声道|沉声道|开口道|回答道|喃喃道|冷声道|惊呼道|喊道|抱怨道|心想|暗道|自语|点点头|摇摇头|叹了口气|微微一笑|皱了皱眉|鼓了鼓)"
)


def _is_valid_cast_candidate(cand):
    if not cand or len(cand) < 2 or cand in CAST_STOPWORDS:
        return False
    if cand.lower() in ("ps", "http", "https", "www"):
        return False
    if re.search(r"[的地得着了过吧吗呢啊呀哦这那她他它我你]", cand[-1:]):
        return False
    if re.match(r"^(?:最|更|很|太|真|又|也|都|就|才|却|竟|忽|顿|渐|微|轻|缓|偷|暗|连|然后|如此|最后|终于|接着|随后)", cand):
        return False
    return True


def build_book_cast(chapters, alias_pool=None, top_n=45):
    counts = collections.Counter()
    for ch in chapters:
        sample = "\n".join(ch.get("lines", []))
        for m in SPEECH_ATTR_RE.finditer(sample):
            cand = m.group(1).strip("·")
            if _is_valid_cast_candidate(cand):
                counts[cand] += 1
        for line in ch.get("lines", []):
            sm = re.match(r"^([A-Za-z0-9\u4e00-\u9fff·_-]{2,10})[：:]", line.strip())
            if sm:
                cand = sm.group(1)
                if cand not in COLON_IGNORE_LABELS and _is_valid_cast_candidate(cand):
                    counts[cand] += 2

    min_hits = 2 if len(chapters) < 25 else 4
    cast = [name for name, cnt in counts.most_common(top_n) if cnt >= min_hits]
    if alias_pool:
        merged = list(dict.fromkeys(list(alias_pool) + cast))
        return merged
    return cast


def infer_characters_heuristic(text, alias_pool=None):
    counts = collections.Counter()
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9\u4e00-\u9fff·_-]{2,10})[：:]", line.strip())
        if m:
            cand = m.group(1)
            if cand not in COLON_IGNORE_LABELS and _is_valid_cast_candidate(cand):
                counts[cand] += 3
    if alias_pool:
        for name in alias_pool:
            c = text.count(name)
            if c > 0:
                counts[name] += c
    return [k for k, _ in counts.most_common(8)]


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


def llm_json(cfg, prompt, retries=4):
    url = cfg["chatBase"].rstrip("/") + "/chat/completions"
    raw_mt = cfg.get("maxTokens") if cfg.get("maxTokens") is not None else cfg.get("max_tokens")
    max_tokens_val = None
    if raw_mt not in (None, ""):
        try:
            mt_int = int(raw_mt)
            if mt_int > 0:
                max_tokens_val = mt_int
        except (TypeError, ValueError):
            pass
    raw_temp = cfg.get("temperature")
    temp_val = None
    if raw_temp not in (None, ""):
        try:
            temp_val = float(raw_temp)
        except (TypeError, ValueError):
            pass
    raw_re = str(cfg.get("reasoningEffort") or cfg.get("reasoning_effort") or "").strip().lower()
    last_err = None
    for attempt in range(retries):
        payload = {
            "model": cfg["chatModel"],
            "messages": [{"role": "user", "content": prompt}],
        }
        if temp_val is not None:
            payload["temperature"] = temp_val
        if raw_re:
            payload["reasoning_effort"] = raw_re
        if max_tokens_val is not None:
            payload["max_tokens"] = max_tokens_val
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
            usage = data.get("usage") or {}
            m = re.search(r"```(?:json)?\s*([\s\S]*?)```", txt)
            raw = m.group(1) if m else txt
            m2 = re.search(r"(\{[\s\S]*\})", raw)
            parsed = json.loads(m2.group(1) if m2 else raw)
            return parsed, usage
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            last_err = f"HTTP {e.code}: {err_body[:150]}"
            wait_s = min(25.0, 1.5 * (2 ** attempt)) if e.code in (429, 500, 502, 503, 504) else 1.2 * (attempt + 1)
            time.sleep(wait_s)
        except Exception as e:
            last_err = str(e)
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"LLM failed after {retries} attempts: {last_err}")


def atomic_write_json(path, obj, indent=None):
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
    os.replace(tmp_path, path)


def merge_alias_groups(existing_groups, new_groups, max_groups=60):
    existing_terms_lower = set()
    merged = []

    def _absorb(group, is_new=False):
        if not isinstance(group, (list, tuple)):
            return
        seen_local = set()
        clean = []
        for raw in group:
            term = str(raw or "").strip()
            if not term:
                continue
            low = term.lower()
            if is_new and len(term) < 2 and low not in existing_terms_lower:
                continue
            if low in seen_local:
                continue
            seen_local.add(low)
            clean.append(term)
        if len(clean) < 2:
            return
        if not is_new:
            for t in clean:
                existing_terms_lower.add(t.lower())

        clean_lower = {t.lower() for t in clean}
        hit_indices = []
        for idx, grp in enumerate(merged):
            if any(t.lower() in clean_lower for t in grp):
                hit_indices.append(idx)

        if not hit_indices:
            merged.append(clean)
            return

        primary = hit_indices[0]
        combined = []
        combined_lower = set()
        for idx in hit_indices:
            for t in merged[idx]:
                if t.lower() not in combined_lower:
                    combined_lower.add(t.lower())
                    combined.append(t)
        for t in clean:
            if t.lower() not in combined_lower:
                combined_lower.add(t.lower())
                combined.append(t)
        merged[primary] = combined
        for idx in reversed(hit_indices[1:]):
            merged.pop(idx)

    for grp in existing_groups or []:
        _absorb(grp, is_new=False)
    for grp in new_groups or []:
        _absorb(grp, is_new=True)
    return merged[:max_groups]


def merge_glossary(existing_list, new_list, max_items=40):
    def _head(item):
        for sep in ("：", ":"):
            if sep in item:
                h = item.split(sep, 1)[0].strip().lstrip("- ").lower()
                if h:
                    return h
        return item.strip().lstrip("- ").lower()

    out = []
    head_to_idx = {}
    seen_full = set()
    for raw in existing_list or []:
        item = str(raw or "").strip()
        if not item:
            continue
        h = _head(item)
        full = item.lower()
        if full in seen_full:
            continue
        if h in head_to_idx:
            prev = out[head_to_idx[h]]
            if len(item) > len(prev) and len(item) <= 240:
                out[head_to_idx[h]] = item
            continue
        head_to_idx[h] = len(out)
        seen_full.add(full)
        out.append(item)

    for raw in new_list or []:
        item = str(raw or "").strip()
        if not item or len(item) > 240:
            continue
        h = _head(item)
        full = item.lower()
        if full in seen_full:
            continue
        if h in head_to_idx:
            prev = out[head_to_idx[h]]
            if len(item) > len(prev):
                out[head_to_idx[h]] = item
                seen_full.add(full)
            continue
        if len(out) >= max_items:
            break
        head_to_idx[h] = len(out)
        seen_full.add(full)
        out.append(item)
    return out[:max_items]


def merge_relations(existing_edges, new_edges, max_edges=500):
    edge_map = collections.OrderedDict()
    for raw in list(existing_edges or []) + list(new_edges or []):
        if not isinstance(raw, dict):
            continue
        s = str(raw.get("s") or "").strip()
        r = str(raw.get("r") or "").strip()
        o = str(raw.get("o") or "").strip()
        if not s or not r or not o or s == o:
            continue
        w = max(1, int(raw.get("w") or 1))
        key = (s.lower(), r.lower(), o.lower())
        if key in edge_map:
            edge_map[key]["w"] = edge_map[key].get("w", 1) + w
        else:
            rec = {"s": s, "r": r, "o": o, "w": w}
            if isinstance(raw.get("ev"), list):
                rec["ev"] = raw["ev"]
            edge_map[key] = rec
    sorted_edges = sorted(edge_map.values(), key=lambda x: x.get("w", 1), reverse=True)
    return sorted_edges[:max_edges]


def build_series_digest(ser_arcs, max_samples=80, max_chars=6500):
    if len(ser_arcs) <= max_samples:
        sampled = ser_arcs
    else:
        step_indices = [int(i * (len(ser_arcs) - 1) / (max_samples - 1)) for i in range(max_samples)]
        sampled = [ser_arcs[i] for i in dict.fromkeys(step_indices)]

    lines = []
    used = 0
    for a in sampled:
        ord_tag = f"第{a.get('order')}章 " if a.get("order") is not None else ""
        desc = str(a.get("description") or "").replace("\n", " ").strip()[:65]
        line = f"- {ord_tag}{a.get('title', '')}: {desc}"
        if used + len(line) + 1 > max_chars and lines:
            break
        lines.append(line)
        used += len(line) + 1

    char_freq = collections.Counter()
    for a in ser_arcs:
        for ch in a.get("characters") or []:
            cs = str(ch or "").strip()
            if cs:
                char_freq[cs] += 1
    top_chars = [c for c, _ in char_freq.most_common(20)]
    return "\n".join(lines), top_chars


def select_target_arcs(arcs, series_filter="", start_arc=1, limit_arcs=0):
    scoped = list(arcs)
    ser = str(series_filter or "").strip()
    if ser:
        scoped = [a for a in scoped if str(a.get("series") or "").strip() == ser]
        if not scoped:
            avail = list(dict.fromkeys(str(a.get("series") or "").strip() or "(无分卷)" for a in arcs))
            raise RuntimeError(f"Series '{ser}' not found. Available series: {', '.join(avail[:20])}")
    start_idx = max(0, int(start_arc or 1) - 1)
    scoped = scoped[start_idx:]
    if limit_arcs and int(limit_arcs) > 0:
        scoped = scoped[: int(limit_arcs)]
    return scoped


def main():
    parser = argparse.ArgumentParser(description="LoreCodex universal novel/TXT/MD/EPUB tree builder")
    parser.add_argument("--input", default="", help="Path to .txt / .md / .epub file or directory")
    parser.add_argument("--corpus-id", required=True, help="Target corpus ID (e.g. my-novel)")
    parser.add_argument("--name", default="", help="Display name of the work")
    parser.add_argument("--out-dir", default="corpora", help="Corpora root directory (default: corpora)")
    parser.add_argument("--config", default="config.json", help="Config file with chatBase/chatKey/chatModel")
    parser.add_argument("--category", default="正文", help="Default category label (default: 正文)")
    parser.add_argument("--min-chars", type=int, default=1800)
    parser.add_argument("--target-chars", type=int, default=3600)
    parser.add_argument("--max-chars", type=int, default=6500)
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--no-llm", action="store_true", help="Build deterministically without calling LLM API")
    parser.add_argument("--no-clean-ads", action="store_true", help="Disable web-novel ad/watermark line stripping")
    parser.add_argument("--overwrite-config", action="store_true", help="Overwrite existing corpus.json if present")
    parser.add_argument("--upgrade", action="store_true", help="Upgrade an existing corpus index in place with LLM summaries")
    parser.add_argument("--series", default="", help="Only LLM-summarize arcs belonging to this exact series")
    parser.add_argument("--start-arc", type=int, default=1, help="1-based arc offset inside filtered scope")
    parser.add_argument("--limit-arcs", type=int, default=0, help="Max arcs to LLM-summarize (0 = all)")
    parser.add_argument("--skip-meta", action="store_true", help="Skip post-summarization series summary/aliases/glossary synthesis")
    parser.add_argument("--force", action="store_true", help="Ignore cached LLM checkpoints for targeted arcs")
    parser.add_argument("--max-tokens", type=int, default=0, help="Optional max_tokens for LLM requests (0 = omit, use model default)")
    parser.add_argument("--temperature", type=float, default=None, help="Optional temperature for LLM requests (omit by default to use model default)")
    parser.add_argument("--reasoning-effort", default="", help="Optional reasoning_effort for LLM requests, e.g. low/medium/high (empty = omit, use model default)")
    args = parser.parse_args()

    out_corpus_dir = os.path.join(args.out_dir, args.corpus_id)
    os.makedirs(out_corpus_dir, exist_ok=True)
    corpus_cfg_path = os.path.join(out_corpus_dir, "corpus.json")

    existing_corpus_cfg = {}
    alias_pool = []
    if os.path.exists(corpus_cfg_path):
        try:
            with open(corpus_cfg_path, "r", encoding="utf-8") as f:
                existing_corpus_cfg = json.load(f)
            for grp in existing_corpus_cfg.get("aliases", []):
                alias_pool.extend(grp)
        except Exception:
            existing_corpus_cfg = {}

    if args.upgrade:
        if args.no_llm:
            raise RuntimeError("--upgrade requires LLM mode and cannot be combined with --no-llm")
        idx_path = os.path.join(out_corpus_dir, "tree_index.json")
        txt_path = os.path.join(out_corpus_dir, "tree_texts.json")
        if not os.path.exists(idx_path) or not os.path.exists(txt_path):
            raise RuntimeError(f"Cannot --upgrade: tree_index.json or tree_texts.json missing in {out_corpus_dir}")
        with open(idx_path, "r", encoding="utf-8") as f:
            existing_index = json.load(f)
        with open(txt_path, "r", encoding="utf-8") as f:
            texts_map = json.load(f)
        arcs = existing_index.get("arcs") or []
        source_name = existing_index.get("source") or args.corpus_id
        existing_series_summaries = dict(existing_index.get("series_summaries") or {})
        if not args.name:
            args.name = str(existing_corpus_cfg.get("name") or args.corpus_id).strip()
        freq = collections.Counter()
        for a in arcs:
            for ch in a.get("characters") or []:
                freq[ch] += 1
        cast_pool = list(dict.fromkeys(alias_pool + [c for c, _ in freq.most_common(45)]))
    else:
        if not args.input:
            raise RuntimeError("--input is required unless --upgrade is passed")
        if not args.name:
            args.name = os.path.splitext(os.path.basename(args.input))[0] or args.corpus_id
        source_name = os.path.basename(os.path.normpath(args.input))
        existing_series_summaries = {}

        lines = load_input_lines(args.input)
        chapters = parse_structure(lines, default_series_name="正文卷", book_name=args.name, clean_ads=not args.no_clean_ads)
        if not chapters:
            raise RuntimeError(f"No readable chapters parsed from {args.input}")

        cast_pool = build_book_cast(chapters, alias_pool=alias_pool)

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
        if args.max_tokens and args.max_tokens > 0:
            cfg["maxTokens"] = args.max_tokens
        if args.temperature is not None:
            cfg["temperature"] = args.temperature
        if str(args.reasoning_effort or "").strip():
            cfg["reasoningEffort"] = str(args.reasoning_effort).strip().lower()
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
    usage_stats = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "reused_single_arcs": 0}

    def save_ckpt(rec):
        with ckpt_lock:
            ckpt[rec["key"]] = rec
            with open(ckpt_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def record_usage(usage):
        with ckpt_lock:
            usage_stats["calls"] += 1
            if isinstance(usage, dict):
                usage_stats["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
                usage_stats["completion_tokens"] += int(usage.get("completion_tokens") or 0)

    series_summaries = dict(existing_series_summaries)
    extracted_aliases = []
    extracted_glossary = []
    extracted_relations = []

    if args.no_llm:
        for a in arcs:
            arc_chars = collections.Counter()
            arc_tones = collections.Counter()
            for idx, sc in enumerate(a["scenes"], 1):
                meta = heuristic_scene_meta(a["title"], idx, len(a["scenes"]), texts_map[sc["node_id"]]["text"], cast_pool)
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
        target_arcs = select_target_arcs(arcs, args.series, args.start_arc, args.limit_arcs)
        print(
            f"[build_novel] LLM target scope: {len(target_arcs)}/{len(arcs)} arcs"
            + (f" (series={args.series})" if args.series else "")
        )

        todo_leaves = []
        for a in target_arcs:
            for sc in a["scenes"]:
                key = f"leaf:{sc['node_id']}"
                if not args.force and key in ckpt:
                    sc["title"] = ckpt[key].get("title", "")
                    sc["summary"] = ckpt[key].get("summary", "")
                    sc["tone_tags"] = ckpt[key].get("tone_tags", [])
                    sc["_chars"] = ckpt[key].get("characters", [])
                else:
                    todo_leaves.append((a, sc, key))

        def _run_leaf(item):
            a, sc, key = item
            txt = texts_map[sc["node_id"]]["text"][:7000]
            prompt = (
                f"你是《{args.name}》文本目录索引员。请为下面这段完整场景生成检索索引（注意把人称代词消解为具体人名）：\n"
                "1. title: 6-14字场景标题，概括地点/人物或核心事件；\n"
                "2. summary: 2句话（70-140字），保留人名、化名/外号、专有名词、重要物品、数字和事件转折；若角色在对话中回忆或提及往事、身世、救援、小队组建等过往经历，必须明确记录“回忆当年/提及某人某事”等线索；\n"
                "3. characters: 本幕直接出场或对话中明确提及的关键/过往人物数组（最多6人）；\n"
                "4. tone_tags: 从 [战斗/危机, 温情/日常, 心理/独白, 权谋/悬疑, 设定/档案, 叙事/剧情] 中选 1-2 个标签。\n"
                "只输出严格 JSON：{\"title\":\"...\",\"summary\":\"...\",\"characters\":[],\"tone_tags\":[]}\n\n"
                f"所属篇章：{a.get('series', '')} / {a['title']}\n正文：\n{txt}"
            )
            parsed, usage = llm_json(cfg, prompt)
            record_usage(usage)
            rec = {
                "key": key,
                "title": str(parsed.get("title", "")).strip() or f"{a['title']}·片段",
                "summary": str(parsed.get("summary", "")).strip(),
                "characters": [str(x).strip() for x in (parsed.get("characters") or []) if str(x).strip()][:6],
                "tone_tags": [str(x).strip() for x in (parsed.get("tone_tags") or []) if str(x).strip()][:2] or ["叙事/剧情"],
            }
            save_ckpt(rec)
            return sc, rec

        if todo_leaves:
            print(f"[build_novel] summarizing {len(todo_leaves)} scenes with LLM (workers={args.workers})...")
            done_cnt = 0
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
                fut_map = {ex.submit(_run_leaf, it): it for it in todo_leaves}
                for fut in concurrent.futures.as_completed(fut_map):
                    a, sc, key = fut_map[fut]
                    done_cnt += 1
                    try:
                        sc, rec = fut.result()
                    except Exception as err:
                        print(f"[build_novel] warn leaf {sc['node_id']} fallback ({err})")
                        fb = heuristic_scene_meta(a["title"], 1, len(a["scenes"]), texts_map[sc["node_id"]]["text"], cast_pool)
                        rec = {
                            "key": key,
                            "title": fb["title"],
                            "summary": fb["summary"],
                            "characters": fb["characters"],
                            "tone_tags": fb["tone_tags"],
                        }
                    sc["title"] = rec["title"]
                    sc["summary"] = rec["summary"]
                    sc["tone_tags"] = rec["tone_tags"]
                    sc["_chars"] = rec["characters"]
                    if done_cnt % 50 == 0 or done_cnt == len(todo_leaves):
                        print(f"[build_novel] leaf progress: {done_cnt}/{len(todo_leaves)}")

        todo_arcs = []
        for a in target_arcs:
            scenes = a.get("scenes") or []
            if len(scenes) == 1:
                sc = scenes[0]
                a["description"] = sc["summary"]
                a["characters"] = list(sc.get("_chars") or a.get("characters") or [])[:8]
                a["tone_tags"] = list(sc.get("tone_tags") or ["叙事/剧情"])[:2]
                a["key_items"] = [sc["title"]] if sc.get("title") else []
                usage_stats["reused_single_arcs"] += 1
                continue

            if not scenes:
                continue

            key = f"arc:{a['arc_id']}"
            if not args.force and key in ckpt:
                a["description"] = ckpt[key].get("description", "")
                a["characters"] = ckpt[key].get("characters", [])
                a["tone_tags"] = ckpt[key].get("tone_tags", [])
                a["key_items"] = ckpt[key].get("key_items", [])
            else:
                todo_arcs.append((a, key))

        if usage_stats["reused_single_arcs"]:
            print(
                f"[build_novel] reused leaf summaries for {usage_stats['reused_single_arcs']} single-scene arcs "
                f"(saved {usage_stats['reused_single_arcs']} LLM calls)"
            )

        def _run_arc(item):
            a, key = item
            sc_lines = "\n".join(f"- [{s['node_id']}] {s['title']}: {s['summary']}" for s in a["scenes"])
            prompt = (
                f"根据《{args.name}》篇章的子场景摘要提炼篇章总目信息：\n"
                "1. description: 1-2句话（60-120字）概括全章核心人物与事件，必须保留团队/势力/身份变动（如队长交接、更名、分队重组、吸纳新成员）与重要往事揭秘；\n"
                "2. characters: 核心出场及关键提及人物数组（最多8人）；\n"
                "3. tone_tags: 1-2个氛围标签。\n"
                "只输出 JSON：{\"description\":\"...\",\"characters\":[],\"tone_tags\":[]}\n\n"
                f"篇章：{a.get('series', '')} / {a['title']}\n子场景：\n{sc_lines}"
            )
            parsed, usage = llm_json(cfg, prompt)
            record_usage(usage)
            rec = {
                "key": key,
                "description": str(parsed.get("description", "")).strip(),
                "characters": [str(x).strip() for x in (parsed.get("characters") or []) if str(x).strip()][:8],
                "tone_tags": [str(x).strip() for x in (parsed.get("tone_tags") or []) if str(x).strip()][:2] or ["叙事/剧情"],
                "key_items": [s["title"] for s in a["scenes"][:8] if s.get("title")],
            }
            save_ckpt(rec)
            return a, rec

        if todo_arcs:
            print(f"[build_novel] summarizing {len(todo_arcs)} multi-scene arcs with LLM...")
            arc_done = 0
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
                fut_map = {ex.submit(_run_arc, it): it for it in todo_arcs}
                for fut in concurrent.futures.as_completed(fut_map):
                    a, key = fut_map[fut]
                    arc_done += 1
                    try:
                        a, rec = fut.result()
                    except Exception as err:
                        print(f"[build_novel] warn arc {a['arc_id']} fallback ({err})")
                        fb_chars = []
                        seen_fc = set()
                        for sc in a["scenes"]:
                            for ch in sc.get("_chars") or []:
                                if ch not in seen_fc:
                                    seen_fc.add(ch)
                                    fb_chars.append(ch)
                        rec = {
                            "key": key,
                            "description": "；".join(s["summary"][:60] for s in a["scenes"][:2])[:140],
                            "characters": fb_chars[:8],
                            "tone_tags": ["叙事/剧情"],
                            "key_items": [s["title"] for s in a["scenes"][:8] if s.get("title")],
                        }
                    a["description"] = rec["description"]
                    a["characters"] = rec["characters"]
                    a["tone_tags"] = rec["tone_tags"]
                    a["key_items"] = rec["key_items"]
                    if arc_done % 50 == 0 or arc_done == len(todo_arcs):
                        print(f"[build_novel] arc progress: {arc_done}/{len(todo_arcs)}")

        if not args.skip_meta and target_arcs:
            grouped = collections.OrderedDict()
            for a in target_arcs:
                ser_name = str(a.get("series") or a.get("category") or "正文卷").strip()
                grouped.setdefault(ser_name, []).append(a)

            for ser_name, ser_arcs in grouped.items():
                meta_key = f"series_meta:{ser_name}:{len(ser_arcs)}"
                if not args.force and meta_key in ckpt:
                    rec = ckpt[meta_key]
                else:
                    digest_text, top_chars = build_series_digest(ser_arcs)
                    meta_prompt = (
                        f"你是《{args.name}》文本资料库总编。请根据以下「{ser_name}」的章节脉络与高频人物表，提炼全卷级检索元数据与知识图谱：\n"
                        "1. series_summary: 60-120字精炼概括本卷主线剧情、核心舞台与关键转折；\n"
                        "2. aliases: 同一人物/实体的本名、化名、外号、简称对照二维数组（每组至少2项，严禁把不同人混为一组，最多25组）；\n"
                        "3. glossary: 本卷重要势力、组织、小队编制、能力体系、核心地点或器物速查数组（每条“名称：一句话说明”，对核心小队/组织务必写全各分队或各期成员名单与更迭，如一队/二队/新老成员，最多20条）；\n"
                        "4. relations: 人物与人物、人物与组织/小队的知识图谱关系三元组数组，格式 [{\"s\":\"主体\",\"r\":\"关系(如:属于/队长/搭档/旧友/宿敌/救过/接任)\",\"o\":\"客体\"}]（最多40条）。\n"
                        "只输出严格 JSON：{\"series_summary\":\"60-120字概括本卷主线、核心舞台与转折\",\"aliases\":[[\"正式名\",\"化名/外号/简称\"]],\"glossary\":[\"重要势力/小队/组织/地点：一句话说明（写明成员或分支）\"],\"relations\":[{\"s\":\"主体\",\"r\":\"关系\",\"o\":\"客体\"}]}\n\n"
                        f"高频人物：{', '.join(top_chars) if top_chars else '（暂无）'}\n"
                        f"章节脉络（共 {len(ser_arcs)} 章）：\n{digest_text}"
                    )
                    try:
                        parsed, usage = llm_json(cfg, meta_prompt)
                        record_usage(usage)
                        rec = {
                            "key": meta_key,
                            "series_summary": str(parsed.get("series_summary", "")).strip(),
                            "aliases": parsed.get("aliases") if isinstance(parsed.get("aliases"), list) else [],
                            "glossary": [str(x).strip() for x in (parsed.get("glossary") or []) if str(x).strip()],
                            "relations": parsed.get("relations") if isinstance(parsed.get("relations"), list) else [],
                        }
                        save_ckpt(rec)
                        print(
                            f"[build_novel] synthesized meta for '{ser_name}': "
                            f"summary={len(rec['series_summary'])}c, aliases={len(rec['aliases'])}, "
                            f"glossary={len(rec['glossary'])}, relations={len(rec['relations'])}"
                        )
                    except Exception as err:
                        print(f"[build_novel] warn series_meta '{ser_name}' skipped ({err})")
                        rec = None

                if rec:
                    if rec.get("series_summary"):
                        series_summaries[ser_name] = rec["series_summary"]
                    if rec.get("aliases"):
                        extracted_aliases.extend(rec["aliases"])
                    if rec.get("glossary"):
                        extracted_glossary.extend(rec["glossary"])
                    if rec.get("relations"):
                        extracted_relations.extend(rec["relations"])

        for a in arcs:
            for sc in a.get("scenes") or []:
                sc.pop("_chars", None)

    total_scenes = sum(len(a.get("scenes") or []) for a in arcs)
    total_chars = sum(
        int(a.get("total_chars") or sum(int(s.get("chars") or 0) for s in (a.get("scenes") or [])))
        for a in arcs
    )
    ckpt_keys = set(ckpt.keys())
    llm_scenes_count = 0
    llm_arcs_count = 0
    for a in arcs:
        sc_list = a.get("scenes") or []
        if sc_list and all(f"leaf:{sc['node_id']}" in ckpt_keys for sc in sc_list):
            if len(sc_list) == 1 or f"arc:{a['arc_id']}" in ckpt_keys:
                llm_arcs_count += 1
        for sc in sc_list:
            if f"leaf:{sc['node_id']}" in ckpt_keys:
                llm_scenes_count += 1

    index_doc = {
        "version": 2,
        "source": source_name,
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stats": {
            "arcs": len(arcs),
            "groups": total_scenes,
            "scenes": total_scenes,
            "total_chars": total_chars,
            "llm_scenes": llm_scenes_count,
            "llm_arcs": llm_arcs_count,
        },
        "arcs": arcs,
    }
    if series_summaries:
        index_doc["series_summaries"] = series_summaries

    atomic_write_json(os.path.join(out_corpus_dir, "tree_index.json"), index_doc, indent=2)
    if not args.upgrade:
        atomic_write_json(os.path.join(out_corpus_dir, "tree_texts.json"), texts_map)

    if args.overwrite_config or not os.path.exists(corpus_cfg_path):
        merged_aliases = merge_alias_groups([], extracted_aliases)
        merged_glossary = merge_glossary([], extracted_glossary)
        corpus_cfg = {
            "id": args.corpus_id,
            "name": args.name,
            "description": f"《{args.name}》长文本典籍树（共 {len(arcs)} 卷 / {total_scenes} 幕 / {total_chars:,} 字）。",
            "language": "zh-CN",
            "world_premise": f"当前语料库收录了《{args.name}》的章节正文与相关背景资料。请严格基于已核实的章节原文提供角色扮演回忆或设定解答。",
            "aliases": merged_aliases,
            "glossary": merged_glossary,
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
        atomic_write_json(corpus_cfg_path, corpus_cfg, indent=2)
    elif extracted_aliases or extracted_glossary:
        cur_cfg = dict(existing_corpus_cfg)
        old_aliases = cur_cfg.get("aliases") or []
        old_glossary = cur_cfg.get("glossary") or []
        new_aliases = merge_alias_groups(old_aliases, extracted_aliases)
        new_glossary = merge_glossary(old_glossary, extracted_glossary)
        if new_aliases != old_aliases or new_glossary != old_glossary:
            cur_cfg["aliases"] = new_aliases
            cur_cfg["glossary"] = new_glossary
            atomic_write_json(corpus_cfg_path, cur_cfg, indent=2)
            print(
                f"[build_novel] merged corpus.json metadata: aliases={len(old_aliases)}->{len(new_aliases)}, "
                f"glossary={len(old_glossary)}->{len(new_glossary)}"
            )

    if extracted_relations:
        graph_path = os.path.join(out_corpus_dir, "graph.json")
        existing_edges = []
        if os.path.exists(graph_path):
            try:
                with open(graph_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, list):
                    existing_edges = loaded
            except Exception:
                existing_edges = []
        merged_edges = merge_relations(existing_edges, extracted_relations)
        if merged_edges:
            atomic_write_json(graph_path, merged_edges, indent=2)
            print(f"[build_novel] merged graph.json: {len(existing_edges)}->{len(merged_edges)} edges")

    if not args.no_llm:
        print(
            f"[build_novel] LLM stats: calls={usage_stats['calls']}, "
            f"reused_single_arcs={usage_stats['reused_single_arcs']}, "
            f"prompt_tokens={usage_stats['prompt_tokens']}, "
            f"completion_tokens={usage_stats['completion_tokens']}"
        )

    print(
        f"[build_novel] DONE corpus={args.corpus_id}: arcs={len(arcs)}, scenes={total_scenes}, "
        f"llm_scenes={llm_scenes_count}, llm_arcs={llm_arcs_count}, chars={total_chars} -> {out_corpus_dir}"
    )


if __name__ == "__main__":
    main()
