# 工友管家 — 数据结构定义

借鉴 shujuku 长期记忆架构，在 WorkBuddy 环境中实现等效机制。

---

## 1. 工友档案表（worker_profile）

对应 shujuku 的"表格数据持久化"机制——工友的基本信息持久化存储，跨会话恢复。

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| user_id | string | 是 | 用户唯一标识（设备ID或手机号） | "dev_abc123" |
| nickname | string | 否 | 工友称呼 | "张三" |
| trade | string | 否 | 工种 | 钢筋工/木工/泥瓦工/电工/焊工/架子工/其他 |
| entry_date | string | 否 | 入职日期 YYYY-MM | "2025-03" |
| project_site | string | 否 | 所在项目工地 | "XX项目一期" |
| emergency_contact | string | 否 | 紧急联系人 | "13800138000" |
| mood_status | string | 否 | 情绪状态 | normal/watching/critical |
| consult_summary | text | 否 | 历史咨询摘要（自动生成） | "2026-08-05咨询工资拖欠，已建议拨打12333" |
| last_active | datetime | 否 | 最后活跃时间 | "2026-08-05T22:00:00" |
| created_at | datetime | 是 | 首次使用时间 | "2026-08-05T21:00:00" |

### 情绪状态流转

```
normal → watching（连续2次提到压力/累/烦） → critical（出现高危关键词）
                                              │
                                              └─ 转接后重置为 normal
```

---

## 2. 工单记录表（work_order）

对应 shujuku 的"工单记录"——每次咨询的完整记录，用于后续查询和统计。

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| order_id | string | 是 | 工单唯一ID（自动生成） | "WO_20260805_001" |
| user_id | string | 是 | 关联工友 | "dev_abc123" |
| category | string | 是 | 问题类型 | rights/mental/tools/safety |
| sub_category | string | 否 | 子类型 | wages/injury/contract/homesick/repair/bus |
| question | text | 是 | 用户问题原文 | "老板三个月没发工资了" |
| question_detail | json | 否 | 提取的结构化信息 | {"duration":"3月","amount":null,"negotiated":false} |
| ai_reply | text | 是 | AI回复摘要 | "建议拨打12333投诉，并附法条引用" |
| law_refs | json | 否 | 引用的法条列表 | [{"title":"保障农民工工资支付条例","article":"第三十条"}] |
| transferred | boolean | 否 | 是否转接 | true/false |
| transfer_target | string | 否 | 转接目标 | HR/legal/psych_hotline |
| mood_level | string | 否 | 情绪级别（心理陪伴时） | normal/warning/critical |
| created_at | datetime | 是 | 记录时间 | "2026-08-05T22:00:00" |

---

## 3. 记忆流转机制（借鉴 shujuku）

### 3.1 对话开始时 — 档案注入（对应 shujuku 世界书注入）

```json
{
  "action": "inject_context",
  "source": "worker_profile",
  "query": {"user_id": "当前用户ID"},
  "inject_to": "system_prompt",
  "format": "[工友档案]\n姓名：{nickname}\n工种：{trade}\n入职：{entry_date}\n工地：{project_site}\n历史咨询：{consult_summary}\n情绪状态：{mood_status}"
}
```

### 3.2 对话进行中 — 多轮上下文（对应 shujuku getStoryContext）

```json
{
  "action": "get_context",
  "turns": 10,
  "type": "all_messages"
}
```

保留最近10轮对话，支持工友的连续追问模式。

### 3.3 对话结束后 — 摘要写入（对应 shujuku callAI）

```json
{
  "action": "summarize_and_store",
  "steps": [
    "LLM生成本轮摘要（用户问了什么、AI怎么回答的、是否转接）",
    "写入 work_order 表",
    "更新 worker_profile 的 consult_summary 字段",
    "更新 worker_profile 的 mood_status（如心理陪伴）",
    "更新 worker_profile 的 last_active 时间"
  ]
}
```

### 3.4 数据隔离（对应 shujuku 数据隔离）

不同工友的档案通过 `user_id` 隔离，查询时必须带 user_id 条件。

---

## 4. 报修/反馈工单表（service_ticket）

便民工具生成的服务工单。

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| ticket_id | string | 是 | 工单ID | "ST_20260805_001" |
| user_id | string | 是 | 关联工友 | "dev_abc123" |
| type | string | 是 | 工单类型 | repair/feedback/bus_query/safety |
| subtype | string | 否 | 子类型 | 水电/门窗/食堂/班车 |
| dorm_number | string | 否 | 宿舍号（报修用） | "3号楼205" |
| description | text | 是 | 详细描述 | "水管漏水" |
| status | string | 否 | 处理状态 | pending/processing/done |
| created_at | datetime | 是 | 创建时间 | "2026-08-05T22:00:00" |

---

## 5. 班车时刻表（bus_schedule）

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| route_id | string | 路线ID | "R001" |
| route_name | string | 路线名称 | "工地→火车站" |
| departure_time | string | 发车时间 | "18:30" |
| frequency | string | 班次说明 | "每日" |
| note | string | 备注 | "末班车20:30" |

### 预置数据

```json
[
  {"route_name": "工地→火车站", "departure_time": "18:30", "frequency": "每日"},
  {"route_name": "工地→市中心", "departure_time": "19:00", "frequency": "每日"},
  {"route_name": "工地→工人宿舍", "departure_time": "20:30", "frequency": "每日"}
]
```

---

## 6. 安全教育内容库（safety_content）

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| day_of_week | string | 星期几 | monday/tuesday/... |
| topic | string | 话题 | 高空作业/用电安全/... |
| title | string | 标题 | "高空作业三件宝" |
| content | text | 内容 | "安全带、安全帽、安全网..." |
| tip | string | 一句话提示 | "酒后不登高，登高必系带" |

### 预置内容

```json
[
  {"day":"monday","topic":"高空作业","title":"高空作业三件宝","content":"安全带要系牢、安全帽要戴正、安全网要到位。酒后不登高，登高必系带。","tip":"酒后不登高，登高必系带"},
  {"day":"tuesday","topic":"用电安全","title":"工地用电五不要","content":"不私接电线、不湿手碰开关、不用破损插头、不超负荷用电、不带电维修。","tip":"湿手不碰开关，私接电线危险"},
  {"day":"wednesday","topic":"防护装备","title":"上岗必戴三样东西","content":"安全帽保护头部、护目镜保护眼睛、防滑鞋防止摔倒。不戴不上岗。","tip":"不戴不上岗，上岗必戴齐"},
  {"day":"thursday","topic":"机械操作","title":"机械操作四原则","content":"持证上岗、开机前检查、不停机清理、异常即停机。","tip":"不停机清理，异常即停机"},
  {"day":"friday","topic":"消防安全","title":"工地消防须知","content":"不乱扔烟头、知道灭火器在哪、不在宿舍用大功率电器、会报火警119。","tip":"烟头不乱扔，灭火器要会用"},
  {"day":"saturday","topic":"防暑防寒","title":"夏天多喝水冬天防冻","content":"夏天备藿香正气水、多喝水、避开中午高温作业。冬天穿防寒服、防冻伤、防滑。","tip":"夏天防中暑，冬天防冻伤"},
  {"day":"sunday","topic":"心理健康","title":"遇事别憋着","content":"压力大找人聊聊、给家人打电话、工友管家随时在。心里难受不是丢人的事。","tip":"遇事别憋着，找人聊聊"}
]
```