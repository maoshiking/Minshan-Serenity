# 岷山守静 · 接口契约（P1）

> 本文档是前端与后端唯一的接口依据。**任何字段变更必须先改本文档再改代码。**
> 状态：P1 草案，待你方后端团队确认可行性后冻结为 v1.0。

---

## 0. 适用范围与分工

| 项 | 约定 |
|---|---|
| 阶段 | P1（空间能站、猫能走、对话能通、环境能感知） |
| 后端实现方 | 你方（自有云服务器） |
| 前端实现方 | 本项目前端 |
| 不在 P1 范围 | RAG 检索详设、识图、规划（Planner）、会话记忆检索、语音 |
| 契约冻结方式 | 字段增删改均记入本文档第 11 节变更记录 |

前端在后端就绪前，按本文档第 10 节的 Mock 数据层开发，接口形态与本文档完全一致，后端上线后**零改动替换**。

---

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 传输协议 | HTTPS |
| 编码 | UTF-8 |
| 路径前缀 | `/api` |
| 前端基址配置 | 环境变量 `VITE_API_BASE_URL`，默认 `/api` |
| 鉴权 | P1 无（非商业化、无账号）。预留 `Authorization: Bearer <token>` 头，后端若启用则前端从 `localStorage.token` 自动注入 |
| 时间格式 | ISO 8601 带时区，如 `2026-10-21T15:20:00+08:00` |
| 距离单位 | 米 |
| 角度单位 | 度 |
| 温度单位 | 摄氏度 |
| 坐标系 | 见第 2 节，**全链路唯一** |

### 1.1 统一响应包装

业务接口统一返回：

