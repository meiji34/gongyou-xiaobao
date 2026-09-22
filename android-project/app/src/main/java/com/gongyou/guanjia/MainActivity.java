package com.gongyou.guanjia;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.graphics.Color;
import android.view.Window;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.SocketTimeoutException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

import org.json.JSONException;
import org.json.JSONObject;

public class MainActivity extends AppCompatActivity {

    private static final int REQ_RECORD_AUDIO = 1001;
    private static final int REQ_FILE_CHOOSER = 1002;
    private static final int REQ_SAVE_IMAGE = 1003;
    private static final int SAMPLE_RATE = 16000;

    private WebView webView;
    private PermissionRequest pendingPermissionRequest;
    private ValueCallback<Uri[]> pendingFileCallback;
    private final VoiceBridge voiceBridge = new VoiceBridge();
    private final AsrHttpClient asrClient = new AsrHttpClient();
    private final ExecutorService asrExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean recognizing = new AtomicBoolean(false);
    private boolean foreground;
    private final ExecutorService imageExecutor = Executors.newSingleThreadExecutor();
    private String pendingImageRequest;
    private byte[] pendingImageBytes;

    // 原生录音状态
    private volatile AudioRecord audioRecord;
    private Thread recordThread;
    private volatile boolean isRecordingNative = false;
    private ByteArrayOutputStream pcmBuffer;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(247, 246, 243));
        window.setNavigationBarColor(Color.rgb(247, 246, 243));
        window.getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        webView.clearCache(true);
        webView.clearHistory();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        // app.html 从 file:// 加载时，允许它访问局域网 API（真机和模拟器都需要）。
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        // 注入原生录音桥：JS 通过 window.AndroidVoice 调用
        webView.addJavascriptInterface(voiceBridge, "AndroidVoice");
        // 注入分享桥：文案生成后可直接打开微信继续发送。
        webView.addJavascriptInterface(new ShareBridge(), "AndroidShare");
        webView.addJavascriptInterface(new ImageBridge(), "AndroidFiles");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equals(uri.getScheme()) && "/android_asset/app.html".equals(uri.getPath())) {
                    return false;
                }
                // Do not expose the recording/upload bridges to remote documents.
                if (request.isForMainFrame() && ("https".equals(uri.getScheme())
                        || "http".equals(uri.getScheme()) || "tel".equals(uri.getScheme()))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (ActivityNotFoundException ignored) {
                        Toast.makeText(MainActivity.this, "无法打开此链接", Toast.LENGTH_SHORT).show();
                    }
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = filePathCallback;

                Intent intent;
                try {
                    intent = fileChooserParams.createIntent();
                } catch (Exception e) {
                    pendingFileCallback = null;
                    filePathCallback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "无法打开图片选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }

                try {
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    pendingFileCallback = null;
                    filePathCallback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "手机没有可用的文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean needsMic = false;
                for (String res : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                        needsMic = true;
                        break;
                    }
                }
                if (!needsMic) {
                    runOnUiThread(() -> request.deny());
                    return;
                }
                if (hasMicPermission()) {
                    runOnUiThread(() -> request.grant(request.getResources()));
                } else {
                    pendingPermissionRequest = request;
                    ActivityCompat.requestPermissions(MainActivity.this,
                            new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
                }
            }
        });

        // 启动时只请求一次麦克风权限（被拒绝过就不再反复弹）
        if (!hasMicPermission() &&
                ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.RECORD_AUDIO)) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
        } else if (!hasMicPermission() && !isMicAskedBefore()) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
        }

        webView.loadUrl("file:///android_asset/app.html");

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                webView.evaluateJavascript("typeof window.handleAppBack === 'function' && window.handleAppBack()", handled -> {
                    if (isDestroyed() || "true".equals(handled)) return;
                    if (webView.canGoBack()) webView.goBack();
                    else {
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    }
                });
            }
        });
    }

    private boolean hasMicPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isMicAskedBefore() {
        return getPreferences(MODE_PRIVATE).getBoolean("mic_asked", false);
    }

    private void markMicAsked() {
        getPreferences(MODE_PRIVATE).edit().putBoolean("mic_asked", true).apply();
    }

    // ========== 原生录音桥（供 JS 调用） ==========
    class VoiceBridge {

        @JavascriptInterface
        public void startRecording() {
            runOnUiThread(this::startNativeRecording);
        }

        private void startNativeRecording() {
            if (!foreground || isDestroyed()) {
                notifyJsError("请回到应用页面后再录音");
                return;
            }
            if (!hasMicPermission()) {
                markMicAsked();
                ActivityCompat.requestPermissions(MainActivity.this,
                        new String[]{Manifest.permission.RECORD_AUDIO}, REQ_RECORD_AUDIO);
                notifyJsError("需要麦克风权限，允许后再按住说话");
                return;
            }
            if (isRecordingNative) return;
            finishRecording();
            try {
                int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                if (minBuf <= 0) throw new IllegalStateException("unsupported_audio_format");
                audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 2);
                if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                    throw new IllegalStateException("audio_not_initialized");
                }
                pcmBuffer = new ByteArrayOutputStream();
                audioRecord.startRecording();
                if (audioRecord.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                    throw new IllegalStateException("audio_not_recording");
                }
            } catch (SecurityException e) {
                finishRecording();
                notifyJsError("没有麦克风权限，请在系统设置里允许后重试");
                return;
            } catch (RuntimeException e) {
                finishRecording();
                notifyJsError("麦克风启动失败，请关闭其他录音或通话应用后再试");
                return;
            }
            isRecordingNative = true;
            final AudioRecord capture = audioRecord;
            final ByteArrayOutputStream buffer = pcmBuffer;
            recordThread = new Thread(() -> {
                byte[] buf = new byte[4096];
                try {
                    while (isRecordingNative && audioRecord == capture) {
                        int read = capture.read(buf, 0, buf.length);
                        if (!isRecordingNative || audioRecord != capture) break;
                        if (read < 0) throw new IllegalStateException("audio_read_failed");
                        if (read > 0) {
                            synchronized (buffer) {
                                if (buffer.size() + read > SAMPLE_RATE * 2 * 59) {
                                    throw new IllegalStateException("audio_too_long");
                                }
                                buffer.write(buf, 0, read);
                            }
                        }
                    }
                } catch (RuntimeException e) {
                    runOnUiThread(() -> {
                        if (audioRecord != capture) return;
                        finishRecording();
                        notifyJsError("audio_too_long".equals(e.getMessage())
                                ? "录音太长了，请控制在一分钟内再试"
                                : "录音被中断，请再按住说一次");
                    });
                }
            }, "voice-capture");
            recordThread.start();
        }

        @JavascriptInterface
        public void stopRecording() {
            runOnUiThread(this::stopNativeRecording);
        }

        private void stopNativeRecording() {
            byte[] pcm = finishRecording();
            if (pcm == null || pcm.length < 3200) { // <0.1 秒
                notifyJsError("录音太短了，按住说完再松手");
                return;
            }
            byte[] wav = toWav(pcm);
            String b64 = Base64.encodeToString(wav, Base64.NO_WRAP);
            if (!isDestroyed()) webView.evaluateJavascript(
                    "window.onNativeVoiceResult && window.onNativeVoiceResult(" + JSONObject.quote(b64) + ")", null);
        }

        @JavascriptInterface
        public void cancelRecording() {
            runOnUiThread(() -> finishRecording());
        }

        private byte[] finishRecording() {
            isRecordingNative = false;
            AudioRecord capture = audioRecord;
            audioRecord = null;
            if (capture != null) {
                try { capture.stop(); } catch (RuntimeException ignored) {}
            }
            try {
                if (recordThread != null) recordThread.join(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            recordThread = null;
            if (capture != null) capture.release();
            ByteArrayOutputStream buffer = pcmBuffer;
            pcmBuffer = null;
            if (buffer == null) return null;
            synchronized (buffer) {
                return buffer.toByteArray();
            }
        }

        @JavascriptInterface
        public String getApiBase() {
            return AsrHttpClient.API_BASE;
        }

        @JavascriptInterface
        public void recognize(String audioBase64, String lang, String requestId) {
            if (requestId == null || !requestId.matches("asr_[0-9]{1,12}")) return;
            if (!"mandarin".equals(lang) && !"minnan".equals(lang) && !"hakka".equals(lang)) {
                notifyAsr(requestId, "unsupported_language", null);
                return;
            }
            if (audioBase64 == null || audioBase64.isEmpty()) {
                notifyAsr(requestId, "invalid_audio", null);
                return;
            }
            if (audioBase64.length() > 2796204) {
                notifyAsr(requestId, "audio_too_large", null);
                return;
            }
            if (!recognizing.compareAndSet(false, true)) {
                notifyAsr(requestId, "busy", null);
                return;
            }
            try {
                asrExecutor.execute(() -> {
                    String code = null;
                    AsrHttpClient.Response response = null;
                    try {
                        JSONObject payload = new JSONObject();
                        payload.put("audio_base64", audioBase64);
                        payload.put("format", "wav");
                        payload.put("lang", lang);
                        response = asrClient.recognize(lang, payload.toString());
                    } catch (SocketTimeoutException e) {
                        code = "timeout";
                    } catch (IOException e) {
                        if ("response_too_large".equals(e.getMessage())) {
                            code = "invalid_response";
                        } else {
                            ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                            NetworkCapabilities network = manager == null ? null
                                    : manager.getNetworkCapabilities(manager.getActiveNetwork());
                            code = network != null && network.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                                    ? "network_vpn" : "network";
                        }
                    } catch (Exception e) {
                        code = "native_error";
                    } finally {
                        recognizing.set(false);
                    }
                    notifyAsr(requestId, code, response);
                });
            } catch (RejectedExecutionException e) {
                recognizing.set(false);
                notifyAsr(requestId, "native_error", null);
            }
        }

        private void notifyAsr(String requestId, String code, AsrHttpClient.Response response) {
            JSONObject result = new JSONObject();
            try {
                if (code != null) {
                    result.put("code", code);
                } else if (response != null) {
                    result.put("status", response.status);
                    result.put("body", response.body);
                }
            } catch (JSONException ignored) {}
            final String json = result.toString();
            runOnUiThread(() -> {
                if (!isDestroyed()) webView.evaluateJavascript(
                        "window.onNativeAsrResult && window.onNativeAsrResult("
                                + JSONObject.quote(requestId) + "," + json + ")", null);
            });
        }

        private byte[] toWav(byte[] pcm) {
            int dataLen = pcm.length;
            ByteArrayOutputStream out = new ByteArrayOutputStream(44 + dataLen);
            try {
                // RIFF header
                out.write("RIFF".getBytes());
                out.write(intToLE(36 + dataLen));
                out.write("WAVE".getBytes());
                out.write("fmt ".getBytes());
                out.write(intToLE(16));            // PCM chunk size
                out.write(shortToLE((short) 1));   // PCM format
                out.write(shortToLE((short) 1));   // mono
                out.write(intToLE(SAMPLE_RATE));
                out.write(intToLE(SAMPLE_RATE * 2)); // byte rate
                out.write(shortToLE((short) 2));   // block align
                out.write(shortToLE((short) 16));  // bits per sample
                out.write("data".getBytes());
                out.write(intToLE(dataLen));
                out.write(pcm);
            } catch (IOException ignored) {}
            return out.toByteArray();
        }

        private byte[] intToLE(int v) {
            return new byte[]{(byte) v, (byte) (v >> 8), (byte) (v >> 16), (byte) (v >> 24)};
        }

        private byte[] shortToLE(short v) {
            return new byte[]{(byte) v, (byte) (v >> 8)};
        }

        private void notifyJsError(String msg) {
            runOnUiThread(() -> {
                if (!isDestroyed()) webView.evaluateJavascript(
                        "window.onNativeVoiceError && window.onNativeVoiceError(" + JSONObject.quote(msg) + ")", null);
            });
        }
    }

    class ImageBridge {
        @JavascriptInterface
        public void saveImage(String dataUrl, String name, String requestId) {
            if (requestId == null || !requestId.matches("image_[0-9]{1,12}")) return;
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                if (pendingImageRequest != null) {
                    notifyImageSaved(requestId, false, "上一张图片还在保存，请稍后再试");
                    return;
                }
                pendingImageRequest = requestId;
                imageExecutor.execute(() -> {
                    try {
                        byte[] bytes = EvidenceImageStore.decode(dataUrl);
                        String filename = EvidenceImageStore.filename(name);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            EvidenceImageStore.saveToGallery(getContentResolver(), bytes, filename);
                            notifyImageSaved(requestId, true, "已保存到相册的 GongyouXiaobao 文件夹");
                        } else {
                            runOnUiThread(() -> {
                                if (isDestroyed()) return;
                                pendingImageBytes = bytes;
                                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                                intent.addCategory(Intent.CATEGORY_OPENABLE);
                                intent.setType("image/png");
                                intent.putExtra(Intent.EXTRA_TITLE, filename);
                                try { startActivityForResult(intent, REQ_SAVE_IMAGE); }
                                catch (ActivityNotFoundException error) {
                                    notifyImageSaved(requestId, false, "手机没有可用的文件保存工具");
                                }
                            });
                        }
                    } catch (Exception error) {
                        notifyImageSaved(requestId, false, "图片保存失败，请检查手机剩余空间后重试");
                    }
                });
            });
        }
    }

    private void notifyImageSaved(String id, boolean ok, String message) {
        runOnUiThread(() -> {
            if (id.equals(pendingImageRequest)) {
                pendingImageRequest = null;
                pendingImageBytes = null;
            }
            if (isDestroyed()) return;
            try {
                JSONObject result = new JSONObject();
                result.put("ok", ok);
                result.put("message", message);
                webView.evaluateJavascript("window.onNativeImageSaved && window.onNativeImageSaved("
                        + JSONObject.quote(id) + "," + result + ")", null);
            } catch (JSONException ignored) {}
        });
    }

    class ShareBridge {
        @JavascriptInterface
        public void openWeChat(final String text) {
            runOnUiThread(() -> {
                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType("text/plain");
                shareIntent.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                shareIntent.setPackage("com.tencent.mm");
                try {
                    startActivity(shareIntent);
                } catch (ActivityNotFoundException e) {
                    Intent fallback = Intent.createChooser(shareIntent.setPackage(null), "选择要发送到的应用");
                    try {
                        startActivity(fallback);
                    } catch (ActivityNotFoundException ignored) {
                        Toast.makeText(MainActivity.this,
                                "手机里没有可用的分享应用，请先复制文案", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SAVE_IMAGE) {
            final String id = pendingImageRequest;
            final byte[] bytes = pendingImageBytes;
            if (id == null) return;
            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null || bytes == null) {
                notifyImageSaved(id, false, "已取消保存");
                return;
            }
            final Uri uri = data.getData();
            imageExecutor.execute(() -> {
                try {
                    EvidenceImageStore.write(getContentResolver(), uri, bytes);
                    notifyImageSaved(id, true, "图片已保存到所选位置");
                } catch (Exception error) {
                    notifyImageSaved(id, false, "图片保存失败，请重新选择位置");
                }
            });
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                ClipData clipData = data.getClipData();
                if (clipData != null) {
                    results = new Uri[clipData.getItemCount()];
                    for (int i = 0; i < clipData.getItemCount(); i++) {
                        results[i] = clipData.getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(results);
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_RECORD_AUDIO) {
            markMicAsked();
            if (pendingPermissionRequest != null) {
                final PermissionRequest req = pendingPermissionRequest;
                pendingPermissionRequest = null;
                if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    runOnUiThread(() -> req.grant(req.getResources()));
                } else {
                    runOnUiThread(req::deny);
                }
            } else if (grantResults.length > 0 && grantResults[0] != PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this, "没有麦克风权限，语音输入用不了。可在系统设置里开启。", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
        webView.onResume();
    }

    @Override
    protected void onPause() {
        foreground = false;
        voiceBridge.finishRecording();
        webView.evaluateJavascript("window.cancelVoice && window.cancelVoice()", null);
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        foreground = false;
        voiceBridge.finishRecording();
        asrClient.close();
        asrExecutor.shutdownNow();
        imageExecutor.shutdown();
        webView.destroy();
        super.onDestroy();
    }
}
