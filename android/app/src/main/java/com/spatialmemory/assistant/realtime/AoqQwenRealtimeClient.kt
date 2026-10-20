package com.spatialmemory.assistant.realtime

import android.content.Context
import android.graphics.BitmapFactory
import android.os.SystemClock
import com.alibaba.aoq.clientsdk.AoqClientEngine
import com.alibaba.aoq.clientsdk.AoqClientListener
import com.spatialmemory.assistant.camera.FramePacket
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class AoqQwenRealtimeClient(
    private val context: Context,
    private val credentialProvider: suspend () -> AoqCredential,
    private val imageVerifier: QwenImageVerifier,
) : QwenRealtimeClient {
    private var playbackEnabled = true
    fun setPlaybackEnabled(enabled: Boolean) { playbackEnabled = enabled; engine?.let { if (enabled) it.startAudioPlayer(AoqClientEngine.AoqAudioPlaybackConfig()) else it.stopAudioPlayer() } }
    private val mutableState = MutableStateFlow(RealtimeState.DISCONNECTED)
    private val mutableEvents = MutableSharedFlow<QwenEvent>(extraBufferCapacity = 16)
    override val state = mutableState.asStateFlow()
    override val events = mutableEvents.asSharedFlow()
    @Volatile private var engine: AoqClientEngine? = null
    private data class ResponseSpec(val instructions: String, val textOnly: Boolean)
    private val responseGate = ResponseRequestGate<ResponseSpec>()
    private val mediaOrderGate = MediaOrderGate()
    private val handledToolCalls = mutableSetOf<String>()

    private val listener = object : AoqClientListener() {
        override fun onConnectionStatusChange(status: AoqClientEngine.AoqConnectionStatus) {
            when (status) {
                AoqClientEngine.AoqConnectionStatus.AoqConnectionStatusConnected -> sendSessionUpdate()
                AoqClientEngine.AoqConnectionStatus.AoqConnectionStatusFailed -> fail("千问实时连接失败")
                AoqClientEngine.AoqConnectionStatus.AoqConnectionStatusDisconnected -> mutableState.value = RealtimeState.DISCONNECTED
                else -> Unit
            }
        }

        override fun onError(code: Int, message: String?) = handleError("千问错误 $code：${message.orEmpty()}")

        override fun onDataMsg(msg: AoqClientEngine.AoqDataMsg) {
            val data = msg.data ?: return
            runCatching { JSONObject(String(data, StandardCharsets.UTF_8)) }.onSuccess(::handleEvent)
        }
    }

    override suspend fun connect() = withContext(Dispatchers.IO) {
        if (engine != null) return@withContext
        responseGate.reset()
        mediaOrderGate.reset()
        synchronized(handledToolCalls) { handledToolCalls.clear() }
        mutableState.value = RealtimeState.CONNECTING
        val credential = credentialProvider()
        val create = AoqClientEngine.AoqCreateConfig().apply {
            workDir = context.cacheDir.absolutePath
            maxEncodedVideoFrameBytes = 512 * 1024
            enableDropOversizedVideoFrame = true
        }
        val created = AoqClientEngine.createEngine(context.applicationContext, create, listener)
            ?: error("无法创建 AOQ 引擎")
        engine = created
        created.setVideoEncoderConfig(AoqClientEngine.AoqVideoCodecConfig().apply {
            trackType = AoqClientEngine.AoqTrackType.AoqTrackTypeVideo
            codecType = AoqClientEngine.AoqEncoderType.AoqEncoderTypeVideoJpeg
            width = 640; height = 480; fps = 2; isExternal = true
        }).requireOk("配置外部 JPEG")
        created.startAudioCapture(AoqClientEngine.AoqAudioCaptureConfig()).requireOk("启动麦克风")
        if (playbackEnabled) created.startAudioPlayer(AoqClientEngine.AoqAudioPlaybackConfig()).requireOk("启动扬声器")
        created.enableSendMediaStream(AoqClientEngine.AoqTrackType.AoqTrackTypeAudio, false)
        created.enableSendMediaStream(AoqClientEngine.AoqTrackType.AoqTrackTypeVideo, false)
        created.connect(credential.toConnectConfig()).requireOk("连接千问")
        withTimeout(10_000) {
            mutableState.first { it == RealtimeState.CONNECTED || it == RealtimeState.FAILED }
        }
        check(mutableState.value == RealtimeState.CONNECTED) { "千问实时连接失败" }
        delay(1_000)
    }

    override suspend fun sendFrame(frame: FramePacket, prompt: String) {
        pushFrame(frame)
        if (prompt.isNotBlank()) sendResponseRequest(prompt, textOnly = false)
    }

    override suspend fun verifyCandidate(fullFrame: FramePacket, cropFrame: FramePacket, request: CandidateVerificationRequest) {
        mutableEvents.emit(imageVerifier.verify(fullFrame, cropFrame, request))
    }

    override suspend fun inspectTarget(frame: FramePacket, request: CandidateVerificationRequest) {
        mutableEvents.emit(imageVerifier.verify(frame, null, request))
    }

    private fun pushFrame(frame: FramePacket) {
        val active = engine ?: return
        if (!mediaOrderGate.canSendVideo(SystemClock.elapsedRealtime())) return
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size, options)
        if (options.outWidth <= 0 || options.outHeight <= 0) return
        val encoded = AoqClientEngine.AoqVideoEncodedFrame().apply {
            codec = AoqClientEngine.AoqVideoCodecType.AoqVideoCodecTypeJPEG
            data = frame.jpeg
            width = options.outWidth
            height = options.outHeight
            timeStamp = frame.capturedAtMs
        }
        val result = active.pushExternalVideoEncodedFrame(AoqClientEngine.AoqTrackType.AoqTrackTypeVideo, encoded)
        if (result != 0) mutableEvents.tryEmit(QwenEvent.Error("千问视频帧发送失败：$result"))
    }

    override suspend fun sendText(text: String) {
        sendJson(JSONObject()
            .put("event_id", UUID.randomUUID().toString())
            .put("type", "conversation.item.create")
            .put("item", JSONObject().put("type", "message").put("role", "user").put("content", JSONArray().put(JSONObject().put("type", "input_text").put("text", text)))))
        sendResponseRequest("请结合当前视频和用户刚才的话简短回答。", textOnly = false)
    }

    override fun setMicrophoneEnabled(enabled: Boolean) {
        engine?.enableSendMediaStream(AoqClientEngine.AoqTrackType.AoqTrackTypeAudio, enabled)
    }

    override suspend fun interrupt() {
        engine?.interruptAudioPlayer(AoqClientEngine.AoqTrackType.AoqTrackTypeAudio, -1)
        sendJson(JSONObject().put("event_id", UUID.randomUUID().toString()).put("type", "response.cancel"))
        setMicrophoneEnabled(true)
    }

    override suspend fun disconnect() = withContext(Dispatchers.IO) {
        val active = engine ?: return@withContext
        engine = null
        runCatching { active.enableSendMediaStream(AoqClientEngine.AoqTrackType.AoqTrackTypeAudio, false) }
        runCatching { active.enableSendMediaStream(AoqClientEngine.AoqTrackType.AoqTrackTypeVideo, false) }
        runCatching { active.stopAudioCapture() }
        runCatching { active.stopAudioPlayer() }
        runCatching { active.disconnect() }
        AoqClientEngine.destroy()
        responseGate.reset()
        mediaOrderGate.reset()
        synchronized(handledToolCalls) { handledToolCalls.clear() }
        mutableState.value = RealtimeState.DISCONNECTED
    }

    private fun sendSessionUpdate() {
        val instructions = context.assets.open("assistant_prompt_zh.txt").bufferedReader().use { it.readText() }
        val tools = JSONArray(context.assets.open("qwen_tools.json").bufferedReader().use { it.readText() })
        val session = JSONObject()
            .put("modalities", JSONArray().put("text").put("audio"))
            .put("voice", "Tina")
            .put("instructions", instructions)
            .put("turn_detection", JSONObject().put("type", "semantic_vad"))
            .put("tools", tools)
        sendJson(JSONObject().put("event_id", UUID.randomUUID().toString()).put("type", "session.update").put("session", session))
    }

    private fun handleEvent(value: JSONObject) {
        when (value.optString("type")) {
            "session.updated" -> {
                engine?.enableSendMediaStream(AoqClientEngine.AoqTrackType.AoqTrackTypeAudio, true)
                engine?.enableSendMediaStream(AoqClientEngine.AoqTrackType.AoqTrackTypeVideo, true)
                mediaOrderGate.audioStarted(SystemClock.elapsedRealtime())
                mutableState.value = RealtimeState.CONNECTED
            }
            "response.created" -> responseGate.started()
            "response.done" -> {
                value.optJSONObject("response")?.optJSONArray("output")?.let { output ->
                    repeat(output.length()) { handleOutputItem(output.optJSONObject(it)) }
                }
                responseGate.finished()?.let(::sendResponseNow)
            }
            "response.audio_transcript.done", "response.text.done" -> value.optString("transcript", value.optString("text")).takeIf { it.isNotBlank() }?.let {
                handleAssistantText(it)
            }
            "conversation.item.input_audio_transcription.completed" -> value.optString("transcript").takeIf { it.isNotBlank() }?.let {
                mutableEvents.tryEmit(QwenEvent.Transcript("user", it))
            }
            "response.function_call_arguments.done" -> handleToolCall(value.optString("name"), value.optString("call_id"), value.optString("arguments", "{}"))
            "response.output_item.done" -> handleOutputItem(value.optJSONObject("item"))
            "error" -> handleError(value.optJSONObject("error")?.optString("message") ?: "千问返回未知错误")
        }
    }

    private fun sendResponseRequest(instructions: String, textOnly: Boolean) {
        responseGate.request(ResponseSpec(instructions, textOnly))?.let(::sendResponseNow)
    }

    private fun handleOutputItem(item: JSONObject?) {
        when (item?.optString("type")) {
            "function_call" -> handleToolCall(item.optString("name"), item.optString("call_id"), item.optString("arguments", "{}"))
            "message" -> item.optJSONArray("content")?.let { content ->
                repeat(content.length()) {
                    content.optJSONObject(it)?.let { part ->
                        part.optString("text", part.optString("transcript")).takeIf(String::isNotBlank)?.let(::handleAssistantText)
                    }
                }
            }
        }
    }

    private fun handleToolCall(name: String, callId: String, arguments: String) {
        if (name != "report_target_visibility") return
        if (callId.isNotBlank() && !synchronized(handledToolCalls) { handledToolCalls.add(callId) }) return
        runCatching { QwenToolExecutor.parseTargetVisible(arguments) }
            .onSuccess {
                mutableEvents.tryEmit(it)
                if (callId.isNotBlank()) sendJson(JSONObject()
                    .put("event_id", UUID.randomUUID().toString())
                    .put("type", "conversation.item.create")
                    .put("item", JSONObject().put("type", "function_call_output").put("call_id", callId).put("output", "已接收确认结果")))
            }
            .onFailure { mutableEvents.tryEmit(QwenEvent.Error("千问确认结果格式错误：${it.message}")) }
    }

    private fun handleAssistantText(text: String) {
        mutableEvents.tryEmit(QwenEvent.Transcript("assistant", text))
    }

    private fun sendResponseNow(spec: ResponseSpec) = sendJson(JSONObject()
        .put("event_id", UUID.randomUUID().toString())
        .put("type", "response.create")
        .put("response", JSONObject().put("instructions", spec.instructions).apply {
            if (spec.textOnly) put("modalities", JSONArray().put("text"))
        }))

    private fun sendJson(value: JSONObject) {
        val active = engine ?: return
        val message = AoqClientEngine.AoqDataMsg().apply { data = value.toString().toByteArray(StandardCharsets.UTF_8) }
        val result = active.sendDataMsg(message)
        if (result != 0) mutableEvents.tryEmit(QwenEvent.Error("千问数据发送失败：$result"))
    }

    private fun handleError(message: String) {
        when {
            message.contains("no active response", ignoreCase = true) -> {
                val queued = responseGate.finished()
                if (queued != null) sendResponseNow(queued) else setMicrophoneEnabled(true)
            }
            message.contains("active response", ignoreCase = true) -> responseGate.rejectedBecauseActive()
            message.contains("append image before append audio", ignoreCase = true) -> {
                mediaOrderGate.audioStarted(SystemClock.elapsedRealtime())
            }
            else -> fail(message)
        }
    }

    private fun fail(message: String) {
        mutableState.value = RealtimeState.FAILED
        mutableEvents.tryEmit(QwenEvent.Error(message))
    }
}

