#!/usr/bin/env python3
"""
工友管家 — 法律知识库本地检索脚本

基于本地 Markdown 知识库做关键词匹配 + 分段检索。
无需外部 API，无需向量化，纯本地运行。

用法:
    python3 law_search.py "老板欠我三个月工资怎么办"
    python3 law_search.py '{"query":"工伤怎么赔","top_k":3}'
"""

import json
import os
import re
import sys
from pathlib import Path

KNOWLEDGE_BASE_DIR = Path(__file__).parent.parent / "law-knowledge-base"


def load_knowledge_base():
    """加载知识库所有 md 文件，按 '---' 分段"""
    segments = []
    for md_file in sorted(KNOWLEDGE_BASE_DIR.glob("*.md")):
        if md_file.name == "README.md":
            continue
        content = md_file.read_text(encoding="utf-8")
        # 按 --- 分段
        parts = re.split(r"\n---\n", content)
        for i, part in enumerate(parts):
            part = part.strip()
            if not part or len(part) < 20:
                continue
            # 提取标题
            title_match = re.match(r"^#+\s*(.+)", part)
            title = title_match.group(1).strip() if title_match else ""
            segments.append({
                "source_file": md_file.name,
                "segment_index": i,
                "title": title,
                "content": part,
            })
    return segments


def search(query, top_k=5):
    """
    关键词匹配检索

    策略:
    1. 将查询分词
    2. 对每个段落计算关键词命中数
    3. 按命中数排序，返回 top_k
    """
    segments = load_knowledge_base()

    # 查询分词（简单按空格 + 常见法律关键词拆分）
    # 同时保留原查询用于精确匹配
    keywords = set()
    # 原查询拆分
    for word in re.split(r"[\s，。？?！!、的了怎么办怎样如何]", query):
        word = word.strip()
        if len(word) >= 2:
            keywords.add(word)

    # 补充同义词映射
    synonym_map = {
        "欠薪": ["拖欠", "不发工资", "克扣", "工资"],
        "拖欠": ["欠薪", "不发", "克扣"],
        "工资": ["欠薪", "拖欠", "报酬", "劳务费"],
        "工伤": ["受伤", "伤残", "事故", "医疗"],
        "合同": ["劳动合同", "签约", "签合同"],
        "社保": ["社会保险", "五险", "保险"],
        "辞退": ["解除", "清退", "开除", "走人"],
        "加班": ["延长工作时间", "加点"],
        "赔偿": ["补偿", "赔偿金", "经济补偿"],
        "试用期": ["试用", "试工"],
        "最低工资": ["最低标准", "最低保障"],
        "身份证": ["证件", "扣押"],
        "高温": ["防暑", "降温", "中暑"],
        "产假": ["怀孕", "生育", "哺乳", "女工"],
        "仲裁": ["劳动仲裁", "仲裁委"],
        "包工头": ["分包", "包工", "跑路"],
    }

    expanded_keywords = set(keywords)
    for kw in list(keywords):
        if kw in synonym_map:
            for syn in synonym_map[kw]:
                expanded_keywords.add(syn)

    # 对每个段落计算得分
    results = []
    for seg in segments:
        content_lower = seg["content"]
        score = 0
        matched_keywords = []

        for kw in expanded_keywords:
            count = content_lower.count(kw)
            if count > 0:
                # 标题中命中权重更高
                if kw in seg.get("title", ""):
                    score += count * 3
                else:
                    score += count
                matched_keywords.append(kw)

        if score > 0:
            results.append({
                "source_file": seg["source_file"],
                "title": seg["title"],
                "score": score,
                "matched_keywords": list(set(matched_keywords)),
                "content": seg["content"][:2000],  # 截断防止过长
            })

    # 按得分排序
    results.sort(key=lambda x: x["score"], reverse=True)

    # 如果关键词匹配无结果，尝试模糊匹配
    if not results:
        for seg in segments:
            # 检查查询的子串是否出现在内容中
            query_substrings = [query[i:j] for i in range(len(query)) for j in range(i+2, len(query)+1) if j-i <= 6]
            score = 0
            for sub in query_substrings:
                if sub in seg["content"]:
                    score += 1
            if score > 0:
                results.append({
                    "source_file": seg["source_file"],
                    "title": seg["title"],
                    "score": score,
                    "matched_keywords": [],
                    "content": seg["content"][:2000],
                })
        results.sort(key=lambda x: x["score"], reverse=True)

    return results[:top_k]


def format_results(results, query):
    """格式化检索结果"""
    if not results:
        return f"未检索到与「{query}」相关的法律依据。建议工友找项目法务确认。"

    output = [f"检索「{query}」找到 {len(results)} 条相关法律依据：\n"]
    for i, r in enumerate(results, 1):
        output.append(f"--- 结果{i}（相关度:{r['score']}）---")
        output.append(f"来源：{r['source_file']}")
        output.append(f"标题：{r['title']}")
        if r["matched_keywords"]:
            output.append(f"命中关键词：{', '.join(r['matched_keywords'])}")
        output.append(f"内容：\n{r['content']}")
        output.append("")
    return "\n".join(output)


def main():
    if len(sys.argv) < 2:
        print("用法: python3 law_search.py '查询内容'")
        print("或:   python3 law_search.py '{\"query\":\"查询内容\",\"top_k\":3}'")
        return 1

    arg = sys.argv[1]

    # 支持 JSON 参数
    if arg.startswith("{"):
        try:
            params = json.loads(arg)
            query = params.get("query", "")
            top_k = params.get("top_k", 5)
        except json.JSONDecodeError:
            query = arg
            top_k = 5
    else:
        query = arg
        top_k = 5

    results = search(query, top_k)
    output = format_results(results, query)
    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