```json
{
  "code": 0,
  "data": {},
  "message": ""
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | number | `0` 表示成功，非 0 见第 9 节错误码 |
| `data` | any | 成功时的业务数据；失败时为 `null` |
| `message` | string | 失败时的可读提示，成功时可为空串 |

**例外**：`POST /api/chat` 返回 `text/event-stream`，不使用该包装，见第 7 节。

### 1.2 客户端需处理的错误语义

前端 `src/utils/request.js` 已实现：`code === 0` 解包出 `data`；`code === 401` 清令牌并跳登录；HTTP 层错误归一化为可读文案。后端只需遵守 1.1 与第 9 节。

---

## 2. 坐标与数据约定（最重要的一节）

**这一节定错，地形、点位、路线、镜头、猫的行走路径会全部错位，返工代价最高。**

### 2.1 三层坐标

| 层 | 名称 | 定义 |
|---|---|---|
| L1 | 地理坐标 | WGS84 经纬度 `(lon, lat)`，仅出现在数据生产与服务端 |
| L2 | 局部米制平面坐标 `local` | 以核心区中心为原点的局部切平面，`{ x: 东向米, z: 南向米, y: 相对高度米 }` |
| L3 | Three.js 世界坐标 `world` | 前端唯一使用的坐标，`1 单位 = 1 米`，右手系：`+X = 东`、`+Y = 上`、`+Z = 南`（即 `-Z = 北`） |

### 2.2 投影约定

- L1 → L2 采用**以核心区中心为原点的局部切平面投影**：纬度方向按 `1° ≈ 111320 m`，经度方向按 `1° ≈ 111320 × cos(中心纬度) m`。
- 核心区中心经纬度 `origin` 由后端随地形资产给出，前端不做任何投影计算。
- **禁止**在前端出现第二套坐标换算。前端只做 `local → world` 的加法偏移（如需）。

### 2.3 world ↔ local 换算

```
world.x = local.x
world.y = local.y
world.z = local.z
```

即 P1 阶段两者等价（原点重合，`1 单位 = 1 米`）。保留两套命名是为了后续扩域时（原点迁移、缩放）不必改动字段名。

### 2.4 纵向尺度

| 项 | 约定 |
|---|---|
| 数据层 | **一律真实米值**，元数据中的高程就是真实海拔或真实相对高差 |
| 前端渲染 | 默认 `1:1`（不加夸张）。若观感过陡或过平，由前端在场景层对 `Y` 施加视觉放缩系数，**不写入数据** |
| 元数据字段 | `verticalScale: 1.0`，前端保留但 P1 不做非 1 处理 |

### 2.5 地形网格规格

```json
{
  "id": "shuimo-core",
  "origin": { "lon": 103.xxxx, "lat": 31.xxxx },
  "sizeMeters": { "width": 2000, "height": 2000 },
  "grid": { "cols": 257, "rows": 257, "layout": "row-major" },
  "elevation": { "min": 0.0, "max": 0.0, "unit": "m", "relativeTo": "origin" },
  "heightScale": 1.0,
  "encoding": "rgba16-uint16",
  "files": {
    "height": "/assets/terrain/shuimo-core-height.png",
    "texture": "/assets/terrain/shuimo-core-texture.webp"
  },
  "meta": { "source": "", "license": "", "resolutionMeters": 12.5 }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `origin` | object | 是 | 网格左上角（或中心，**须在此注明**）的经纬度 |
| `sizeMeters` | object | 是 | 覆盖范围的实际米数 |
| `grid` | object | 是 | 行列数；`layout` 固定 `row-major` |
| `elevation` | object | 是 | `min` / `max` 真实高程；`relativeTo` 为 `"origin"` 或 `"seaLevel"` |
| `heightScale` | number | 是 | 解码后的数值需乘的系数，使 `min/max` 落在 `elevation` 区间 |
| `encoding` | string | 是 | P1 固定 `rgba16-uint16`（16 位高程打包进 RGBA） |
| `files.height` | string | 是 | 高程文件路径 |
| `files.texture` | string | 是 | 与高程**严格对齐**的影像纹理路径 |
| `meta.license` | string | 是 | 数据来源与许可，前端会在"关于"页展示 |

**两条硬性要求**：

1. 高程与纹理必须严格对齐，否则会出现"路跑到山脊上"这类错误。
2. 纹理建议 2K（2048）起步，核心区 2×2 公里下 4K 更佳；格式 `webp` 或 `jpg`。

### 2.6 高程自洽验证（交付前必做）

1. 取 3–5 个已确认地标，人工核对 `y` 是否等于该处实际高程。
2. **每个点位的 `world.y` 必须与其所在地形高度一致，容差 0.5 米**（否则猫会浮空或陷地）。
3. 验证方法：前端提供调试模式，把点位渲染为竖直标记线，肉眼确认贴地。

### 2.7 点位与路线的坐标来源

- `GET /api/spots` 直接返回 `world` 坐标，前端不做换算。
- `GET /api/routes/:id` 的 `waypoints` 同样返回 `world` 坐标。
- 路点不需要逐个精确贴地：前端会将路点 `Y` 吸附到地形高度（见 2.6），但**偏差不得超过 0.5 米**，否则吸附后轨迹会跳变。

---

## 3. 数据契约

### 3.1 Coordinate

```json
{ "x": 0.0, "y": 0.0, "z": 0.0 }
```

`x` 东向、`y` 向上（高程）、`z` 南向，单位米，相对核心区原点。

### 3.2 EnvSnapshot

环境快照。**前端与猫共用同一份快照**，避免各处各查一遍导致表现不一致。

```json
{
  "ts": "2026-10-21T15:20:00+08:00",
  "tz": "Asia/Shanghai",
  "time": {
    "hour": 15,
    "minute": 20,
    "dayPhase": "afternoon",
    "solarElevation": 32.5,
    "dayLengthMinutes": 663
  },
  "weather": {
    "text": "晴",
    "code": "clear",
    "temperature": 14.5,
    "feelsLike": 13.0,
    "humidity": 62,
    "windSpeed": 2.4,
    "windDir": 180,
    "visibilityKm": 18.0,
    "cloudCover": 10,
    "precipitation": 0.0,
    "pressure": 812
  },
  "solar": {
    "term": "霜降",
    "season": "autumn",
    "sunrise": "07:31",
    "sunset": "18:33"
  },
  "trend": {
    "next6h": "cloudy",
    "changeHint": "傍晚转阴，能见度下降"
  },
  "source": "mock"
}
```

| 字段 | 类型 | 必填 | 取值 / 说明 |
|---|---|---|---|
| `ts` | string | 是 | 快照生成时间 |
| `time.dayPhase` | string | 是 | `dawn` / `morning` / `noon` / `afternoon` / `dusk` / `night` |
| `time.solarElevation` | number | 是 | 太阳高度角，前端据此定光照强度与入射角 |
| `weather.code` | string | 是 | **枚举见 3.3**，前端据此类推到光影、雾效、猫的行为 |
| `weather.temperature` | number | 是 | 摄氏度 |
| `weather.visibilityKm` | number | 是 | 能见度，前端据此定雾浓度；也是猫"劝不劝人上山"的依据 |
| `weather.cloudCover` | number | 是 | 0–100，影响光比与阴影硬度 |
| `weather.pressure` | number | 否 | 高海拔地区气压有叙事价值（可换算出海拔感） |
| `solar.term` | string | 是 | 二十四节气名，用于猫的台词与场景细节 |
| `solar.season` | string | 是 | `spring` / `summer` / `autumn` / `winter` |
| `trend.changeHint` | string | 否 | 可直接作为猫的台词素材 |
| `source` | string | 是 | `mock` / `real`，前端据此在调试面板标注 |

### 3.3 weather.code 枚举（P1 冻结）

| code | 中文 | 前端预期表现 |
|---|---|---|
| `clear` | 晴 | 硬光、长影、远景清晰 |
| `cloudy` | 多云 | 柔光、阴影淡 |
| `overcast` | 阴 | 灰调、无明显阴影 |
| `rain` | 雨 | 冷调、地面反光、雨丝 |
| `heavyRain` | 大雨 | 冷调加深、能见度骤降 |
| `snow` | 雪 | 高亮低饱和、雪点 |
| `fog` | 雾 | 体积雾、光晕弱、远景不可见 |
| `haze` | 霾 | 低饱和、暖灰、远景灰化 |

新增枚举必须先改本文档，前端未识别的 code 按 `overcast` 兜底处理。

### 3.4 Spot

```json
{
  "id": "spot-demo-01",
  "name": "占位点位",
  "coord": { "x": 120.0, "y": 892.5, "z": -340.0 },
  "hotspotRadius": 12.0,
  "type": "architecture",
  "guideText": "占位导览文案",
  "card": {
    "title": "占位标题",
    "paragraphs": [
      { "text": "占位正文", "source": "待核", "confidence": "pending" }
    ],
    "images": [],
    "tags": []
  },
  "verified": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `coord` | Coordinate | 是 | **world 坐标**，不得是经纬度 |
| `hotspotRadius` | number | 是 | 点击热区半径（米），建议 8–15 |
| `type` | string | 是 | `architecture` / `landscape` / `craft` / `custom` / `folklore`，P1 冻结 |
| `verified` | boolean | 是 | **地名与文化内容是否已审校**。`false` 时前端在卡片上显示"待核"标记，且不参与知识问答 |

`card.paragraphs[].confidence` 取值：`verified` / `pending`。

### 3.5 Route

```json
{
  "id": "route-demo",
  "name": "占位路线",
  "waypoints": [{ "x": 0, "y": 0, "z": 0 }],
  "stops": [{ "spotId": "spot-demo-01", "dwellSeconds": 45 }],
  "durationMinutes": 30,
  "difficulty": "easy"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `waypoints` | Coordinate[] | 猫的行走路径，前端会按地形吸附 `Y` 并做曲线平滑 |
| `stops[].dwellSeconds` | number | 停留讲解时长，猫到点后进入"蹲坐"状态 |
| `difficulty` | string | `easy` / `normal` / `hard`，用于猫的速度与台词倾向 |

---

## 4. `GET /api/health`

**用途**：前后端联调第一件事，也是前端判断"后端是否就绪、Mock 是否该关闭"的依据。

**入参**：无

**响应**：

```json
{
  "code": 0,
  "data": { "status": "ok", "version": "0.1.0", "uptimeSeconds": 3600 },
  "message": ""
}
```

**前端行为**：失败不阻断页面（后端不可用时前端自动切 Mock 数据并在调试面板标注）。

---

## 5. `GET /api/env/snapshot`

**用途**：一次下发环境快照，驱动光影、雾效、猫的行为倾向与台词素材。

**入参**：无（服务端按当前时间与位置生成，并做缓存）

**响应**：`{ code, data: EnvSnapshot, message }`

**缓存建议**：服务端缓存 10 分钟；前端 60 秒轮询一次，页面失焦时暂停轮询。

**P1 说明**：`source` 为 `mock`，由前端可调的模拟参数生成；后端就绪后替换为真实数据，**接口形态不变**。

---

## 6. `GET /api/spots` 与 `GET /api/routes/:id`

### 6.1 `GET /api/spots`

**入参**：无

**响应**：`{ "code": 0, "data": { "spots": [Spot] }, "message": "" }`

**前端行为**：按 `coord` 在地形上生成热区；`verified === false` 的卡片带"待核"标记。

### 6.2 `GET /api/routes/:id`

**入参**：路径参数 `id`

**响应**：`{ "code": 0, "data": Route, "message": "" }`

**不存在时**：`code = 404xx`（见第 9 节）

---

## 7. `POST /api/chat`（SSE 流式）

**这是 P1 最重要的接口。** 前端必须能在等待过程中显示"正在查天气"这类过程态，否则一次多步调用会表现为长时间卡死，体验直接崩。因此**事件类型的设计比文本内容更重要**。

### 7.1 请求

```json
{
  "sessionId": "sess-xxxx",
  "turnId": "turn-0001",
  "input": { "text": "今天上得了山吗", "imageBase64": null, "imageMime": null },
  "context": {
    "env": null,
    "playerCoord": { "x": 0, "y": 0, "z": 0 },
    "nearbySpotIds": ["spot-demo-01"],
    "lastSeenSeq": 0
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sessionId` | string | 是 | 会话标识，前端生成并持久化 |
| `turnId` | string | 是 | 本轮标识，用于幂等与断线续传 |
| `input.text` | string | 否 | 文本输入；与图片至少有一个 |
| `input.imageBase64` | string | 否 | P2 启用识图，P1 传 `null` |
| `context.env` | EnvSnapshot | 否 | 传 `null` 时后端自行读取；传值则以此为准 |
| `context.nearbySpotIds` | string[] | 否 | 玩家附近点位，限 10 个以内 |
| `context.lastSeenSeq` | number | 否 | 断线重连时已接收的最大 `seq` |

**请求头**：`Accept: text/event-stream`

### 7.2 响应

`Content-Type: text/event-stream`，逐条发送：

```
event: <type>
data: <json>

```

**每条事件的 `data` 必含 `seq`（从 1 递增）**。前端遇到 `seq` 跳号说明断流，按第 7.4 节重连。

### 7.3 事件类型（P1 冻结）

| 事件名 | `data` 结构 | 前端表现 |
|---|---|---|
| `session` | `{ seq, sessionId }` | 建立会话，记录 id |
| `text` | `{ seq, delta }` | 追加流式文本 |
| `tool_call` | `{ seq, id, name, label, args }` | 显示"正在查天气…"过程态；`label` 是给用户看的中文名 |
| `tool_result` | `{ seq, id, ok, summary }` | 过程态标记完成或失败；`summary` 为可读摘要，不展示原始数据 |
| `citation` | `{ seq, refs: [{ id, title, source, snippet }] }` | 折叠展示"依据"，可展开原文片段 |
| `env_update` | `{ seq, env: EnvSnapshot }` | 静默更新环境快照并触发光影过渡 |
| `error` | `{ seq, code, message, retryable }` | 显示错误；`retryable` 为真时给出重试按钮 |
| `done` | `{ seq, finishReason }` | 结束本轮；`finishReason` 取值 `stop` / `length` / `error` |

**`tool_call.name` 的 P1 建议枚举**：`weather` / `spot_lookup` / `route_plan` / `time_now` / `knowledge_search`（后两项 P2 生效）。新增工具必须先在本文档登记 `name` 与 `label`。

**示例流**：

```
event: session
data: {"seq":1,"sessionId":"sess-xxxx"}

event: text
data: {"seq":2,"delta":"我先看看这会儿的天。"}

event: tool_call
data: {"seq":3,"id":"call-1","name":"weather","label":"正在查天气","args":{}}

event: tool_result
data: {"seq":4,"id":"call-1","ok":true,"summary":"当前晴，能见度 18 公里"}

event: text
data: {"seq":5,"delta":"今天晴，能见度十八公里，上得了山。"}

event: done
data: {"seq":6,"finishReason":"stop"}
```

### 7.4 断线续传

- 前端记录最大 `seq`；重连时在同路径重发请求，携带 `context.lastSeenSeq`。
- 后端从 `lastSeenSeq + 1` 继续推送；**无法续传时**发送 `error`（`code = 50003`，`retryable = true`），由前端发起新一轮。
- 前端 P1 实现：`EventSource` 不可用于 POST，故使用 `fetch` + `ReadableStream` 手工解析 SSE。

### 7.5 前端解析要求

- 必须逐块拼接缓冲区并按 `\n\n` 切分完整事件，**不得假设一次 `chunk` 等于一条事件**。
- 必须容忍未知事件名（忽略并继续，不得中断整轮对话）。
- 组件卸载时必须 `abort` 请求，避免流泄漏。

---

## 8. 数据资产交付（E1：你方处理后给成品）

| 资产 | 路径建议 | 格式 | 备注 |
|---|---|---|---|
| 高程网格 | `/assets/terrain/*-height.png` | PNG（16 位打包进 RGBA） | 见 2.5 |
| 影像纹理 | `/assets/terrain/*-texture.webp` | WebP / JPG | 与高程严格对齐 |
| 元数据 | 随接口或静态 JSON | 见 2.5 | 必须含 `license` |
| 点位数据 | `/api/spots` | JSON | 坐标为 world |
| 路线数据 | `/api/routes/:id` | JSON | 坐标为 world |

**交付清单**：数据源名称、精度、许可、`origin` 经纬度、实际最低/最高高程、核心区四至边界。

---

## 9. 错误码

| code | HTTP | 含义 | 前端行为 |
|---|---|---|---|
| `0` | 200 | 成功 | 正常 |
| `40001` | 400 | 参数错误 | 提示具体字段 |
| `40100` | 401 | 未授权 / 令牌失效 | 清令牌跳登录 |
| `40300` | 403 | 无权限 | 提示无权限 |
| `40400` | 404 | 资源不存在 | 提示并回退 |
| `42900` | 429 | 触发限流 | 显示重试倒计时 |
| `50000` | 500 | 服务异常 | 通用错误提示 |
| `50001` | 502 | 模型服务不可用 | 提示稍后再试 |
| `50002` | 504 | 模型响应超时 | 提示稍后再试 |
| `50003` | 200 | **SSE 流中断且无法续传** | 以 `error` 事件下发，前端提供重试 |
| `50004` | 400 | 图片格式或大小不被接受（P2） | 提示格式要求 |

前端超时约定：普通请求 15 秒（已实现于 `src/utils/request.js`）；SSE 首包 20 秒、静默 45 秒无事件即判定卡死。

---

## 10. P1 Mock 数据策略

| 项 | 约定 |
|---|---|
| 位置 | `src/api/mock/`，与真实接口同签名 |
| 开关 | 环境变量 `VITE_USE_MOCK`；`/api/health` 失败时自动降级 |
| 环境快照 | 由可调面板生成（天气、昼夜、能见度、节气），形态与 `EnvSnapshot` 完全一致 |
| 对话流 | 本地模拟 SSE：按 `seq` 逐条吐出 `session → text → tool_call → tool_result → text → done`，含 300–800 ms 随机延时，用于验证过程态渲染 |
| 点位/路线 | 占位数据，`verified: false`，**不写死任何真实地名** |
| 标注 | 调试面板常驻显示 `source: mock`，避免误以为已接真实数据 |

**Mock 的意义**：后端由你方实现，没有 Mock 层前端会在等待期间停摆。

---

## 11. 待确认与变更记录

### 11.1 待确认（阻塞契约冻结）

| # | 待确认项 | 影响 |
|---|---|---|
| 1 | 核心区四至边界与 `origin` 经纬度 | 决定所有坐标 |
| 2 | 高程精度与数据源、许可 | 决定山形与能否公开 |
| 3 | 实际最低/最高高程 | 决定 `elevation` 区间与相机裁剪面 |
| 4 | 影像纹理来源与许可 | 决定是否有贴图 |
| 5 | 后端对 SSE 事件类型的可行性确认 | 决定对话过程态能否实现 |
| 6 | 路线数据由谁提供（地名清单未到前无法产出） | 决定猫的行走路径 |

### 11.2 变更记录

| 日期 | 版本 | 变更 | 提出方 |
|---|---|---|---|
| 2026-10-21 | 0.1 草案 | 初稿，P1 范围冻结 | 前端 |

---

## 附：本文档与代码的对应关系

| 契约内容 | 代码位置 |
|---|---|
| 统一响应包装与错误归一化 | `src/utils/request.js` |
| 接口函数 | `src/api/` |
| 环境快照与光影联动 | `src/composables/`（P1 新增） |
| SSE 解析 | `src/composables/useChatStream.js`（P1 新增） |
| 猫的状态机与行走 | `src/composables/useGuideCat.js`（P1 新增） |
| 地形加载与坐标约定 | `src/composables/useTerrain.js`（P1 新增） |
