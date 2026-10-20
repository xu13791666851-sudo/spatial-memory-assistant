package com.spatialmemory.assistant.debug

import android.Manifest
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.net.wifi.WifiManager
import android.net.wifi.WifiInfo
import android.net.ConnectivityManager
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.lifecycle.lifecycleScope
import com.spatialmemory.assistant.api.AssistantController
import com.spatialmemory.assistant.camera.FixtureFrameSource
import com.spatialmemory.assistant.camera.Esp32CameraSource
import com.spatialmemory.assistant.camera.PhoneCameraSource
import com.spatialmemory.assistant.camera.CameraSource
import com.spatialmemory.assistant.BuildConfig
import com.spatialmemory.assistant.hardware.Esp32Api
import com.spatialmemory.assistant.hardware.Esp32Connection
import com.spatialmemory.assistant.hardware.Esp32Provisioner
import com.spatialmemory.assistant.hardware.DeviceCandidate
import com.spatialmemory.assistant.inference.TargetMatcher
import com.spatialmemory.assistant.inference.HistogramObjectEmbedder
import com.spatialmemory.assistant.inference.PerceptionEngine
import com.spatialmemory.assistant.inference.YoloDetector
import com.spatialmemory.assistant.memory.AppDatabase
import com.spatialmemory.assistant.memory.MemoryRepository
import com.spatialmemory.assistant.orchestrator.AssistantOrchestrator
import com.spatialmemory.assistant.orchestrator.AssistantState
import com.spatialmemory.assistant.orchestrator.SearchState
import com.spatialmemory.assistant.realtime.AoqQwenRealtimeClient
import com.spatialmemory.assistant.realtime.DirectAoqCredentialClient
import com.spatialmemory.assistant.realtime.QwenImageVerifier
import com.spatialmemory.assistant.speech.SpeechCoordinator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

