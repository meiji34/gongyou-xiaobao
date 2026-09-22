# 工友小宝

面向一线建筑工人的 AI 助手项目，包含 Android 客户端和 FastAPI 服务端。

## 项目结构

- `android-project`：Android WebView 客户端，包含工友首页、权益咨询、语音输入、上工记录、证据截图和社区功能。
- `agent-framework`：FastAPI 服务端，包含 DeepSeek 对话、法律知识库检索和腾讯云语音识别接口。
- `android-project/tests`：客户端逻辑、语音链路、页面流程和工单识别测试。
- `agent-framework/tests`：服务端方言识别测试。

## 安全配置

服务端只从环境变量读取密钥，不要把真实密钥写入代码或提交到仓库：

```powershell
$env:DEEPSEEK_API_KEY = "your_deepseek_key"
$env:TENCENT_SECRET_ID = "your_tencent_secret_id"
$env:TENCENT_SECRET_KEY = "your_tencent_secret_key"
```

也可以复制 `agent-framework/.env.example`，由部署环境加载配置。

## 启动服务端

```powershell
cd agent-framework
python -m pip install -r requirements.txt
python server/server.py
```

默认服务地址为 `http://127.0.0.1:8000`。

## 构建 Android 客户端

将 `android-project/local.properties` 配置为本机 Android SDK 路径后，在 Android Studio 中打开 `android-project`，或使用已安装的 Gradle 执行：

```powershell
cd android-project
gradle :app:assembleDebug
```

生成的 APK 位于 `android-project/app/build/outputs/apk/debug/app-debug.apk`。

## 测试

```powershell
cd android-project
node --test tests/*.test.cjs
```

页面流程测试需要 Playwright 和 Chrome。服务端测试使用 Python 的 `unittest`。

## 说明

项目中的测试素材和安全学习视频属于应用运行资源。真实 API 密钥、个人配置、APK 和构建缓存已排除在版本库之外。
