package com.spatialmemory.assistant.realtime

import com.spatialmemory.assistant.camera.FramePacket
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

class FakeQwenRealtimeClient : QwenRealtimeClient {
    private val mutableState = MutableStateFlow(RealtimeState.DISCONNECTED)
    private val mutableEvents = MutableSharedFlow<QwenEvent>(extraBufferCapacity = 8)
    override val state = mutableState.asStateFlow()
    override val events = mutableEvents.asSharedFlow()

    override suspend fun connect() { mutableState.value = RealtimeState.CONNECTED }
    override suspend fun sendFrame(frame: FramePacket, prompt: String) {
        if (prompt.isNotBlank()) mutableEvents.tryEmit(QwenEvent.Transcript("assistant", "模拟千问收到 ${frame.source} 画面：$prompt"))
    }
    override suspend fun verifyCandidate(fullFrame: FramePacket, cropFrame: FramePacket, request: CandidateVerificationRequest) = Unit
    override suspend fun inspectTarget(frame: FramePacket, request: CandidateVerificationRequest) = Unit
    override suspend fun sendText(text: String) {
        mutableEvents.tryEmit(QwenEvent.Transcript("user", text))
    }
    override suspend fun interrupt() = Unit
    override fun setMicrophoneEnabled(enabled: Boolean) = Unit
    override suspend fun disconnect() { mutableState.value = RealtimeState.DISCONNECTED }
}

class AoqSdkRequiredClient : QwenRealtimeClient {
    private val mutableState = MutableStateFlow(RealtimeState.DISCONNECTED)
    private val mutableEvents = MutableSharedFlow<QwenEvent>()
    override val state = mutableState.asStateFlow()
    override val events = mutableEvents.asSharedFlow()

    override suspend fun connect() {
        mutableState.value = RealtimeState.FAILED
        error("AOQ Android SDK 尚未放入 app/libs；请按 docs/AOQ接入点.md 接入官方 SDK")
    }
    override suspend fun sendFrame(frame: FramePacket, prompt: String) = Unit
    override suspend fun verifyCandidate(fullFrame: FramePacket, cropFrame: FramePacket, request: CandidateVerificationRequest) = Unit
    override suspend fun inspectTarget(frame: FramePacket, request: CandidateVerificationRequest) = Unit
    override suspend fun sendText(text: String) = Unit
    override suspend fun interrupt() = Unit
    override fun setMicrophoneEnabled(enabled: Boolean) = Unit
    override suspend fun disconnect() { mutableState.value = RealtimeState.DISCONNECTED }
}
