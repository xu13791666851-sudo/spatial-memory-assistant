package com.spatialmemory.assistant.ui

import android.Manifest
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import com.spatialmemory.assistant.BuildConfig
import com.spatialmemory.assistant.R
import com.spatialmemory.assistant.api.AssistantController
import com.spatialmemory.assistant.backup.MemoryBackupCoordinator
import com.spatialmemory.assistant.conversation.ConversationStore
import com.spatialmemory.assistant.debug.MemoryBackupDiagnostics
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.debug.YoloPreviewView
import com.spatialmemory.assistant.debug.JevDirectDiagnostics
import com.spatialmemory.assistant.hardware.*
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.orchestrator.*
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.speech.*
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import org.json.JSONArray
import org.json.JSONObject

/** The approved pixel UI, rendered natively over the original CameraX + YOLO preview. */
class PixelHomeActivity : ComponentActivity() {
    private lateinit var controller: AssistantController
    private lateinit var qwen: AoqQwenRealtimeClient
    private lateinit var speech: SpeechCoordinator
    private lateinit var detector: FrameDetector
    private var pc: com.spatialmemory.assistant.pc.PcAssistantSession? = null
    private var pcConnectionJob: Job? = null
    private lateinit var records: NativeRecords
    private lateinit var backup: MemoryBackupCoordinator
    private lateinit var provisioner: Esp32Provisioner
    private lateinit var cameraPreview: PreviewView
    private lateinit var yoloPreview: YoloPreviewView
    private lateinit var headline: TextView
    private lateinit var detail: TextView
    private lateinit var sourceLabel: TextView
    private lateinit var voiceButton: Button
    private var lastState = AssistantState()
    private var sourceKind = "phone"
    private var esp32: Esp32Connection? = null
    private var busy = false
    private var foreground = true
    private var sessionSerial = 0L
    private var pendingPermission: CompletableDeferred<Boolean>? = null
    private var recordDialog: Dialog? = null
    private var conversationBody: LinearLayout? = null
    private var conversationScroll: ScrollView? = null
    private enum class RecordsTab { CURRENT, HISTORY, MEMORIES }
    private var recordsTab = RecordsTab.CURRENT
    private val showingMemories get() = recordsTab == RecordsTab.MEMORIES
    private var selectedHistory: String? = null
    private var chatLimit = 200
    private var resettingConversation = false
    private var choiceDialog: android.app.AlertDialog? = null
    private var shownChoices = emptyList<String>()
    private var lastSpeech: String? = null
    private var jevDiagnosticJob: Job? = null
    private val conversations by lazy { ConversationStore(this) }
    private val actionMutex = kotlinx.coroutines.sync.Mutex()
    private val prefs by lazy { getSharedPreferences("iseeyou-native", MODE_PRIVATE) }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        pendingPermission?.complete(result.values.all { it }); pendingPermission = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildHome()
        restoreChat()
        detector = if (BuildConfig.PC_GATEWAY_MODE) object : FrameDetector { override fun detect(jpeg: ByteArray, rotationDegrees: Int, threshold: Float) = emptyList<Detection>() } else YoloDetector(this)
        val database = AppDatabase.get(this)
        val repository = MemoryRepository(this, database.memoryDao(), database.objectMemoryDao())
        // Record authority is selected after constructing the PC connection.
        val credential = NativeGatewayCredentialClient(BuildConfig.GATEWAY_URL)
        qwen = AoqQwenRealtimeClient(this, credential::get)
        speech = SpeechCoordinator(this) { enabled ->
            qwen.setLocalSpeechActive(!enabled)
            qwen.setMicrophoneEnabled(enabled && foreground && controller.state.value.running && controller.state.value.voiceRequested)
        }
        qwen.setPlaybackEnabled(!prefs.getBoolean("reader", false))
        speech.setEnabled(!prefs.getBoolean("reader", false) && prefs.getBoolean("readLocal", true))
        backup = MemoryBackupCoordinator(this, database, lifecycleScope, { message ->
            appendChat("assistant", message)
            if(foreground) speech.announce(SpeechEvent("backup-${System.nanoTime()}", message, SpeechPriority.P1))
            if(showingMemories) refreshRecords()
        }, { stopSession() }, automatic = { !BuildConfig.PC_GATEWAY_MODE })
        pc = if (BuildConfig.PC_GATEWAY_MODE) com.spatialmemory.assistant.pc.PcAssistantSession(this,database,qwen,speech,lifecycleScope,backup::handle,conversationId=conversations::initialize) { if(showingMemories) refreshRecords() } else null
        records = NativeRecords(this, database, repository, pc)
        controller = AssistantController(AssistantOrchestrator(detector, TargetMatcher(this), PerceptionEngine(TargetMatcher(this), HistogramObjectEmbedder()), repository, qwen, VisionReviewRouter(this), speech, File(cacheDir, "active-search-candidate"), memoryCommand = backup::handle), pc)
        provisioner = Esp32Provisioner(this)
        prefs.getString("esp32", null)?.let { raw -> runCatching {
            val value = JSONObject(raw)
            esp32 = Esp32Connection(value.getString("baseUrl"), value.getString("streamUrl"), value.optString("deviceId"), value.optString("token"), value.optBoolean("legacy"))
        } }
        lifecycleScope.launch { controller.state.collect { state ->
            val memoryChanged = state.rememberedObjectId != lastState.rememberedObjectId ||
                (state.rememberedObjectId!=null && state.searchState==SearchState.IDLE &&
                    (lastState.searchState!=SearchState.IDLE || state.lastSpeech!=lastState.lastSpeech))
            lastState = state
            renderState(state)
            showObjectChoices(state)
            state.lastSpeech?.takeIf { it.isNotBlank() && it != lastSpeech }?.let { lastSpeech = it; appendChat("assistant", it) }
            if (memoryChanged && showingMemories) refreshRecords()
        } }
        lifecycleScope.launch { qwen.state.collect { renderState(lastState) } }
        lifecycleScope.launch { qwen.events.collect { event ->
            if (event is QwenEvent.Transcript && controller.state.value.running && controller.state.value.voiceRequested) {
                if (event.role == "user" && !MemoryBackupCoordinator.sensitive(event.text) && !com.spatialmemory.assistant.pc.PcAssistantSession.sensitive(event.text)) appendChat(event.role, event.text)
                if (event.role == "user" && Regex("^(关闭摄像头|结束对话|停止观察)[。！!？?]*$").matches(event.text.trim())) {
                    action { stopSession() }
                }
            }
        } }
        lifecycleScope.launch {
            controller.analyzedFrames.collectLatest { analyzed ->
                if (!foreground || !controller.state.value.running) return@collectLatest
                val serial = sessionSerial
                val bitmap = withContext(Dispatchers.Default) {
                    BitmapFactory.decodeByteArray(analyzed.frame.jpeg, 0, analyzed.frame.jpeg.size)?.rotated(analyzed.frame.rotationDegrees)
                } ?: return@collectLatest
                if (serial != sessionSerial || !foreground || !controller.state.value.running) { bitmap.recycle(); return@collectLatest }
                // All real model detections are drawn, including outside a search and during learning.
                yoloPreview.showFrame(bitmap, analyzed.detections, analyzed.frame.source != CameraSource.PHONE)
            }
        }
        jevDiagnosticJob = JevDirectDiagnostics.handle(this, intent) { stopSession() }
        MemoryBackupDiagnostics.handle(this, intent) { stopSession() }?.let { jevDiagnosticJob = it }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        JevDirectDiagnostics.handle(this, intent) { stopSession() }?.let { job -> jevDiagnosticJob?.cancel();jevDiagnosticJob = job }
        MemoryBackupDiagnostics.handle(this, intent) { stopSession() }?.let { job -> jevDiagnosticJob?.cancel();jevDiagnosticJob = job }
    }

    private fun buildHome() {
        val outside = FrameLayout(this).apply { setBackgroundColor(PixelColors.paper) }
        val root = column().apply {
            background = PixelBorder(PixelColors.paper, resources.displayMetrics.density)
            setPadding(dp(18), dp(14), dp(18), dp(16))
        }
        outside.addView(root, FrameLayout.LayoutParams(-1, -1))
        ViewCompat.setOnApplyWindowInsetsListener(outside) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left + dp(8), bars.top + dp(8), bars.right + dp(8), bars.bottom + dp(8)); insets
        }
        root.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(PixelWordmark(this@PixelHomeActivity), LinearLayout.LayoutParams(0, dp(44), 1f))
            addView(button("•••") { showSettings() }.apply { id = R.id.native_settings; contentDescription = "摄像头设置" }, LinearLayout.LayoutParams(dp(44), dp(44)))
        })
        val stage = FrameLayout(this).apply {
            background = PixelBorder(Color.rgb(227, 238, 245), resources.displayMetrics.density)
            setPadding(dp(7), dp(7), dp(7), dp(7))
        }
        root.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = dp(14); bottomMargin = dp(14) })
        cameraPreview = PreviewView(this).apply {
            visibility = View.INVISIBLE
            scaleType = PreviewView.ScaleType.FIT_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
        yoloPreview = YoloPreviewView(this).apply { id = R.id.native_yolo_overlay }
        stage.addView(cameraPreview, FrameLayout.LayoutParams(-1, -1))
        stage.addView(yoloPreview, FrameLayout.LayoutParams(-1, -1))
        stage.setOnClickListener { if (!controller.state.value.running && !busy) action { startSession() } }
        sourceLabel = label("● 手机摄像头", 11f).apply { background = rounded(PixelColors.pale); setPadding(dp(8), dp(5), dp(8), dp(5)) }
        stage.addView(sourceLabel, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply { setMargins(dp(12), dp(12), 0, 0) })
        stage.addView(label("普通场景", 11f).apply { background = rounded(PixelColors.pale); setPadding(dp(8), dp(5), dp(8), dp(5)) }, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply { setMargins(0, dp(12), dp(12), 0) })
        val task = column().apply { background = rounded(PixelColors.paper); setPadding(dp(12), dp(10), dp(12), dp(10)); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES }
        headline = label("点击语音找物开始", 17f, true).apply { id = R.id.native_headline }
        detail = label("准备好后说：帮我找水杯，或记住水杯", 12f).apply { setTextColor(PixelColors.muted); setPadding(0, dp(5), 0, 0) }
        task.addView(headline); task.addView(detail)
        stage.addView(task, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { setMargins(dp(10), 0, dp(10), dp(10)) })
        val actions = LinearLayout(this)
        voiceButton = button("语音找物", true) { action { if (controller.state.value.running) stopSession() else startSession() } }.apply {
            id = R.id.native_voice; textSize = 23f
            val mic = ContextCompat.getDrawable(this@PixelHomeActivity, R.drawable.ic_mic)?.apply { setBounds(0, 0, dp(23), dp(23)) }
            setCompoundDrawables(mic, null, null, null); compoundDrawablePadding = dp(5)
        }
        actions.addView(voiceButton, LinearLayout.LayoutParams(0, dp(118), 1f).apply { marginEnd = dp(12) })
        actions.addView(button("对话记录") { showRecords() }.apply { id = R.id.native_records; textSize = 23f }, LinearLayout.LayoutParams(0, dp(118), 1f))
        root.addView(actions)
        setContentView(outside)
    }

    private suspend fun requirePermissions(hardware: Boolean = false, enableVoice: Boolean = true): Boolean {
        val needed = buildList {
            if (hardware) {
                if (Build.VERSION.SDK_INT >= 31) { add(Manifest.permission.BLUETOOTH_SCAN); add(Manifest.permission.BLUETOOTH_CONNECT) }
                else add(Manifest.permission.ACCESS_FINE_LOCATION)
            } else { if (sourceKind == "phone") add(Manifest.permission.CAMERA); if (enableVoice) add(Manifest.permission.RECORD_AUDIO) }
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) return true
        if (pendingPermission != null) return false
        val result = CompletableDeferred<Boolean>(); pendingPermission = result
        permission.launch(needed.toTypedArray()); return result.await()
    }

    private suspend fun startSession(enableVoice: Boolean = true) {
        check(requirePermissions(enableVoice = enableVoice)) { if (enableVoice) "请允许相机和麦克风后再开始。" else "请允许相机后再开始。" }
        check(foreground) { "请返回应用后再开始。" }
        sessionSerial++
        headline.text = "正在启动…"
        val source = when (sourceKind) {
            "esp32" -> Esp32CameraSource(Esp32Api(checkNotNull(esp32) { "请先连接摄像头。" }))
            else -> PhoneCameraSource(this, this, cameraPreview)
        }
        controller.start(source, enableVoice)
    }

    private suspend fun stopSession() { sessionSerial++; controller.stop(); yoloPreview.clearFrame() }

    private fun renderState(state: AssistantState) {
        cameraPreview.visibility = if (state.running && sourceKind == "phone") View.VISIBLE else View.INVISIBLE
        voiceButton.text = if (state.running) "结束" else "语音找物"
        sourceLabel.text = if (state.source == CameraSource.ESP32 || sourceKind == "esp32") "● 外接摄像头" else "● 手机摄像头"
        headline.text = when {
            state.objectChoices.isNotEmpty() -> "请选择具体的物品"
            !state.running -> if (state.error != null) "启动没有完成" else "点击语音找物开始"
            state.searchState == SearchState.LEARNING -> state.message.takeIf { it.startsWith("正在记住") } ?: "正在记住物品的样子和位置"
            state.message == "正在看眼前的画面" -> "正在观察眼前的画面"
            qwen.state.value == RealtimeState.CONNECTING && state.target.isNullOrBlank() -> "正在连接语音，请稍候"
            state.target.isNullOrBlank() -> state.notice ?: "说出你想找或记住的物品"
            state.searchState == SearchState.VERIFYING -> "发现疑似物品，正在确认"
            state.searchState == SearchState.SEARCHING -> "正在寻找：${state.target}"
            else -> state.message.takeUnless { it.startsWith("YOLO") || it.startsWith("已收到第") } ?: "说出你想找或记住的物品"
        }
        detail.text = when {
            !state.running -> state.error ?: if(BuildConfig.PC_GATEWAY_MODE)state.message.takeIf { it.contains("电脑") } ?: "电脑处理模式 · 记录中可输入指令" else "记录中可输入指令，也可直接查询位置历史"
            state.qwenVerifying -> "正在复核图片 · 请保持画面稳定"
            state.searchState == SearchState.SEARCHING && Regex("未完成|变化|不能确定|未找到|缺失|重新扫描").containsMatchIn(state.message) -> state.message
            !state.voiceRequested -> "文字找物模式 · 麦克风未开启"
            state.error?.startsWith("千问") == true -> "语音未连接 · 可在记录中输入指令，图片复核仍可使用"
            state.error != null -> state.error
            state.searchState == SearchState.LEARNING -> "正在自动取景，请稍候"
            qwen.state.value == RealtimeState.FAILED || qwen.state.value == RealtimeState.DISCONNECTED -> "语音未连接 · 可在记录中输入指令，图片复核仍可使用"
            qwen.state.value != RealtimeState.CONNECTED -> "画面已开启 · 语音正在连接"
            else -> "语音已就绪 · 识别框显示当前检测结果"
        }
        if (!state.running) yoloPreview.clearFrame()
    }

    private fun action(block: suspend () -> Unit) {
        if (busy) return
        lifecycleScope.launch {
            actionMutex.lock()
            busy = true; voiceButton.isEnabled = false
            try { block() }
            catch (error: CancellationException) { throw error }
            catch (error: Throwable) { notify(error.message ?: "操作没有完成，请重试。") }
            finally { busy = false; voiceButton.isEnabled = true; actionMutex.unlock() }
        }
    }

    private fun showSettings() {
        val (dialog, body) = sheet("摄像头设置")
        body.addView(menuButton("连接摄像头", "添加附近的摄像头") { dialog.dismiss(); showConnect() }.apply { id = R.id.native_pair })
        body.addView(menuButton("切换画面来源", if (sourceKind == "phone") "手机摄像头" else "外接摄像头") { dialog.dismiss(); showSources() }.apply { id = R.id.native_source }, spaced())
        dialog.showSized()
    }

    private fun showConnect() {
        val (dialog, body) = sheet("连接摄像头")
        val description = label("打开摄像头后，搜索附近设备。", 14f)
        body.addView(description)
        val fields = column().apply { visibility = View.GONE }
        val spinner = Spinner(this)
        val ssid = input("Wi-Fi 名称").apply { setText(currentSsid()) }
        val password = input("Wi-Fi 密码").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        var devices = emptyList<DeviceCandidate>()
        lateinit var scan: Button
        lateinit var connect: Button
        var operation: Job? = null
        scan = button("搜索附近摄像头", true) {
            if (operation?.isActive == true) return@button
            operation = lifecycleScope.launch {
                try {
                    check(requirePermissions(true)) { "请允许附近设备权限。" }
                    scan.isEnabled = false; description.text = "正在搜索附近摄像头…"
                    devices = provisioner.scan()
                    spinner.adapter = ArrayAdapter(this@PixelHomeActivity, android.R.layout.simple_spinner_dropdown_item, listOf("请选择摄像头") + devices.map { it.name })
                    fields.visibility = if (devices.isEmpty()) View.GONE else View.VISIBLE
                    description.text = if (devices.isEmpty()) "没有找到摄像头，请确认蓝牙和设备配网模式已开启。" else "请选择摄像头，填写它要连接的 2.4 GHz Wi-Fi。"
                } catch (error: CancellationException) { throw error }
                catch (error: Throwable) { description.text = error.message ?: "搜索没有完成。" }
                finally { scan.isEnabled = true }
            }
        }
        body.addView(scan, spaced()); body.addView(fields, spaced())
        fields.addView(spinner, LinearLayout.LayoutParams(-1, dp(48)))
        fields.addView(label("Wi-Fi 名称", 13f, true), spaced()); fields.addView(ssid)
        fields.addView(label("Wi-Fi 密码", 13f, true), spaced()); fields.addView(password)
        connect = button("连接摄像头", true) {
            if (operation?.isActive == true) return@button
            val selected = devices.getOrNull(spinner.selectedItemPosition - 1)
            if (selected == null) { description.text = "请先选择摄像头。"; return@button }
            if (ssid.text.isBlank()) { ssid.error = "请输入 Wi-Fi 名称"; ssid.requestFocus(); return@button }
            if (password.text.isBlank()) { password.error = "请输入 Wi-Fi 密码"; password.requestFocus(); return@button }
            operation = lifecycleScope.launch {
                scan.isEnabled = false; connect.isEnabled = false
                val secret = password.text.toString().toCharArray(); password.text.clear()
                try {
                    description.text = "正在连接并配置 Wi-Fi…"
                    when (val result = provisioner.provision(selected.id, ssid.text.toString().trim(), secret)) {
                        is ProvisionResult.Success -> {
                            check(result.baseUrl.isNotBlank()) { "设备没有返回网络地址，请重试。" }
                            esp32 = result.cameraConnection()
                            saveEsp32()
                            description.text = "摄像头已连上 Wi-Fi。返回设置可切换到外接摄像头。"
                        }
                        is ProvisionResult.Failure -> description.text = result.reason
                    }
                } catch (error: CancellationException) { throw error }
                catch (error: Throwable) { description.text = error.message ?: "连接没有完成。" }
                finally { secret.fill('\u0000'); scan.isEnabled = true; connect.isEnabled = true }
            }
        }
        fields.addView(connect, spaced())
        body.addView(button("返回设置") { dialog.dismiss(); showSettings() }, spaced())
        dialog.setOnDismissListener { operation?.cancel(); lifecycleScope.launch { provisioner.cancel() } }
        dialog.showSized()
    }

    private fun showSources() {
        val (dialog, body) = sheet("画面来源")
        body.addView(button(if (sourceKind == "phone") "✓ 手机摄像头" else "手机摄像头") { selectSource("phone", dialog) })
        body.addView(button(if (sourceKind == "esp32") "✓ 外接摄像头" else "外接摄像头") {
            if (esp32 == null) { dialog.dismiss(); showConnect() } else selectSource("esp32", dialog)
        }, spaced())
        body.addView(label("外接摄像头需先完成连接。", 13f), spaced())
        body.addView(button("返回设置") { dialog.dismiss(); showSettings() }, spaced())
        dialog.showSized()
    }

    private fun selectSource(kind: String, dialog: Dialog) {
        dialog.dismiss()
        action {
            val restart = controller.state.value.running
            val restartWithVoice = controller.state.value.voiceRequested
            stopSession(); sourceKind = kind
            cameraPreview.visibility = if (kind == "phone") View.VISIBLE else View.INVISIBLE
            renderState(controller.state.value)
            if (restart) startSession(enableVoice = restartWithVoice)
        }
    }

    private fun saveEsp32() {
        esp32?.let { prefs.edit().putString("esp32", JSONObject().put("baseUrl", it.baseUrl).put("streamUrl", it.streamUrl).put("deviceId", it.deviceId).put("token", it.token).put("legacy", it.legacyCameraWebServer).toString()).apply() }
    }

    private fun showRecords() {
        val (dialog, body) = sheet("记录", scroll = false)
        recordDialog = dialog
        val tabs = LinearLayout(this)
        val conversation = button("当前对话") { recordsTab = RecordsTab.CURRENT;chatLimit=200;refreshRecords() }
        val history = button("历史") { recordsTab = RecordsTab.HISTORY;selectedHistory=null;chatLimit=200;refreshRecords() }
        val memories = button("物品记忆") { recordsTab = RecordsTab.MEMORIES; refreshRecords() }
        tabs.addView(conversation, LinearLayout.LayoutParams(0, dp(48), 1f))
        tabs.addView(history, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginStart = dp(8) })
        tabs.addView(memories, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginStart = dp(8) })
        body.addView(tabs)
        body.addView(button("新会话") { action { newConversation() } }.apply {
            id=R.id.native_new_conversation
        }, spaced())
        conversationBody = column()
        conversationScroll = ScrollView(this).apply { id=R.id.native_records_scroller;isFillViewport = true;addView(conversationBody) }
        body.addView(conversationScroll, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin=dp(10) })
        // A text fallback remains in Records, keeping the camera and settings uncluttered.
        val typed = input("输入你想说的话").apply {
            id=R.id.native_records_input
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            imeOptions = imeOptions or android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        }
        body.addView(typed, spaced())
        body.addView(button("发送") {
            val text = typed.text.toString().trim()
            if (text.isBlank()) return@button
            action {
                if(text in setOf("新会话","开始新会话")) { newConversation();typed.text.clear();return@action }
                if (pc?.maintenance(text) == true || (pc == null && backup.handle(text))) { typed.text.clear();return@action }
                if (!controller.state.value.running && controller.requiresCamera(text)) startSession(enableVoice = false)
                recordsTab=RecordsTab.CURRENT
                appendChat("user", text); controller.submitText(text); typed.text.clear()
            }
        }.apply { id=R.id.native_records_send }, spaced())
        body.addView(button("回到首页") { dialog.dismiss() }, spaced())
        dialog.setOnDismissListener { recordDialog = null; conversationBody = null;conversationScroll=null }
        refreshRecords(); dialog.showSized(expand = true)
    }

    private fun refreshRecords() {
        val body = conversationBody ?: return
        body.removeAllViews()
        if(recordsTab == RecordsTab.HISTORY && selectedHistory == null) {
            body.addView(label("最近 30 天的会话，打开应用时自动清理过期记录。",14f))
            val current=conversations.initialize()
            val sessions=conversations.sessions().filter { it.id!=current }
            if(sessions.isEmpty())body.addView(label("还没有历史对话。",15f),spaced())
            for(session in sessions) {
                val title=if(session.legacy)"以前的对话（日期未记录）" else java.time.Instant.ofEpochMilli(session.createdAtMs)
                    .atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm"))
                body.addView(menuButton(title,"${session.messageCount} 条 · ${session.preview.take(28)}") {
                    selectedHistory=session.id;chatLimit=200;refreshRecords()
                },spaced())
            }
            return
        }
        if (!showingMemories) {
            val session=if(recordsTab == RecordsTab.HISTORY)selectedHistory else conversations.initialize()
            val chat=session?.let { conversations.messages(it,chatLimit) }.orEmpty()
            if(recordsTab == RecordsTab.HISTORY)body.addView(button("返回历史列表") {selectedHistory=null;refreshRecords()},spaced())
            if (chat.isEmpty()) body.addView(label(if(recordsTab == RecordsTab.HISTORY)"这段历史已过期或暂无消息。" else "这是一个新会话，可以开始提问。", 15f))
            if(chat.size >= chatLimit)body.addView(button("查看更早的消息") {chatLimit+=200;refreshRecords()},spaced())
            for (message in chat) {
                val role=message.role
                val text=message.text
                val user = role == "user"
                val bubble = column().apply {
                    background = rounded(if (user) Color.rgb(255, 240, 221) else PixelColors.pale)
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    addView(label(if (user) "我" else "I SEE YOU", 12f, true)); addView(label(text, 16f))
                }
                body.addView(bubble, LinearLayout.LayoutParams(-1, -2).apply {
                    marginStart=if(user)dp(18) else 0; marginEnd=if(user)0 else dp(18); topMargin=dp(10)
                })
            }
            if(recordsTab==RecordsTab.CURRENT)conversationScroll?.post { conversationScroll?.fullScroll(View.FOCUS_DOWN) }
        } else lifecycleScope.launch {
            val items = try { records.all() } catch(error: Exception) {
                if(error is CancellationException) throw error
                if(conversationBody === body) body.addView(label(error.message ?: "电脑记忆暂时不可用",15f))
                return@launch
            }
            if (conversationBody !== body || !showingMemories) return@launch
            if (items.length() == 0) body.addView(label("还没有物品记忆。开始后说“记住水杯”，自动保存当时画面。", 15f))
            repeat(items.length()) { index ->
                val item = items.getJSONObject(index)
                body.addView(column().apply {
                    background = rounded(PixelColors.pale); setPadding(dp(12), dp(10), dp(12), dp(10))
                    addView(label(item.getString("name"), 18f, true))
                    addView(label((if(item.optInt("sample_count")>0) "已保存目标参考照片" else if(item.optBoolean("appearance_observed"))"已保存外观描述和参考画面" else "尚无外观记录")+" · 上次位置记录：${item.optString("location")}", 14f))
                    item.optString("capture_status_label").takeIf(String::isNotBlank)?.let { addView(label(it,14f)) }
                    if(item.optString("suggested_location").isNotBlank()) addView(label("画面分析的待确认线索：${item.optString("suggested_location")}",13f))
                    item.optString("appearance").takeIf(String::isNotBlank)?.let { addView(label(it, 14f)) }
                    val rememberedAt = java.time.Instant.parse(item.getString("created_at")).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm:ss"))
                    addView(label("记住时间：$rememberedAt", 13f))
                    addView(button("找这件") {
                        recordDialog?.dismiss(); action { if (!controller.state.value.running) startSession(enableVoice = false); controller.search(item.getString("name"), item.getString("id")) }
                    }, spaced())
                    addView(button("位置历史") { showLocationHistory(item) }, spaced())
                    addView(button("更新这件的外观") {
                        recordDialog?.dismiss(); action { if (!controller.state.value.running) startSession(enableVoice = false); controller.remember(item.getString("name"), item.getString("id")) }
                    }, spaced())
                    addView(button("编辑记忆") { editMemory(item) }, spaced())
                    addView(button("删除记忆") {
                        android.app.AlertDialog.Builder(this@PixelHomeActivity).setTitle("删除这件物品？").setMessage(item.getString("name"))
                            .setNegativeButton("取消", null).setPositiveButton("删除") { _, _ -> action {
                                records.delete(item); if (controller.state.value.rememberedObjectId == item.getString("id")) controller.cancelSearch(); refreshRecords()
                            } }.show()
                    }, spaced())
                }, spaced())
            }
        }
    }

    private fun editMemory(item: JSONObject) {
        val (dialog, body) = sheet("编辑记忆")
        val name = input("物品名称").apply { setText(item.getString("name")) }
        val appearance = input("外观描述").apply { setText(item.optString("appearance")) }
        val location = input("你提供的位置（未经相机核实）").apply { setText(item.getString("location")) }
        body.addView(name); body.addView(appearance, spaced()); body.addView(location, spaced())
        body.addView(button("保存", true) { action {
            val update = JSONObject(item.toString()).put("name", name.text.toString()).put("appearance", appearance.text.toString()).put("location", location.text.toString())
            records.edit(update); if (controller.state.value.rememberedObjectId == item.getString("id")) controller.cancelSearch(); dialog.dismiss(); refreshRecords()
        } }, spaced())
        dialog.showSized()
    }

    private fun showObjectChoices(state: AssistantState) {
        val ids = state.objectChoices.map { it.id }
        if (ids == shownChoices) return
        choiceDialog?.dismiss(); choiceDialog = null; shownChoices = ids
        if (ids.isEmpty() || !foreground) return
        choiceDialog = android.app.AlertDialog.Builder(this).setTitle("有同名物品，请选择")
            .setItems(state.objectChoices.mapIndexed { index, item -> "第${index + 1}件：${item.name}\n${item.detail}" }.toTypedArray()) { _, index ->
                action { controller.selectObject(ids[index]) }
            }.setNegativeButton("取消") { _, _ -> controller.cancelSearch() }
            .setOnCancelListener { controller.cancelSearch() }.show()
    }

    private fun showLocationHistory(item: JSONObject) {
        action {
            val events = records.history(item.getString("id"))
            val (dialog, body) = sheet("${item.getString("name")}的位置历史")
            body.addView(label("这是过去的记录，不能证明物品现在仍在那里。", 15f))
            if (events.isEmpty()) body.addView(label("还没有位置记录。编辑记忆可添加你提供的位置；说“记住水杯的位置”会先进行图片复核。", 15f), spaced())
            val formatter = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(java.time.ZoneId.systemDefault())
            events.forEach { event ->
                val observed = event.observedAtMs?.let { "\n观察时间：${formatter.format(java.time.Instant.ofEpochMilli(it))}" }.orEmpty()
                body.addView(label("${event.location}\n${locationSourceLabel(event.source)}\n记录时间：${formatter.format(java.time.Instant.ofEpochMilli(event.recordedAtMs))}$observed", 15f), spaced())
            }
            dialog.showSized()
        }
    }

    private fun appendChat(role: String, text: String) {
        if (text.isBlank() || resettingConversation) return
        if(conversations.append(role,text) && recordsTab == RecordsTab.CURRENT)refreshRecords()
    }

    private fun restoreChat() {
        conversations.initialize()
    }

    private suspend fun newConversation() {
        resettingConversation=true
        try {
            pcConnectionJob?.cancelAndJoin()
            sessionSerial++
            conversations.newSession()
            controller.resetConversation()
            yoloPreview.clearFrame()
            lastSpeech=null
            recordsTab=RecordsTab.CURRENT
            selectedHistory=null
            chatLimit=200
        } finally {
            resettingConversation=false
            refreshRecords()
        }
    }

    private fun sheet(title: String, scroll: Boolean = true): Pair<Dialog, LinearLayout> {
        val dialog = Dialog(this)
        val panel = column().apply { background = PixelBorder(PixelColors.paper, resources.displayMetrics.density); setPadding(dp(18), dp(14), dp(18), dp(18)) }
        val heading = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        heading.addView(label(title, 21f, true), LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(button("×") { dialog.dismiss() }.apply { contentDescription = "关闭$title" }, LinearLayout.LayoutParams(dp(44), dp(44)))
        panel.addView(heading)
        val body = column()
        if(scroll)panel.addView(ScrollView(this).apply { isFillViewport = false; addView(body) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        else panel.addView(body, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin=dp(12) })
        dialog.setContentView(panel); dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        return dialog to body
    }

    private fun Dialog.showSized(expand: Boolean = false) {
        show()
        window?.setLayout(minOf(resources.displayMetrics.widthPixels - dp(24), dp(440)), if(expand)resources.displayMetrics.heightPixels-dp(100) else -2)
        window?.decorView?.post {
            val available = resources.displayMetrics.heightPixels - dp(100)
            if ((window?.decorView?.height ?: 0) > available) window?.setLayout(minOf(resources.displayMetrics.widthPixels - dp(24), dp(440)), available)
        }
    }

    private fun menuButton(title: String, subtitle: String, onClick: () -> Unit) = button("", onClick = onClick).apply {
        text = android.text.SpannableString("$title  ›\n$subtitle").apply {
            val start = indexOf('\n') + 1
            setSpan(android.text.style.RelativeSizeSpan(.78f), start, length, 0)
            setSpan(android.text.style.ForegroundColorSpan(PixelColors.muted), start, length, 0)
            setSpan(android.text.style.StyleSpan(Typeface.NORMAL), start, length, 0)
        }
        gravity = Gravity.START or Gravity.CENTER_VERTICAL; textSize = 17f; minHeight = dp(82)
    }
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun label(value: String, size: Float, bold: Boolean = false) = TextView(this).apply {
        text = value; textSize = size; setTextColor(PixelColors.ink); if (bold) setTypeface(typeface, Typeface.BOLD)
    }
    private fun button(value: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        text = value; textSize = 16f; isAllCaps = false; minHeight = dp(48); minimumHeight = dp(48)
        setTextColor(if (primary) Color.WHITE else PixelColors.ink); setTypeface(typeface, Typeface.BOLD)
        background = if (primary) PixelBorder(PixelColors.blue, resources.displayMetrics.density) else rounded(PixelColors.pale)
        setPadding(dp(12), dp(8), dp(12), dp(8)); setOnClickListener { onClick() }
    }
    private fun input(hintText: String) = EditText(this).apply {
        hint = hintText; contentDescription = hintText; textSize = 16f; setTextColor(PixelColors.ink)
        background = rounded(Color.rgb(243, 249, 255)); setPadding(dp(12), dp(8), dp(12), dp(8)); minHeight = dp(48); setSingleLine()
        filters = arrayOf(android.text.InputFilter.LengthFilter(600))
    }
    private fun rounded(fill: Int) = GradientDrawable().apply { setColor(fill); cornerRadius = dp(8).toFloat(); setStroke(dp(1), PixelColors.line) }
    private fun spaced() = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun notify(message: String) { detail.text = message; Toast.makeText(this, message, Toast.LENGTH_LONG).show() }

    @Suppress("DEPRECATION", "MissingPermission")
    private fun currentSsid(): String = runCatching {
        val ssid = if (Build.VERSION.SDK_INT >= 29) {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            (manager.getNetworkCapabilities(manager.activeNetwork)?.transportInfo as? WifiInfo)?.ssid
        } else (getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo.ssid
        ssid.orEmpty().removeSurrounding("\"").takeUnless { it == WifiManager.UNKNOWN_SSID }.orEmpty()
    }.getOrDefault("")

    override fun onStart() {
        if(::controller.isInitialized)conversations.initialize()
        super.onStart(); foreground = true;if(::backup.isInitialized) backup.schedule()
        pcConnectionJob?.cancel()
        pcConnectionJob=lifecycleScope.launch {
            try { if(pc?.consumePreparedConnection()!=true)pc?.connectIfConfigured() }
            catch(error: CancellationException) { throw error }
            catch(error: Exception) { notify(error.message ?: "电脑连接暂未完成") }
        }
    }
    override fun onStop() {
        pcConnectionJob?.cancel();pcConnectionJob=null
        jevDiagnosticJob?.cancel()
        foreground = false; sessionSerial++
        pendingPermission?.complete(false); pendingPermission = null
        lifecycleScope.launch { actionMutex.lock(); try { controller.stop(); provisioner.cancel() } finally { actionMutex.unlock() } }
        super.onStop()
    }
    override fun onDestroy() {
        foreground = false; sessionSerial++
        if(::backup.isInitialized) backup.close()
        speech.close()
        // Finish native cleanup even though the activity lifecycle is being cancelled.
        CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()).launch {
            actionMutex.lock()
            try { controller.stop(); provisioner.cancel(); (detector as? java.io.Closeable)?.close(); yoloPreview.clearFrame() }
            finally { actionMutex.unlock(); cancel() }
        }
        super.onDestroy()
    }
}

private fun Bitmap.rotated(degrees: Int): Bitmap {
    if (degrees % 360 == 0) return this
    return Bitmap.createBitmap(this, 0, 0, width, height, Matrix().apply { postRotate(degrees.toFloat()) }, true).also { recycle() }
}
