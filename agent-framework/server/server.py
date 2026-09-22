#!/usr/bin/env python3
"""
工友管家 — 后端 API 服务

架构：安卓 App (WebView) → FastAPI → DeepSeek API（回复生成）+ 本地法律知识库（RAG 注入）

启动：python server.py
需要环境变量：DEEPSEEK_API_KEY
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ========== 配置 ==========

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1/chat/completions"
KNOWLEDGE_BASE_DIR = Path(__file__).parent.parent / "law-knowledge-base"

# 腾讯云 ASR（闽南话/方言识别）。未配置时接口返回友好提示，不影响其他功能。
TENCENT_SECRET_ID = os.environ.get("TENCENT_SECRET_ID", "")
TENCENT_SECRET_KEY = os.environ.get("TENCENT_SECRET_KEY", "")
# 16k_zh_en 大模型支持闽南语；普通话仍使用低延迟的一句话识别。
TENCENT_ASR_ENGINE = os.environ.get("TENCENT_ASR_ENGINE", "16k_zh_en")
_requested_minnan_engine = os.environ.get("TENCENT_ASR_MINNAN_ENGINE", "16k_zh_en")
_minnan_engines = {"16k_zh_en", "16k_zh_en_2.0"}
TENCENT_ASR_MINNAN_ENGINE = (
    _requested_minnan_engine
    if _requested_minnan_engine in _minnan_engines
    else "16k_zh_en"
)
_requested_hakka_engine = os.environ.get("TENCENT_ASR_HAKKA_ENGINE", TENCENT_ASR_MINNAN_ENGINE)
TENCENT_ASR_HAKKA_ENGINE = _requested_hakka_engine if _requested_hakka_engine in _minnan_engines else "16k_zh_en"

app = FastAPI(title="工友管家 API", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 静态资源：安全教育视频 / 上传的存证图片
VIDEOS_DIR = Path(__file__).parent.parent / "videos"
UPLOADS_DIR = Path(__file__).parent.parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)
if VIDEOS_DIR.exists():
    app.mount("/videos", StaticFiles(directory=str(VIDEOS_DIR)), name="videos")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

# ========== 系统提示词 ==========

SYSTEM_PROMPT = """你是「工友管家」，一个专门服务一线建筑工人的AI智能助手。

## 回复风格
1. 说人话：不要直接复制法律条文原文，先用一句话总结，再用生活例子解释。
2. 短句为主：每句不超过20个字。不用"综上所述"等公文用语。
3. 口语化：用"你"不用"您"。称呼工友为"工友"。
4. 主动关心：工友提到困难先表达理解，再给建议。

## 回复结构
1. 共情开头（一句话）
2. 核心回答（1-3句）
3. 分步指引（第一步…第二步…每步具体到打什么电话找什么人）
4. 如有法条依据，注明"依据法条：《法规名》第X条：内容"

## 安全红线
1. 不编造法条：如果参考材料中没有相关法条，说"这条我不确定，建议找项目法务确认"。
2. 不做心理诊断：不说"你可能得了抑郁症"。高危情况建议拨打12320-5。
3. 不替工友做决定。给建议但让工友自己选。
4. 不承诺结果：用"有可能""你可以试试"。

