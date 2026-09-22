# 1Panel 部署

## 1. 上传文件

把整个 `agent-framework` 目录上传到服务器，例如：

`/opt/gongyou-api`

目录中要包含 `Dockerfile`、`docker-compose.yml`、`requirements.txt`、`server`、`law-knowledge-base` 和 `videos`。

## 2. 创建环境变量

在服务器目录中复制 `.env.example` 为 `.env`，填写真实密钥：

```env
DEEPSEEK_API_KEY=你的DeepSeek密钥
TENCENT_SECRET_ID=你的腾讯云SecretId
TENCENT_SECRET_KEY=你的腾讯云SecretKey
TENCENT_ASR_ENGINE=16k_zh_en
TENCENT_ASR_MINNAN_ENGINE=16k_zh_en
TENCENT_ASR_HAKKA_ENGINE=16k_zh_en
```

## 3. 在 1Panel 启动

进入「容器」→「编排」→「创建编排」，选择 `/opt/gongyou-api/docker-compose.yml`，点击创建并启动。

查看日志，看到 Uvicorn 在 `0.0.0.0:8000` 监听即可。

## 4. 验证

浏览器打开：

`http://服务器公网IP:8000/api/health`

应返回 `status: ok`。

## 4.1 验证闽南话入口

打开：

`http://服务器公网IP:8000/openapi.json`

确认内容中包含 `/api/asr/minnan`。如果返回 404 或找不到这个路径，说明容器仍在运行旧镜像，需要执行“重新构建并部署”，不能只重启容器。

## 4.2 客家话识别

新版服务增加 `POST /api/asr/hakka`，普通 `/api/asr` 也接受 `lang: hakka`。
默认复用支持客家话的 `16k_zh_en` 多方言模型，`TENCENT_ASR_HAKKA_ENGINE` 可设为 `16k_zh_en` 或 `16k_zh_en_2.0`。
无需更换腾讯云账号或密钥。普通话继续使用 `16k_zh` 一句话识别。

APK 2.3.0 优先请求客家话入口；只有服务器返回 404 时，才通过旧 `/api/asr/minnan` 入口调用同一个多方言模型。
客户端会检查返回的引擎类型，不会把普通话专用模型的结果冒充客家话识别。没有真实客家话录音时，不应声称已验证口音准确率。

官方依据：腾讯云产品功能 https://cloud.tencent.com/document/product/1093/35682
及录音文件识别接口 https://cloud.tencent.com/document/product/1093/37823 。

服务更新后可在 `openapi.json` 中确认 `/api/asr/hakka` 已存在。

## 5. 配置域名和 HTTPS

在 1Panel「网站」中创建反向代理，代理到：

`127.0.0.1:8000`

申请 HTTPS 证书后，将最终域名配置到 `AsrHttpClient.API_BASE`，并同步 `app.html` 的浏览器备用地址，再重新构建 APK。当前 APK 的服务器地址是 `http://23.26.204.65:8000`。