private fun AoqCredential.toConnectConfig() = AoqClientEngine.AoqConnectConfig().also { config ->
    config.token = token
    config.sid = sid
    config.certFingerprint = certFingerprint
    config.workspaceIdHash = workspaceIdHash
    config.relayEndpoints = relayEndpoints.map { relay -> AoqClientEngine.AoqRelayEndpoint().also {
        it.endpoint = relay.endpoint; it.port = relay.port; it.routeIndex = relay.routeIndex
    } }
    fun track(type: AoqClientEngine.AoqTrackType) = AoqClientEngine.AoqTrackParam().also {
        it.trackType = type; it.trackMode = AoqClientEngine.AoqTrackMode.AoqTrackModeStream
    }
    config.publishTracks = listOf(track(AoqClientEngine.AoqTrackType.AoqTrackTypeAudio), track(AoqClientEngine.AoqTrackType.AoqTrackTypeVideo), track(AoqClientEngine.AoqTrackType.AoqTrackTypeData))
    config.subscribeTracks = listOf(track(AoqClientEngine.AoqTrackType.AoqTrackTypeAudio), track(AoqClientEngine.AoqTrackType.AoqTrackTypeData))
}

private fun Int.requireOk(action: String) { check(this == 0) { "$action 失败：$this" } }
