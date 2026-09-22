# 工友管家 — API 接口定义

安卓客户端与 WorkBuddy Agent 之间的通信接口。

---

## 1. 对话接口

### POST /api/chat

发送用户消息，获取 AI 回复。

**请求**
```json
{
  "user_id": "dev_abc123",
  "session_id": "session_xxx",
  "message": {
    "type": "text|voice|image",
    "content": "老板三个月没发工资了",
    "audio_url": null,
    "image_url": null
  },
  "context": {
    "current_screen": "home|rights|mental|tools",
    "mood_selected": null
  }
}
```

**响应**
```json
{
  "reply": {
    "text": "拖了三个月，这搁谁身上都着急...",
    "voice_url": "https://...",
    "cards": [
      {
        "type": "law_reference",
        "title": "依据法条",
        "content": "《保障农民工工资支付条例》第三十条：..."
      },
      {
        "type": "transfer",
        "title": "需要转接",
        "subtitle": "情况复杂，建议联系项目法务",
        "button_text": "转接",
        "transfer_target": "legal"
      }
    ]
  },
  "intent": "rights_consultation",
  "memory_updated": true,
  "order_id": "WO_20260805_001"
}
```

---

## 2. 语音接口

### POST /api/asr

上传语音文件，返回文字。

**请求**
```
Content-Type: multipart/form-data
file: audio.amr
user_id: dev_abc123
```

**响应**
```json
{
  "text": "老板三个月没发工资了",
  "confidence": 0.95
}
```

### POST /api/tts

将文字转为语音。

**请求**
```json
{
  "text": "拖了三个月，这搁谁身上都着急...",
  "voice": "male_warm"
}
```

**响应**
```json
{
  "audio_url": "https://...",
  "duration": 5.2
}
```

---

## 3. 图片识别接口

### POST /api/ocr

上传图片，返回识别结果。

**请求**
```
Content-Type: multipart/form-data
file: image.jpg
type: wage_slip|contract|other
user_id: dev_abc123
```

**响应**
```json
{
  "type": "wage_slip",
  "fields": {
    "worker_name": "张三",
    "period": "2026-05",
    "amount": 8500,
    "status": "未支付"
  },
  "text": "工资条原始文字..."
}
```

---

## 4. 记忆接口

### GET /api/profile/:user_id

获取工友档案。

**响应**
```json
{
  "user_id": "dev_abc123",
  "nickname": "张三",
  "trade": "钢筋工",
  "entry_date": "2025-03",
  "project_site": "XX项目一期",
  "mood_status": "normal",
  "consult_summary": "2026-08-05咨询工资拖欠...",
  "last_active": "2026-08-05T22:00:00"
}
```

### PUT /api/profile/:user_id

更新工友档案（首次注册或信息变更时）。

**请求**
```json
{
  "nickname": "张三",
  "trade": "钢筋工",
  "entry_date": "2025-03",
  "project_site": "XX项目一期",
  "emergency_contact": "13800138000"
}
```

### GET /api/orders/:user_id

获取工友历史工单列表。

**响应**
```json
{
  "orders": [
    {
      "order_id": "WO_20260805_001",
      "category": "rights",
      "question": "老板三个月没发工资了",
      "created_at": "2026-08-05T22:00:00",
      "transferred": true
    }
  ]
}
```

---

## 5. 便民工具接口

### POST /api/repair

提交宿舍报修。

```json
{
  "user_id": "dev_abc123",
  "dorm_number": "3号楼205",
  "type": "水电",
  "description": "水管漏水"
}
```

### POST /api/feedback

提交食堂反馈。

```json
{
  "user_id": "dev_abc123",
  "rating": "差",
  "issue": "分量少",
  "description": "今天的菜分量比以前少"
}
```

### GET /api/bus

获取班车时刻表。

```json
{
  "routes": [
    {"route_name": "工地→火车站", "departure_time": "18:30"},
    {"route_name": "工地→市中心", "departure_time": "19:00"},
    {"route_name": "工地→工人宿舍", "departure_time": "20:30"}
  ]
}
```

### GET /api/safety

获取今日安全微课。

```json
{
  "day": "wednesday",
  "topic": "防护装备",
  "title": "上岗必戴三样东西",
  "content": "安全帽保护头部...",
  "tip": "不戴不上岗，上岗必戴齐"
}
```

---

## 6. 转接接口

### POST /api/transfer

触发转接。

```json
{
  "user_id": "dev_abc123",
  "target": "legal|hr|psych_hotline",
  "reason": "拖欠工资超3月协商无果",
  "order_id": "WO_20260805_001"
}
```

**响应**
```json
{
  "transfer_id": "TR_001",
  "status": "pending",
  "estimated_wait": "5分钟"
}
```

---

## 7. 卡片类型定义

客户端根据 `cards` 数组渲染对应卡片。

| type | 说明 | UI 对应 |
|------|------|---------|
| law_reference | 法条引用卡片 | 橙色背景，显示法条名称和内容 |
| transfer | 转接卡片 | 浅橙背景，含转接按钮 |
| mood_selector | 心情选择器 | 四个圆形表情按钮 |
| bus_info | 班车信息卡片 | 列表显示路线和时间 |
| safety_tip | 安全提示卡片 | 绿色背景，显示安全知识 |
| service_confirm | 服务确认卡片 | 显示"已登记报修/反馈" |

---

## 8. 错误码

| code | 说明 |
|------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未认证（user_id 无效） |
| 404 | 资源不存在 |
| 500 | 服务端错误 |
| 503 | 服务暂不可用（如 ASR 超时） |