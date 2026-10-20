package com.spatialmemory.assistant.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.spatialmemory.assistant.BuildConfig
import com.spatialmemory.assistant.api.AssistantController
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.hardware.*
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.orchestrator.*
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.speech.*
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/** Local packaged UI. Camera, inference, memory, voice and hardware stay native. */
class PixelHomeActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var controller: AssistantController
    private lateinit var qwen: AoqQwenRealtimeClient
    private lateinit var speech: SpeechCoordinator
    private lateinit var detector: YoloDetector
    private lateinit var records: NativeRecords
    private lateinit var provisioner: Esp32Provisioner
    private var pageReady = false
    private var sessionSerial = 0
    private var paused = false
    private var pausedTarget: String? = null
    private var pausedLearning = false
    private var sourceKind = "phone"
    private var lastState = AssistantState()
    private var lastSpeech: String? = null
    private var lastSaved: String? = null
    private var esp32: Esp32Connection? = null
    private var pendingPermission: CompletableDeferred<Boolean>? = null
    private val permission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        pendingPermission?.complete(result.values.all { it }); pendingPermission = null
    }
    private val prefs by lazy { getSharedPreferences("iseeyou-native", MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        detector = YoloDetector(this)
        val database = AppDatabase.get(this)
        val repository = MemoryRepository(this, database.memoryDao(), database.objectMemoryDao())
        records = NativeRecords(this, database, repository)
        val credential = GatewayCredentialClient(BuildConfig.GATEWAY_URL)
        qwen = AoqQwenRealtimeClient(this, credential::get, QwenImageVerifier("", gateway = BuildConfig.GATEWAY_URL))
        speech = SpeechCoordinator(this) { enabled -> qwen.setMicrophoneEnabled(enabled && !paused && lastState.running) }
        qwen.setPlaybackEnabled(!prefs.getBoolean("reader", false))
        speech.setEnabled(!prefs.getBoolean("reader", false) && prefs.getBoolean("readLocal", true))
        controller = AssistantController(AssistantOrchestrator(detector, TargetMatcher(this), PerceptionEngine(TargetMatcher(this), HistogramObjectEmbedder()), repository, qwen, speech, File(cacheDir, "active-search-candidate")))
        provisioner = Esp32Provisioner(this)
        prefs.getString("esp32", null)?.let { runCatching { JSONObject(it) }.getOrNull()?.let { value ->
            esp32 = Esp32Connection(value.getString("baseUrl"), value.getString("streamUrl"), value.optString("deviceId"), value.optString("token"), value.optBoolean("legacy"))
        } }
        web = WebView(this)
        web.settings.apply { javaScriptEnabled = true; domStorageEnabled = true; allowFileAccess = false; allowContentAccess = false; mediaPlaybackRequiresUserGesture = true }
        val loader = WebViewAssetLoader.Builder().addPathHandler("/") { path ->
            if (path.contains("..")) null else runCatching {
                val mime = when { path.endsWith(".mjs") || path.endsWith(".js") -> "text/javascript"; path.endsWith(".css") -> "text/css"; path.endsWith(".svg") -> "image/svg+xml"; else -> "text/html" }
                WebResourceResponse(mime, "UTF-8", assets.open("site/" + if (path.isBlank()) "index.html" else path)).apply {
                    responseHeaders = mapOf("Content-Security-Policy" to "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'none'; media-src 'none'; frame-src 'none'")
                }
            }.getOrNull()
        }.build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url) ?: WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), "".byteInputStream())
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = request.url.host != "appassets.androidplatform.net"
        }
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "请更新 Android System WebView 后再使用" }
        WebViewCompat.addWebMessageListener(web, "NativeAssistant", setOf("https://appassets.androidplatform.net")) { _, message, origin, mainFrame, reply ->
            if (!mainFrame || origin.host != "appassets.androidplatform.net") return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            if (raw.length > 12000) return@addWebMessageListener
            val request = runCatching { JSONObject(raw) }.getOrNull() ?: return@addWebMessageListener
            lifecycleScope.launch {
                val response = JSONObject().put("id", request.optString("id"))
                try { response.put("result", command(request.optString("method"), request.optJSONObject("params") ?: JSONObject())) }
                catch (error: CancellationException) { throw error }
                catch (_: Throwable) { response.put("error", "这次操作没有完成，请检查权限、连接和输入后重试。") }
                reply.postMessage(response.toString())
            }
        }
        setContentView(web)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { web.evaluateJavascript("window.nativeBack?.()") { handled -> if (handled != "true") finish() } }
        })
        lifecycleScope.launch {
            controller.state.collect { state ->
                lastState = state
                event("state", stateJson(state))
                val utterance = state.lastSpeech
                if (!utterance.isNullOrBlank() && utterance != lastSpeech) { lastSpeech = utterance; event("answer", JSONObject().put("text", utterance)) }
                if (state.rememberedObjectId != null && state.rememberedObjectId != lastSaved && state.searchState == SearchState.IDLE) {
                    lastSaved = state.rememberedObjectId; event("memories", JSONObject().put("items", records.all()))
                }
            }
        }
        lifecycleScope.launch { qwen.state.collect { event("connection", JSONObject().put("state", it.name)) } }
        lifecycleScope.launch { qwen.events.collect { e -> if (e is QwenEvent.Transcript) { event("transcript", JSONObject().put("role", e.role).put("text", e.text)); if (e.role == "user" && Regex("^(关闭摄像头|结束对话|停止观察)[。！!？?]*$").matches(e.text.trim())) lifecycleScope.launch { sessionSerial++; controller.stop() } } } }
        lifecycleScope.launch {
            controller.analyzedFrames.collectLatest { analyzed ->
                if (!pageReady || paused || !lastState.running) return@collectLatest
                val serial = sessionSerial
                val frame = withContext(Dispatchers.Default) { frameJson(analyzed) }
                if (serial == sessionSerial && lastState.running && !paused) event("frame", frame)
            }
        }
        web.loadUrl("https://appassets.androidplatform.net/index.html")
    }

    private suspend fun requirePermissions(hardware: Boolean = false): Boolean {
        val needed = buildList {
            if (hardware) { if (Build.VERSION.SDK_INT >= 31) { add(Manifest.permission.BLUETOOTH_SCAN); add(Manifest.permission.BLUETOOTH_CONNECT) }; add(Manifest.permission.ACCESS_FINE_LOCATION) }
            else { add(Manifest.permission.CAMERA); add(Manifest.permission.RECORD_AUDIO) }
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) return true
        if (pendingPermission != null) return false
        val result = CompletableDeferred<Boolean>(); pendingPermission = result
        permission.launch(needed.toTypedArray()); return result.await()
    }
    private suspend fun start() {
        sessionSerial++
        check(requirePermissions())
        paused = false
        controller.start(if (sourceKind == "esp32") Esp32CameraSource(Esp32Api(checkNotNull(esp32) { "请先连接硬件" })) else PhoneCameraSource(this, this))
    }
    private suspend fun command(method: String, p: JSONObject): Any = when (method) {
        "ready" -> { pageReady = true; JSONObject().put("state", stateJson(lastState)).put("memories", records.all()).put("source", sourceKind) }
        "start" -> { start(); true }
        "stop" -> { sessionSerial++; pausedTarget = null; paused = false; controller.stop(); true }
        "pause" -> { sessionSerial++; pausedTarget = lastState.target; pausedLearning = lastState.searchState == SearchState.LEARNING; paused = true; controller.stop(); true }
        "resume" -> { val target = pausedTarget; start(); if (target != null) { if (pausedLearning) controller.remember(target) else controller.search(target) }; true }
        "text" -> { check(lastState.running && !paused); controller.submitText(p.getString("text").take(2000)); true }
        "search" -> { if (!lastState.running) start(); controller.search(p.getString("target").take(60)); true }
        "remember" -> { check(lastState.running && !paused); controller.remember(p.getString("target").take(60)); true }
        "cancel" -> { controller.cancelSearch(); true }
        "complete" -> { controller.finishSearch(); true }
        "replay" -> { speech.announce(SpeechEvent("replay:${System.nanoTime()}", p.getString("text").take(2000), SpeechPriority.P0)); true }
        "memories" -> records.all()
        "editMemory" -> { records.edit(p); JSONObject().put("items", records.all()).put("answer", "已保存修改。") }
        "deleteMemory" -> { records.delete(p); JSONObject().put("items", records.all()).put("answer", "已删除这条记忆。") }
        "source" -> { sessionSerial++; controller.stop(); sourceKind = if (p.optString("source") == "esp32") "esp32" else "phone"; true }
        "scan" -> { check(requirePermissions(true)); JSONArray().apply { provisioner.scan().forEach { put(JSONObject().put("id", it.id).put("name", it.name).put("signal", it.signal)) } } }
        "provision" -> {
            check(requirePermissions(true)); val result = provisioner.provision(p.getString("deviceId"), p.getString("ssid"), p.getString("password").toCharArray())
            check(result is ProvisionResult.Success); esp32 = Esp32Connection(result.baseUrl, deviceId = result.deviceId, token = result.token); saveEsp32(); JSONObject().put("connected", true)
        }
        "hardware" -> {
            val base = p.getString("baseUrl").trimEnd('/'); check(Regex("^http://(?:192\\.168\\.|10\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.)[0-9.]+(?::[0-9]+)?$").matches(base))
            val stream = p.optString("streamUrl").ifBlank { "$base/stream" }; check(stream.startsWith(base + "/") || stream.startsWith(base + ":81/"))
            esp32 = Esp32Connection(base, stream, token = p.optString("token"), legacyCameraWebServer = p.optBoolean("legacy")); Esp32Api(esp32!!).refresh(); saveEsp32(); true
        }
        "audioSettings" -> { val reader = p.optBoolean("reader"); val local = p.optBoolean("readLocal", true); prefs.edit().putBoolean("reader", reader).putBoolean("readLocal", local).apply(); speech.setEnabled(!reader && local); qwen.setPlaybackEnabled(!reader); true }
        "status" -> JSONObject().put("gateway", true).put("localModel", true).put("labels", detector.info.labels).put("connection", qwen.state.value.name)
        else -> error("Unsupported command")
    }
    private fun saveEsp32() {
        esp32?.let { prefs.edit().putString("esp32", JSONObject().put("baseUrl", it.baseUrl).put("streamUrl", it.streamUrl).put("deviceId", it.deviceId).put("token", it.token).put("legacy", it.legacyCameraWebServer).toString()).apply() }
    }
    private fun stateJson(s: AssistantState) = JSONObject().put("running", s.running).put("paused", paused).put("target", s.target ?: pausedTarget?.takeIf { paused } ?: JSONObject.NULL).put("searchState", s.searchState.name).put("source", s.source?.name ?: "PHONE").put("message", s.message).put("error", s.error ?: JSONObject.NULL).put("learningSamples", s.learningSamples).put("rememberedObjectId", s.rememberedObjectId ?: JSONObject.NULL).put("yoloLatencyMs", s.yoloLatencyMs ?: JSONObject.NULL).put("qwenVerifying", s.qwenVerifying).put("verifiedBox", s.candidateBox?.let { JSONArray(it) } ?: JSONObject.NULL).put("verifiedAt", s.verifiedAtMs)
    private fun frameJson(analyzed: AnalyzedFrame): JSONObject {
        val frame = analyzed.frame
        val original = checkNotNull(BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size))
        val bitmap = if (frame.rotationDegrees % 360 == 0) original else Bitmap.createBitmap(original, 0, 0, original.width, original.height, Matrix().apply { postRotate(frame.rotationDegrees.toFloat()) }, true)
        return try {
            val bytes = ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 75, it); it.toByteArray() }
            JSONObject().put("image", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("width", bitmap.width).put("height", bitmap.height).put("capturedAt", frame.capturedAtMs).put("detections", JSONArray().apply {
                analyzed.detections.forEach { d -> put(JSONObject().put("label", d.label).put("confidence", d.confidence).put("box", JSONArray(listOf(d.box.left / bitmap.width, d.box.top / bitmap.height, d.box.right / bitmap.width, d.box.bottom / bitmap.height)))) }
            })
        } finally { if (bitmap !== original) bitmap.recycle(); original.recycle() }
    }
    private fun event(type: String, data: JSONObject) { if (pageReady && !isDestroyed) web.evaluateJavascript("window.nativeEvent?.(${JSONObject().put("type", type).put("data", data)})", null) }
    override fun onStop() { sessionSerial++; pageReady = false; lifecycleScope.launch { controller.stop(); provisioner.cancel() }; super.onStop() }
    override fun onRestart() { super.onRestart(); pageReady = true; event("state", stateJson(lastState)) }
    override fun onDestroy() { speech.close(); lifecycleScope.launch(NonCancellable) { controller.stop(); detector.close() }; web.destroy(); super.onDestroy() }
}

private class GatewayCredentialClient(private val base: String) {
    suspend fun get(): AoqCredential = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(base + "/api/android/credential").post("{}".toRequestBody("application/json".toMediaType())).build()
        OkHttpClient().newCall(request).execute().use { response -> check(response.isSuccessful) { "千问临时连接未完成" }; parseDirectCredential(checkNotNull(response.body).string()) }
    }
}
