package com.spatialmemory.assistant.ui

import android.Manifest
import android.app.Dialog
import android.content.Context
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
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.debug.YoloPreviewView
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
    private lateinit var detector: YoloDetector
    private lateinit var records: NativeRecords
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
    private var showingMemories = false
    private var lastSpeech: String? = null
    private val chat = mutableListOf<Pair<String, String>>()
    private val actionMutex = kotlinx.coroutines.sync.Mutex()
    private val prefs by lazy { getSharedPreferences("iseeyou-native", MODE_PRIVATE) }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        pendingPermission?.complete(result.values.all { it }); pendingPermission = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildHome()
        restoreChat()
        detector = YoloDetector(this)
        val database = AppDatabase.get(this)
        val repository = MemoryRepository(this, database.memoryDao(), database.objectMemoryDao())
        records = NativeRecords(this, database, repository)
        val credential = NativeGatewayCredentialClient(BuildConfig.GATEWAY_URL)
        qwen = AoqQwenRealtimeClient(this, credential::get, QwenImageVerifier("", gateway = BuildConfig.GATEWAY_URL))
        speech = SpeechCoordinator(this) { enabled -> qwen.setMicrophoneEnabled(enabled && foreground && controller.state.value.running) }
        qwen.setPlaybackEnabled(!prefs.getBoolean("reader", false))
        speech.setEnabled(!prefs.getBoolean("reader", false) && prefs.getBoolean("readLocal", true))
        controller = AssistantController(AssistantOrchestrator(detector, TargetMatcher(this), PerceptionEngine(TargetMatcher(this), HistogramObjectEmbedder()), repository, qwen, speech, File(cacheDir, "active-search-candidate")))
        provisioner = Esp32Provisioner(this)
        prefs.getString("esp32", null)?.let { raw -> runCatching {
            val value = JSONObject(raw)
            esp32 = Esp32Connection(value.getString("baseUrl"), value.getString("streamUrl"), value.optString("deviceId"), value.optString("token"), value.optBoolean("legacy"))
        } }
        lifecycleScope.launch { controller.state.collect { state ->
            val memoryChanged = state.rememberedObjectId != lastState.rememberedObjectId
            lastState = state
            renderState(state)
            state.lastSpeech?.takeIf { it.isNotBlank() && it != lastSpeech }?.let { lastSpeech = it; appendChat("assistant", it) }
            if (memoryChanged && showingMemories) refreshRecords()
        } }
        lifecycleScope.launch { qwen.state.collect { renderState(lastState) } }
        lifecycleScope.launch { qwen.events.collect { event ->
            if (event is QwenEvent.Transcript) {
                appendChat(event.role, event.text)
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

    private suspend fun requirePermissions(hardware: Boolean = false): Boolean {
        val needed = buildList {
            if (hardware) {
                if (Build.VERSION.SDK_INT >= 31) { add(Manifest.permission.BLUETOOTH_SCAN); add(Manifest.permission.BLUETOOTH_CONNECT) }
                else add(Manifest.permission.ACCESS_FINE_LOCATION)
            } else { if (sourceKind == "phone") add(Manifest.permission.CAMERA); add(Manifest.permission.RECORD_AUDIO) }
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) return true
        if (pendingPermission != null) return false
        val result = CompletableDeferred<Boolean>(); pendingPermission = result
        permission.launch(needed.toTypedArray()); return result.await()
    }

    private suspend fun startSession() {
        check(requirePermissions()) { "请允许相机和麦克风后再开始。" }
        check(foreground) { "请返回应用后再开始。" }
        sessionSerial++
        headline.text = "正在启动…"
        val source = when (sourceKind) {
            "esp32" -> Esp32CameraSource(Esp32Api(checkNotNull(esp32) { "请先连接摄像头。" }))
            else -> PhoneCameraSource(this, this, cameraPreview)
        }
        controller.start(source)
    }

    private suspend fun stopSession() { sessionSerial++; controller.stop(); yoloPreview.clearFrame() }

    private fun renderState(state: AssistantState) {
        voiceButton.text = if (state.running) "结束" else "语音找物"
        sourceLabel.text = if (state.source == CameraSource.ESP32 || sourceKind == "esp32") "● 外接摄像头" else "● 手机摄像头"
        headline.text = when {
            !state.running -> if (state.error != null) "启动没有完成" else "点击语音找物开始"
            state.searchState == SearchState.LEARNING -> "正在记住：${state.target}"
            state.searchState == SearchState.VERIFYING -> "发现疑似物品，正在确认"
            state.searchState == SearchState.SEARCHING -> "正在寻找：${state.target}"
            else -> state.message.takeUnless { it.startsWith("YOLO") || it.startsWith("已收到第") } ?: "说出你想找或记住的物品"
        }
        detail.text = when {
            !state.running -> state.error ?: "准备好后说：帮我找水杯，或记住水杯"
            state.error != null -> state.error
            state.searchState == SearchState.LEARNING -> "外观样本 ${state.learningSamples}/3 · 请按语音提示调整角度"
            qwen.state.value == RealtimeState.FAILED || qwen.state.value == RealtimeState.DISCONNECTED -> "本地识别运行中 · 语音未连接，请结束后重试"
            qwen.state.value != RealtimeState.CONNECTED -> "本地识别运行中 · 语音正在连接"
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
            stopSession(); sourceKind = kind
            cameraPreview.visibility = if (kind == "phone") View.VISIBLE else View.INVISIBLE
            renderState(controller.state.value)
            if (restart) startSession()
        }
    }

    private fun saveEsp32() {
        esp32?.let { prefs.edit().putString("esp32", JSONObject().put("baseUrl", it.baseUrl).put("streamUrl", it.streamUrl).put("deviceId", it.deviceId).put("token", it.token).put("legacy", it.legacyCameraWebServer).toString()).apply() }
    }

    private fun showRecords() {
        val (dialog, body) = sheet("记录")
        recordDialog = dialog
        val tabs = LinearLayout(this)
        val conversation = button("对话") { showingMemories = false; refreshRecords() }
        val memories = button("物品记忆") { showingMemories = true; refreshRecords() }
        tabs.addView(conversation, LinearLayout.LayoutParams(0, dp(48), 1f))
        tabs.addView(memories, LinearLayout.LayoutParams(0, dp(48), 1f).apply { marginStart = dp(8) })
        body.addView(tabs)
        conversationBody = column(); body.addView(conversationBody, spaced())
        // A text fallback remains in Records, keeping the camera and settings uncluttered.
        val typed = input("输入你想说的话")
        body.addView(typed, spaced())
        body.addView(button("发送") {
            val text = typed.text.toString().trim()
            if (text.isBlank()) return@button
            action {
                if (!controller.state.value.running) startSession()
                appendChat("user", text); controller.submitText(text); typed.text.clear()
            }
        }, spaced())
        body.addView(button("回到首页") { dialog.dismiss() }, spaced())
        dialog.setOnDismissListener { recordDialog = null; conversationBody = null }
        refreshRecords(); dialog.showSized()
    }

    private fun refreshRecords() {
        val body = conversationBody ?: return
        body.removeAllViews()
        if (!showingMemories) {
            if (chat.isEmpty()) body.addView(label("开始对话后，记录会保存在这里。", 15f))
            for ((role, text) in chat) {
                val user = role == "user"
                val bubble = column().apply {
                    background = rounded(if (user) Color.rgb(255, 240, 221) else PixelColors.pale)
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    addView(label(if (user) "我" else "I SEE YOU", 12f, true)); addView(label(text, 16f))
                }
                body.addView(bubble, LinearLayout.LayoutParams((resources.displayMetrics.widthPixels * .70).toInt(), -2).apply { gravity = if (user) Gravity.END else Gravity.START; topMargin = dp(10) })
            }
        } else lifecycleScope.launch {
            val items = records.all()
            if (conversationBody !== body || !showingMemories) return@launch
            if (items.length() == 0) body.addView(label("还没有物品记忆。开始后说“记住水杯”，按提示完成采集。", 15f))
            repeat(items.length()) { index ->
                val item = items.getJSONObject(index)
                body.addView(column().apply {
                    background = rounded(PixelColors.pale); setPadding(dp(12), dp(10), dp(12), dp(10))
                    addView(label(item.getString("name"), 18f, true))
                    addView(label("${item.optInt("sample_count")} 个外观样本 · ${item.optString("location")}", 14f))
                    addView(button("找这件") {
                        recordDialog?.dismiss(); action { if (!controller.state.value.running) startSession(); controller.search(item.getString("name")) }
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
        val location = input("位置线索").apply { setText(item.getString("location")) }
        body.addView(name); body.addView(appearance, spaced()); body.addView(location, spaced())
        body.addView(button("保存", true) { action {
            val update = JSONObject(item.toString()).put("name", name.text.toString()).put("appearance", appearance.text.toString()).put("location", location.text.toString())
            records.edit(update); if (controller.state.value.rememberedObjectId == item.getString("id")) controller.cancelSearch(); dialog.dismiss(); refreshRecords()
        } }, spaced())
        dialog.showSized()
    }

    private fun appendChat(role: String, text: String) {
        if (text.isBlank()) return
        val value = (if (role == "user") "user" else "assistant") to text
        if (chat.lastOrNull() == value) return
        chat.add(value); while (chat.size > 200) chat.removeAt(0)
        prefs.edit().putString("native-chat", JSONArray().apply { chat.forEach { put(JSONObject().put("role", it.first).put("text", it.second)) } }.toString()).apply()
        if (!showingMemories) refreshRecords()
    }

    private fun restoreChat() {
        runCatching { JSONArray(prefs.getString("native-chat", "[]")) }.getOrNull()?.let { items ->
            repeat(items.length()) { val item = items.optJSONObject(it); if (item != null) chat.add(item.optString("role") to item.optString("text")) }
        }
    }

    private fun sheet(title: String): Pair<Dialog, LinearLayout> {
        val dialog = Dialog(this)
        val panel = column().apply { background = PixelBorder(PixelColors.paper, resources.displayMetrics.density); setPadding(dp(18), dp(14), dp(18), dp(18)) }
        val heading = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        heading.addView(label(title, 21f, true), LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(button("×") { dialog.dismiss() }.apply { contentDescription = "关闭$title" }, LinearLayout.LayoutParams(dp(44), dp(44)))
        panel.addView(heading)
        val body = column()
        panel.addView(ScrollView(this).apply { isFillViewport = false; addView(body) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        dialog.setContentView(panel); dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        return dialog to body
    }

    private fun Dialog.showSized() {
        show()
        window?.setLayout(minOf(resources.displayMetrics.widthPixels - dp(24), dp(440)), -2)
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

    override fun onStart() { super.onStart(); foreground = true }
    override fun onStop() {
        foreground = false; sessionSerial++
        pendingPermission?.complete(false); pendingPermission = null
        lifecycleScope.launch { actionMutex.lock(); try { controller.stop(); provisioner.cancel() } finally { actionMutex.unlock() } }
        super.onStop()
    }
    override fun onDestroy() {
        foreground = false; sessionSerial++
        speech.close()
        // Finish native cleanup even though the activity lifecycle is being cancelled.
        CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()).launch {
            actionMutex.lock()
            try { controller.stop(); provisioner.cancel(); detector.close(); yoloPreview.clearFrame() }
            finally { actionMutex.unlock(); cancel() }
        }
        super.onDestroy()
    }
}

private fun Bitmap.rotated(degrees: Int): Bitmap {
    if (degrees % 360 == 0) return this
    return Bitmap.createBitmap(this, 0, 0, width, height, Matrix().apply { postRotate(degrees.toFloat()) }, true).also { recycle() }
}