class HardwareDebugActivity : ComponentActivity() {
    private lateinit var detector: YoloDetector
    private lateinit var controller: AssistantController
    private lateinit var phoneSource: PhoneCameraSource
    private val fixtureSource = FixtureFrameSource()
    private lateinit var status: TextView
    private lateinit var headline: TextView
    private lateinit var qwenStatus: TextView
    private lateinit var cameraPreview: PreviewView
    private lateinit var preview: YoloPreviewView
    private lateinit var target: EditText
    private lateinit var esp32BaseUrl: EditText
    private lateinit var esp32StreamUrl: EditText
    private lateinit var legacyMode: CheckBox
    private lateinit var wifiSsid: EditText
    private lateinit var wifiPassword: EditText
    private lateinit var provisioner: Esp32Provisioner
    private var selectedDevice: DeviceCandidate? = null
    private var provisionedDeviceId = ""
    private var provisionedToken = ""
    private lateinit var speechCoordinator: SpeechCoordinator

    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (wifiSsid.text.isBlank()) wifiSsid.setText(currentSsid())
        if (result.values.any { !it }) status.text = "需要相机、麦克风、附近设备和位置权限才能自动读取 WiFi 并测试完整链路。"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 28, 28, 28)
        }
        val previewContainer = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(260))
            setBackgroundColor(Color.BLACK)
        }
        cameraPreview = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FIT_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
        preview = YoloPreviewView(this)
        previewContainer.addView(cameraPreview, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        previewContainer.addView(preview, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(previewContainer)
        root.addView(TextView(this).apply { text = "Stage C 快速找物 + 长期外观记忆"; textSize = 22f })
        headline = TextView(this).apply {
            text = "未启动：请选择摄像头"
            textSize = 19f
            setTextColor(Color.WHITE)
            setPadding(20, 18, 20, 18)
            setBackgroundColor(Color.rgb(80, 80, 80))
        }
        root.addView(headline)
        qwenStatus = TextView(this).apply {
            text = "千问实时：未连接"
            textSize = 16f
            setPadding(0, 14, 0, 14)
        }
        root.addView(qwenStatus)
        target = EditText(this).apply {
            hint = "输入目标，例如：钥匙"
            inputType = InputType.TYPE_CLASS_TEXT
            setText("钥匙")
        }
        root.addView(target)
        esp32BaseUrl = EditText(this).apply { hint = "ESP32 控制地址"; setText("http://192.168.253.235") }
        esp32StreamUrl = EditText(this).apply { hint = "ESP32 MJPEG 地址"; setText("http://192.168.253.235:81/stream") }
        legacyMode = CheckBox(this).apply { text = "兼容当前 Arduino CameraWebServer 固件"; isChecked = true }
        root.addView(esp32BaseUrl)
        root.addView(esp32StreamUrl)
        root.addView(legacyMode)
        wifiSsid = EditText(this).apply { hint = "手机当前 WiFi 名称"; setText(currentSsid()) }
        wifiPassword = EditText(this).apply { hint = "输入当前 WiFi 密码"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        root.addView(wifiSsid)
        root.addView(wifiPassword)
        root.row(
            button("扫描配对设备") { launchAction {
                val devices = provisioner.scan()
                selectedDevice = devices.firstOrNull()
                status.text = selectedDevice?.let { "已选择 ${it.name} / ${it.id} / RSSI ${it.signal}" } ?: "没有发现配网模式设备"
            } },
            button("写入当前 WiFi") { launchAction {
                val device = selectedDevice ?: error("请先扫描设备")
                val result = provisioner.provision(device.id, wifiSsid.text.toString().trim(), wifiPassword.text.toString().toCharArray())
                wifiPassword.text?.clear()
                if (result is com.spatialmemory.assistant.hardware.ProvisionResult.Success && result.baseUrl.isNotBlank()) {
                    provisionedDeviceId = result.deviceId
                    provisionedToken = result.token
                    esp32BaseUrl.setText(result.baseUrl)
                    esp32StreamUrl.setText(result.baseUrl.trimEnd('/') + ":81/stream")
                    legacyMode.isChecked = false
                }
                status.text = "配网结果：$result"
            } },
        )
        root.row(
            button("启动手机相机") { headline.text = "正在启动手机相机…"; launchAction { controller.start(phoneSource) } },
            button("启动模拟 ESP32") { headline.text = "正在启动模拟相机…"; launchAction { controller.start(fixtureSource) } },
        )
        root.addView(button("启动真实 ESP32") {
            headline.text = "正在连接 ESP32 视频流…"
            launchAction {
                val connection = Esp32Connection(
                    baseUrl = esp32BaseUrl.text.toString().trim(),
                    streamUrl = esp32StreamUrl.text.toString().trim(),
                    deviceId = provisionedDeviceId,
                    token = provisionedToken,
                    legacyCameraWebServer = legacyMode.isChecked,
                )
                controller.start(Esp32CameraSource(Esp32Api(connection)))
            }
        })
        root.row(
            button("开始寻找") {
                val value = target.text.toString().trim()
                if (value.isBlank()) headline.text = "请先输入要寻找的物品" else launchAction { controller.search(value) }
            },
            button("记住物品") {
                val value = target.text.toString().trim()
                if (value.isBlank()) headline.text = "请先输入要记住的物品" else controller.remember(value)
            },
            button("拿到了") { controller.finishSearch() },
        )
        root.addView(button("停止全部") { launchAction { controller.stop() } })
        root.addView(button("发送口语测试：帮我找…") {
            val value = target.text.toString().trim()
            launchAction { controller.submitText("帮我找$value") }
        })
        status = TextView(this).apply {
            textSize = 15f
            setTextIsSelectable(true)
            setPadding(0, 20, 0, 40)
        }
        root.addView(status)
        setContentView(ScrollView(this).apply { addView(root) })

        detector = YoloDetector(this)
        provisioner = Esp32Provisioner(this)
        phoneSource = PhoneCameraSource(this, this, cameraPreview)
        val credentialClient = DirectAoqCredentialClient(BuildConfig.QWEN_API_KEY)
        val qwenClient = AoqQwenRealtimeClient(this, credentialClient::getAoqCredential, QwenImageVerifier(BuildConfig.QWEN_API_KEY))
        speechCoordinator = SpeechCoordinator(this, qwenClient::setMicrophoneEnabled)
        val database = AppDatabase.get(this)
        val embedder = HistogramObjectEmbedder()
        controller = AssistantController(
            AssistantOrchestrator(
                detector = detector,
                matcher = TargetMatcher(this),
                perception = PerceptionEngine(TargetMatcher(this), embedder),
                memory = MemoryRepository(this, database.memoryDao(), database.objectMemoryDao()),
                qwen = qwenClient,
                speech = speechCoordinator,
                candidateDirectory = java.io.File(cacheDir, "active-search-candidate"),
            ),
        )
        lifecycleScope.launch {
            controller.analyzedFrames.collectLatest { analyzed ->
                val bitmap = withContext(Dispatchers.Default) {
                    BitmapFactory.decodeByteArray(analyzed.frame.jpeg, 0, analyzed.frame.jpeg.size)?.rotated(analyzed.frame.rotationDegrees)
                }
                if (bitmap != null) preview.showFrame(bitmap, analyzed.detections, analyzed.frame.source != CameraSource.PHONE)
            }
        }
        lifecycleScope.launch {
            qwenClient.state.collect { qwenStatus.text = "千问实时：$it" }
        }
        lifecycleScope.launch {
            controller.state.collect { state ->
                updateHeadline(state)
                status.text = buildString {
                    appendLine("运行：${state.running}    来源：${state.source ?: "-"}")
                    appendLine("目标：${state.target ?: "-"}    搜索：${state.searchState}")
                    appendLine("searchId：${state.searchId ?: "-"}")
                    appendLine("frameId：${state.frameId ?: "-"}    帧龄：${state.frameAgeMs ?: "-"} ms")
                    appendLine("YOLO：${state.yoloLatencyMs ?: "-"} ms    外观：${state.embeddingLatencyMs ?: "-"} ms")
                    appendLine("模型：${detector.info.inputShape.contentToString()} → ${detector.info.outputShape.contentToString()}，${detector.info.labels} 类")
                    appendLine("检测：${state.detections.joinToString { "${it.label} ${(it.confidence * 100).toInt()}%" }.ifBlank { "无" }}")
                    appendLine("记忆：${state.rememberedObjectId ?: "无"}    学习样本：${state.learningSamples}/3")
                    appendLine("候选分：${state.candidateScore?.let { "%.2f".format(it) } ?: "-"}    外观相似：${state.appearanceSimilarity?.let { "%.2f".format(it) } ?: "-"}")
                    appendLine("千问确认：${if (state.qwenVerifying) "进行中" else "空闲"}    耗时：${state.qwenLatencyMs ?: "-"} ms")
                    appendLine("最近语音：${state.lastSpeech ?: "-"}")
                    appendLine("状态：${state.message}")
                    state.error?.let { appendLine("错误：$it") }
                    appendLine("千问：AOQ ${if (BuildConfig.QWEN_API_KEY.isBlank()) "未配置 Key" else "测试 Key 已配置"}")
                }
            }
        }
        permissionRequest.launch(buildList {
            add(Manifest.permission.CAMERA); add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 31) { add(Manifest.permission.BLUETOOTH_SCAN); add(Manifest.permission.BLUETOOTH_CONNECT) }
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.NEARBY_WIFI_DEVICES)
            add(Manifest.permission.ACCESS_FINE_LOCATION)
        }.toTypedArray())
    }

    override fun onDestroy() {
        runBlocking { controller.stop() }
        preview.clearFrame()
        speechCoordinator.close()
        detector.close()
        super.onDestroy()
    }

    private fun launchAction(block: suspend () -> Unit) = lifecycleScope.launch {
        runCatching { block() }.onFailure {
            val message = "操作失败：${it.message}"
            headline.text = message
            headline.setBackgroundColor(Color.rgb(183, 28, 28))
            status.text = message
        }
    }

    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { action() }
    }

    private fun LinearLayout.row(vararg views: Button) {
        addView(LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            views.forEach { addView(it, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)) }
        })
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun updateHeadline(state: AssistantState) {
        val title = when {
            state.error != null -> "识别出错：${state.error}"
            !state.running && state.message == "已停止" -> "识别已停止"
            !state.running -> "未启动：请选择摄像头"
            state.target == null -> "摄像头已启动，等待开始寻找"
            state.searchState == SearchState.LEARNING -> state.message
            state.searchState == SearchState.SEARCHING -> "正在扫描“${state.target}” · 当前视频帧 ${state.frameId ?: 0}"
            state.searchState == SearchState.VERIFYING -> "发现疑似“${state.target}”，正在请千问确认"
            state.searchState == SearchState.GUIDING -> state.message
            state.searchState == SearchState.COMPLETED -> "寻找已完成"
            state.searchState == SearchState.CANCELLED -> "寻找已取消"
            else -> state.message
        }
        headline.text = title
        headline.setBackgroundColor(when {
            state.error != null -> Color.rgb(183, 28, 28)
            state.searchState == SearchState.GUIDING || state.searchState == SearchState.COMPLETED -> Color.rgb(27, 94, 32)
            state.running -> Color.rgb(21, 101, 192)
            else -> Color.rgb(80, 80, 80)
        })
        if (!state.running) preview.clearFrame()
    }

    @Suppress("DEPRECATION", "MissingPermission")
    private fun currentSsid(): String {
        val ssid = if (Build.VERSION.SDK_INT >= 29) {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            (manager.getNetworkCapabilities(manager.activeNetwork)?.transportInfo as? WifiInfo)?.ssid
        } else {
            (getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo.ssid
        }
        return ssid.orEmpty().removeSurrounding("\"").takeUnless { it == WifiManager.UNKNOWN_SSID }.orEmpty()
    }
}

private fun Bitmap.rotated(degrees: Int): Bitmap {
    if (degrees % 360 == 0) return this
    return Bitmap.createBitmap(this, 0, 0, width, height, Matrix().apply { postRotate(degrees.toFloat()) }, true).also { recycle() }
}
