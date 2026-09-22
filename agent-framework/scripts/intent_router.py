#!/usr/bin/env python3
"""
工友管家 — 意图路由器

分析用户输入，判断属于哪个意图类别，路由到对应工作流。

用法:
    python3 intent_router.py "老板欠我三个月工资怎么办"
    返回: {"intent":"rights_consultation","confidence":0.9,"keywords":["欠","工资"]}
"""

import json
import re
import sys
import os

# 将 scripts 目录加入路径
sys.path.insert(0, os.path.dirname(__file__))
from law_search import search as law_search


# ========== 意图关键词定义 ==========

INTENT_KEYWORDS = {
    "rights_consultation": {
        "keywords": [
            "工资", "欠薪", "拖欠", "不发", "克扣", "扣工资", "报酬",
            "工伤", "受伤", "伤残", "事故",
            "合同", "签约", "签合同", "没签",
            "社保", "保险", "五险",
            "加班", "加点", "加班费",
            "辞退", "解雇", "开除", "清退", "走人", "不要我了",
            "赔偿", "补偿", "经济补偿",
            "试用期", "试用",
            "最低工资", "最低标准",
            "身份证", "扣押",
            "高温", "防暑", "降温",
            "产假", "怀孕", "生育", "哺乳",
            "仲裁", "维权", "投诉", "12333",
            "包工头", "跑路", "分包",
            "双倍工资",
        ],
        "description": "权益咨询",
    },
    "mental_support": {
        "keywords": [
            "想家", "想孩子", "回家", "半年没回",
            "累", "烦", "烦躁", "压力大", "压力",
            "睡不着", "失眠", "睡眠不好",
            "难过", "伤心", "想哭", "哭",
            "焦虑", "着急", "崩溃",
            "不想活", "活不下去", "想死", "自杀", "了结", "跳楼", "割腕",
            "没意思", "没意义", "撑不下去", "不想撑了",
            "家里", "吵架", "矛盾", "老婆", "孩子",
            "孤单", "寂寞", "没人管",
        ],
        "description": "心理陪伴",
    },
    "convenience_tools": {
        "keywords": [
            "报修", "坏了", "漏水", "不亮", "没电", "停水", "停电",
            "食堂", "饭菜", "饭", "吃", "难吃", "分量少",
            "班车", "车", "几点", "发车", "末班车",
            "宿舍", "空调", "不制冷", "不制热", "门窗",
            "水电", "热水", "冷水",
        ],
        "description": "便民工具",
    },
    "safety_education": {
        "keywords": [
            "安全", "危险", "防护", "安全帽", "安全带",
            "操作", "规程", "规范",
            "高空", "用电", "消防", "灭火",
        ],
        "description": "安全教育",
    },
}

# 高危关键词（心理陪伴专用）
CRITICAL_KEYWORDS = ["不想活", "活不下去", "想死", "自杀", "了结", "跳楼", "割腕"]
WARNING_KEYWORDS = ["没意思", "没意义", "撑不下去", "不想撑了", "活着太累"]


def classify_intent(user_input):
    """
    分类用户意图

    返回:
    {
        "intent": "rights_consultation|mental_support|convenience_tools|safety_education|chitchat",
        "confidence": 0.0-1.0,
        "matched_keywords": [匹配到的关键词列表],
        "sub_type": "子类型（如 wages/injury/contract 等）"
    }
    """
    input_lower = user_input.lower()

    scores = {}
    matched = {}

    for intent, config in INTENT_KEYWORDS.items():
        score = 0
        kw_matched = []
        for kw in config["keywords"]:
            if kw in user_input:
                score += 1
                kw_matched.append(kw)
        scores[intent] = score
        matched[intent] = kw_matched

    # 找到最高分
    best_intent = max(scores, key=scores.get)
    best_score = scores[best_intent]

    if best_score == 0:
        # 无关键词命中，可能是闲聊
        return {
            "intent": "chitchat",
            "confidence": 0.3,
            "matched_keywords": [],
            "sub_type": None,
        }

    # 计算置信度
    total_kw = len(INTENT_KEYWORDS[best_intent]["keywords"])
    confidence = min(best_score / max(total_kw * 0.15, 1), 1.0)

    # 识别子类型
    sub_type = identify_sub_type(best_intent, user_input)

    return {
        "intent": best_intent,
        "confidence": round(confidence, 2),
        "matched_keywords": matched[best_intent],
        "sub_type": sub_type,
    }


def identify_sub_type(intent, user_input):
    """识别意图的子类型"""
    if intent == "rights_consultation":
        if any(kw in user_input for kw in ["工资", "欠薪", "拖欠", "不发", "克扣", "报酬", "包工头", "跑路"]):
            return "wages"
        if any(kw in user_input for kw in ["工伤", "受伤", "伤残", "事故"]):
            return "injury"
        if any(kw in user_input for kw in ["合同", "签约", "没签", "试用期"]):
            return "contract"
        if any(kw in user_input for kw in ["社保", "保险", "五险"]):
            return "social_insurance"
        if any(kw in user_input for kw in ["加班", "加点"]):
            return "overtime"
        if any(kw in user_input for kw in ["辞退", "解雇", "开除", "清退"]):
            return "dismissal"
        if any(kw in user_input for kw in ["身份证", "扣押"]):
            return "id_detention"
        if any(kw in user_input for kw in ["高温", "防暑"]):
            return "high_temp"
        if any(kw in user_input for kw in ["产假", "怀孕", "生育"]):
            return "maternity"
        if any(kw in user_input for kw in ["仲裁", "维权", "投诉"]):
            return "arbitration"
        return "other_rights"

    if intent == "mental_support":
        if any(kw in user_input for kw in CRITICAL_KEYWORDS):
            return "critical"
        if any(kw in user_input for kw in WARNING_KEYWORDS):
            return "warning"
        return "normal"

    if intent == "convenience_tools":
        if any(kw in user_input for kw in ["报修", "坏了", "漏水", "不亮", "没电", "停水", "停电", "空调", "门窗"]):
            return "repair"
        if any(kw in user_input for kw in ["食堂", "饭菜", "饭", "难吃", "分量"]):
            return "food_feedback"
        if any(kw in user_input for kw in ["班车", "车", "几点", "发车", "末班"]):
            return "bus_query"
        return "other_tools"

    return None


def check_mental_safety(user_input):
    """
    心理安全检测

    返回: "critical" | "warning" | "normal"
    """
    if any(kw in user_input for kw in CRITICAL_KEYWORDS):
        return "critical"
    if any(kw in user_input for kw in WARNING_KEYWORDS):
        return "warning"
    return "normal"


def route(user_input):
    """
    完整路由：意图分类 + 安全检测 + 知识库检索（如权益咨询）

    返回完整的路由结果
    """
    # 1. 意图分类
    result = classify_intent(user_input)

    # 2. 心理安全检测（所有意图都检测）
    mental_level = check_mental_safety(user_input)
    result["mental_safety_level"] = mental_level

    # 如果检测到极危，无论什么意图都优先处理心理危机
    if mental_level == "critical":
        result["override"] = "mental_crisis"
        result["intent"] = "mental_support"
        result["sub_type"] = "critical"

    # 3. 如果是权益咨询，检索法律知识库
    if result["intent"] == "rights_consultation":
        try:
            law_results = law_search(user_input, top_k=3)
            result["law_references"] = law_results
        except Exception as e:
            result["law_references"] = []
            result["law_search_error"] = str(e)

    return result


def main():
    if len(sys.argv) < 2:
        print("用法: python3 intent_router.py '用户输入'")
        return 1

    user_input = sys.argv[1]
    result = route(user_input)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