## 转接规则
- 拖欠工资超3月协商无果 → 建议转接项目法务
- 工伤未做认定 → 建议转接项目HR
- 检测到自残/自杀关键词 → 立即建议拨打心理热线12320-5
- 金额超5万 → 建议转接法务"""

# ========== 法律知识库检索 ==========

def load_knowledge_segments():
    """加载知识库并分段"""
    segments = []
    for md_file in sorted(KNOWLEDGE_BASE_DIR.glob("*.md")):
        if md_file.name == "README.md":
            continue
        content = md_file.read_text(encoding="utf-8")
        parts = re.split(r"\n---\n", content)
        for i, part in enumerate(parts):
            part = part.strip()
            if len(part) < 20:
                continue
            segments.append({
                "source": md_file.name,
                "content": part,
            })
    return segments


KNOWLEDGE_SEGMENTS = load_knowledge_segments()

SYNONYM_MAP = {
    "欠薪": ["拖欠", "不发工资", "克扣", "工资"],
    "拖欠": ["欠薪", "不发", "克扣"],
    "工资": ["欠薪", "拖欠", "报酬"],
    "工伤": ["受伤", "伤残", "事故", "医疗"],
    "合同": ["劳动合同", "签约", "签合同"],
    "社保": ["社会保险", "五险", "保险"],
    "辞退": ["解除", "清退", "开除", "走人"],
    "加班": ["延长工作时间", "加点"],
    "赔偿": ["补偿", "赔偿金", "经济补偿"],
    "试用期": ["试用", "试工"],
    "身份证": ["证件", "扣押"],
    "高温": ["防暑", "降温", "中暑"],
    "产假": ["怀孕", "生育", "哺乳", "女工"],
    "仲裁": ["劳动仲裁", "仲裁委"],
    "包工头": ["分包", "包工", "跑路"],
}


def search_law_knowledge(query: str, top_k: int = 3) -> list[dict]:
    """关键词匹配检索法律知识库"""
    keywords = set()
    for word in re.split(r"[\s，。？?！!、的了怎么办怎样如何]", query):
        word = word.strip()
        if len(word) >= 2:
            keywords.add(word)

    expanded = set(keywords)
    for kw in list(keywords):
        if kw in SYNONYM_MAP:
            for syn in SYNONYM_MAP[kw]:
                expanded.add(syn)

    results = []
    for seg in KNOWLEDGE_SEGMENTS:
        score = 0
        for kw in expanded:
            count = seg["content"].count(kw)
            if count > 0:
                score += count
        if score > 0:
            results.append({"score": score, "source": seg["source"], "content": seg["content"][:1500]})

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]


# ========== 腾讯云 ASR（一句话识别，TC3-HMAC-SHA256 签名） ==========

import base64
import hashlib
import hmac
import time


def _tc3_sign(secret_key: str, date: str, service: str, string_to_sign: str) -> str:
    def _hmac_sha256(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    secret_date = _hmac_sha256(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac_sha256(secret_date, service)
    secret_signing = _hmac_sha256(secret_service, "tc3_request")
    return hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()


async def tencent_asr_sentence(audio_bytes: bytes, voice_format: str = "wav", lang: str = "minnan") -> str:
    """腾讯云一句话识别，供普通话模式使用。"""
    import datetime as _dt

    engine = "16k_zh"
    payload_dict = {
        "ProjectId": 0,
        "SubServiceType": 2,
        "EngSerViceType": engine,
        "SourceType": 1,
        "VoiceFormat": voice_format,
        "UsrAudioKey": "gygj-asr",
        "Data": base64.b64encode(audio_bytes).decode("utf-8"),
        "DataLen": len(audio_bytes),
    }
    data = await _tencent_asr_request("SentenceRecognition", payload_dict)
    return data.get("Response", {}).get("Result", "")


async def _tencent_asr_request(action: str, payload_dict: dict) -> dict:
    """发送一个使用 TC3-HMAC-SHA256 签名的腾讯云 ASR 请求。"""
    import datetime as _dt
    host = "asr.tencentcloudapi.com"
    service = "asr"
    version = "2019-06-14"
    timestamp = int(time.time())
    date = _dt.datetime.utcfromtimestamp(timestamp).strftime("%Y-%m-%d")

    payload = json.dumps(payload_dict, separators=(",", ":"))

    http_request_method = "POST"
    canonical_uri = "/"
    canonical_querystring = ""
    canonical_headers = f"content-type:application/json\nhost:{host}\n"
    signed_headers = "content-type;host"
    hashed_request_payload = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    canonical_request = (
        f"{http_request_method}\n{canonical_uri}\n{canonical_querystring}\n"
        f"{canonical_headers}\n{signed_headers}\n{hashed_request_payload}"
    )

    algorithm = "TC3-HMAC-SHA256"
    credential_scope = f"{date}/{service}/tc3_request"
    hashed_canonical_request = hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
    string_to_sign = f"{algorithm}\n{timestamp}\n{credential_scope}\n{hashed_canonical_request}"

    signature = _tc3_sign(TENCENT_SECRET_KEY, date, service, string_to_sign)
    authorization = (
        f"{algorithm} Credential={TENCENT_SECRET_ID}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    headers = {
        "Authorization": authorization,
        "Content-Type": "application/json",
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Timestamp": str(timestamp),
        "X-TC-Version": version,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"https://{host}", headers=headers, content=payload)
        data = resp.json()

    response = data.get("Response", {})
    if "Error" in response:
        err = response["Error"]
        raise RuntimeError(f"{err.get('Code')}: {err.get('Message')}")
    return data


async def tencent_asr_dialect(audio_bytes: bytes, voice_format: str = "wav", lang: str = "minnan") -> str:
    """使用支持闽南语和客家话的多方言模型，并轮询任务结果。"""
    import asyncio

    create_payload = {
        "EngineModelType": TENCENT_ASR_HAKKA_ENGINE if lang == "hakka" else TENCENT_ASR_MINNAN_ENGINE,
        "ChannelNum": 1,
        "ResTextFormat": 0,
        "SourceType": 1,
        "Data": base64.b64encode(audio_bytes).decode("utf-8"),
        "DataLen": len(audio_bytes),
    }
    created = await _tencent_asr_request("CreateRecTask", create_payload)
    task_id = created.get("Response", {}).get("Data", {}).get("TaskId")
    if not task_id:
        raise RuntimeError("CreateRecTask: missing TaskId")

    for _ in range(40):
        await asyncio.sleep(0.5)
        status_data = await _tencent_asr_request("DescribeTaskStatus", {"TaskId": task_id})
        task = status_data.get("Response", {}).get("Data", {})
        status = task.get("Status")
        if status == 2:
            result = task.get("Result", "")
            return re.sub(r"^\[\d+:[\d.]+,\d+:[\d.]+\]\s*", "", result, flags=re.MULTILINE).strip()
        if status == 3:
            raise RuntimeError(task.get("ErrorMsg") or task.get("StatusStr") or "recognition failed")

    raise RuntimeError("DescribeTaskStatus: timeout")


# ========== 心理安全检测 ==========

CRITICAL_KEYWORDS = ["不想活", "活不下去", "想死", "自杀", "了结", "跳楼", "割腕"]
WARNING_KEYWORDS = ["没意思", "没意义", "撑不下去", "不想撑了", "活着太累"]


def check_mental_safety(text: str) -> str:
    if any(kw in text for kw in CRITICAL_KEYWORDS):
        return "critical"
    if any(kw in text for kw in WARNING_KEYWORDS):
        return "warning"
    return "normal"


# ========== DeepSeek API 调用 ==========

async def call_deepseek(messages: list[dict], temperature: float = 0.7) -> str:
    """调用 DeepSeek API 生成回复"""
    if not DEEPSEEK_API_KEY:
        return "【未配置 DEEPSEEK_API_KEY】请在环境变量中设置后重启服务。"

    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "deepseek-chat",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 2000,
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(DEEPSEEK_BASE_URL, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


# ========== API 接口 ==========

class ChatRequest(BaseModel):
    message: str
    screen: str = "rights"  # rights / mental / tools / home
    user_id: str = "default_user"


@app.get("/api/health")
async def health():
    return {"status": "ok", "knowledge_segments": len(KNOWLEDGE_SEGMENTS), "api_key_configured": bool(DEEPSEEK_API_KEY)}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """核心对话接口：App 发消息，返回 AI 回复"""
    user_message = req.message
    mental_level = check_mental_safety(user_message)

    # 构建消息列表
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # 心理危机优先处理
    if mental_level == "critical":
        messages.append({"role": "user", "content": user_message})
        messages.append({"role": "system", "content": "检测到工友可能有自残/自杀倾向。请立即表达关心，建议拨打心理援助热线12320-5。语气要温暖、真诚。"})
        reply_text = await call_deepseek(messages, temperature=0.5)
        return {
            "reply": reply_text,
            "intent": "mental_crisis",
            "law_refs": [],
            "transfer": {"target": "psych_hotline", "title": "建议立即拨打心理援助热线", "sub": "12320-5 · 24小时免费", "btn": "拨打"},
        }

    # 权益咨询：检索法律知识库作为上下文
    law_results = search_law_knowledge(user_message)
    if law_results:
        context = "\n\n---\n\n".join([f"[参考材料-{i+1}] 来源：{r['source']}\n{r['content']}" for i, r in enumerate(law_results)])
        context_instruction = f"以下是相关法律知识库参考材料，请基于这些材料回答工友的问题。如果材料中没有直接相关的内容，告诉工友你不太确定，建议找项目法务确认。不要编造法条。\n\n{context}"
        messages.append({"role": "system", "content": context_instruction})

    messages.append({"role": "user", "content": user_message})

    # 如果在暖心树洞页面
    if req.screen == "mental":
        messages.append({"role": "system", "content": "工友在暖心树洞页面，请以心理陪伴的方式回应。先倾听共情，不急于给方案。不要做诊断。"})
    elif law_results:
        messages.append({"role": "system", "content": "请在回答末尾标注引用的法条来源，格式：依据法条：《法规名》第X条：内容。如果情况复杂（拖欠超3月、工伤未认定、金额超5万），在回复末尾加上'建议转接项目法务/HR'的提示。"})

    try:
        reply_text = await call_deepseek(messages, temperature=0.7)
    except Exception as e:
        reply_text = f"抱歉，我这边出了点问题，稍等再试一下。（错误：{str(e)[:100]}）"

    # 判断是否需要转接
    transfer = None
    if any(kw in user_message for kw in ["拖欠", "欠薪", "不发工资"]) and "三个月" in user_message or "3个月" in user_message:
        transfer = {"target": "legal", "title": "情况复杂，建议联系项目法务", "sub": "我来帮你转接人工服务", "btn": "转接"}
    elif any(kw in user_message for kw in ["工伤", "受伤"]) and "认定" in user_message:
        transfer = {"target": "hr", "title": "工伤认定需要走流程，建议联系项目HR", "sub": "我来帮你转接", "btn": "转接"}

    return {
        "reply": reply_text,
        "intent": "rights_consultation" if law_results else "chitchat",
        "law_refs": [{"source": r["source"]} for r in law_results],
        "transfer": transfer,
    }


class AsrRequest(BaseModel):
    audio_base64: str
    format: str = "wav"
    lang: str = "minnan"


@app.post("/api/asr")
async def asr(req: AsrRequest):
    """语音识别（闽南话/方言）：App 上传 WAV base64，返回识别文本"""
    if not TENCENT_SECRET_ID or not TENCENT_SECRET_KEY:
        return {
            "text": "",
            "error": "方言识别还没配好密钥，先用普通话模式或者打字试试。",
        }

    try:
        audio_bytes = base64.b64decode(req.audio_base64)
    except Exception:
        return {"text": "", "error": "音频数据有问题，再录一遍试试。"}

    if len(audio_bytes) < 2000:
        return {"text": "", "error": "说话时间太短了，按住多说一会儿。"}
    if len(audio_bytes) > 2 * 1024 * 1024:
        return {"text": "", "error": "录音太长了，一句话说完就行。"}

    lang = (req.lang or "").strip().lower()
    if lang in {"minnan", "hokkien", "nan"}:
        lang = "minnan"
    elif lang in {"hakka", "hak", "kejia"}:
        lang = "hakka"
    elif lang in {"mandarin", "zh", "zh-cn"}:
        lang = "mandarin"
    else:
        return {"text": "", "error": "不支持的语音模式，请重新选择普通话、闽南话或客家话。"}

    try:
        if lang in {"minnan", "hakka"}:
            text = await tencent_asr_dialect(audio_bytes, req.format, lang)
        else:
            text = await tencent_asr_sentence(audio_bytes, req.format, lang)
    except Exception as e:
        error_text = str(e)
        if "UserHasNoAmount" in error_text or "Resource pack exhausted" in error_text:
            return {
                "text": "",
                "error": "腾讯云语音识别额度已用完，请充值或购买语音识别资源包后再试。",
            }
        return {"text": "", "error": f"识别服务出了点问题（{error_text[:60]}），稍等再试。"}

    if not text:
        return {"text": "", "error": "没听清，麻烦再说一遍。"}
    engine = {"minnan": TENCENT_ASR_MINNAN_ENGINE, "hakka": TENCENT_ASR_HAKKA_ENGINE}.get(lang, "16k_zh")
    return {"text": text, "error": "", "mode": lang, "engine": engine}


@app.post("/api/asr/minnan")
async def asr_minnan(req: AsrRequest):
    """闽南话专用入口，强制使用闽南话模型，避免客户端降级到普通话。"""
    forced_req = AsrRequest(
        audio_base64=req.audio_base64,
        format=req.format,
        lang="minnan",
    )
    return await asr(forced_req)


@app.post("/api/asr/hakka")
async def asr_hakka(req: AsrRequest):
    """客家话入口，固定使用已确认支持客家话的多方言模型。"""
    return await asr(AsrRequest(audio_base64=req.audio_base64, format=req.format, lang="hakka"))


class ImageUploadRequest(BaseModel):
    image_base64: str
    user_id: str = "default_user"
    note: str = ""  # 工友备注（比如"这是工资条"）


@app.post("/api/upload-image")
async def upload_image(req: ImageUploadRequest):
    """上传图片存证（工资条/合同/考勤记录等）"""
    try:
        img_bytes = base64.b64decode(req.image_base64.split(",")[-1])
    except Exception:
        return {"ok": False, "reply": "图片数据有问题，再传一次试试。"}

    if len(img_bytes) > 10 * 1024 * 1024:
        return {"ok": False, "reply": "图片太大了，截个图再传试试。"}

    import datetime as _dt
    fname = f"{req.user_id}_{_dt.datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg"
    (UPLOADS_DIR / fname).write_bytes(img_bytes)

    # 让 AI 生成一句存证建议
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"我刚上传了一张图片存证{f'（{req.note}）' if req.note else ''}。请用一两句话告诉我：1.证据已经帮我存好了 2.这类证据维权时有什么用 3.建议我还收集什么证据。语气要亲切，像朋友说话。"},
    ]
    try:
        reply = await call_deepseek(messages, temperature=0.6)
    except Exception:
        reply = "图片已经帮你存好了。这类证据维权的时候用得上，建议把工资条、考勤记录、和老板的聊天记录都留好。"

    return {"ok": True, "filename": fname, "reply": reply}


@app.get("/api/safety")
async def safety_tip():
    """获取今日安全微课"""
    import datetime
    today = datetime.datetime.now().weekday()
    safety_data = [
        {"topic": "高空作业", "title": "高空作业三件宝", "content": "安全带要系牢、安全帽要戴正、安全网要到位。", "tip": "酒后不登高，登高必系带"},
        {"topic": "用电安全", "title": "工地用电五不要", "content": "不私接电线、不湿手碰开关、不用破损插头、不超负荷用电、不带电维修。", "tip": "湿手不碰开关，私接电线危险"},
        {"topic": "防护装备", "title": "上岗必戴三样东西", "content": "安全帽保护头部、护目镜保护眼睛、防滑鞋防止摔倒。不戴不上岗。", "tip": "不戴不上岗，上岗必戴齐"},
        {"topic": "机械操作", "title": "机械操作四原则", "content": "持证上岗、开机前检查、不停机清理、异常即停机。", "tip": "不停机清理，异常即停机"},
        {"topic": "消防安全", "title": "工地消防须知", "content": "不乱扔烟头、知道灭火器在哪、不在宿舍用大功率电器。", "tip": "烟头不乱扔，灭火器要会用"},
        {"topic": "防暑防寒", "title": "夏天多喝水冬天防冻", "content": "夏天备藿香正气水、多喝水。冬天穿防寒服、防冻伤、防滑。", "tip": "夏天防中暑，冬天防冻伤"},
        {"topic": "心理健康", "title": "遇事别憋着", "content": "压力大找人聊聊、给家人打电话、工友管家随时在。心里难受不是丢人的事。", "tip": "遇事别憋着，找人聊聊"},
    ]
    return safety_data[today]


if __name__ == "__main__":
    import uvicorn
    print(f"知识库已加载：{len(KNOWLEDGE_SEGMENTS)} 条分段")
    print(f"DeepSeek API Key：{'已配置' if DEEPSEEK_API_KEY else '未配置（请设置 DEEPSEEK_API_KEY 环境变量）'}")
    print("启动服务：http://127.0.0.1:8000")
    print("API 文档：http://127.0.0.1:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000)
