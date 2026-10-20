package com.spatialmemory.assistant.realtime

import com.spatialmemory.assistant.camera.FramePacket
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

enum class RealtimeState { DISCONNECTED, CONNECTING, CONNECTED, FAILED }
sealed interface QwenEvent {
    data class Transcript(val role: String, val text: String) : QwenEvent
    data class TargetVisible(
        val taskId: String,
        val candidateId: String,
        val frameId: Long,
        val visible: Boolean,
        val sameObject: Boolean,
        val direction: String?,
        val anchor: String?,
        val objectState: String?,
        val confidence: Float,
    ) : QwenEvent
    data class Error(val message: String) : QwenEvent
}

data class CandidateVerificationRequest(
    val taskId: String,
    val candidateId: String,
    val frameId: Long,
    val target: String,
    val description: String?,
    val label: String,
    val confidence: Float,
    val normalizedBox: List<Float>,
)

interface QwenRealtimeClient {
    val state: StateFlow<RealtimeState>
    val events: Flow<QwenEvent>
    suspend fun connect()
    suspend fun sendFrame(frame: FramePacket, prompt: String)
    suspend fun verifyCandidate(fullFrame: FramePacket, cropFrame: FramePacket, request: CandidateVerificationRequest)
    suspend fun inspectTarget(frame: FramePacket, request: CandidateVerificationRequest)
    suspend fun sendText(text: String)
    fun setMicrophoneEnabled(enabled: Boolean)
    suspend fun interrupt()
    suspend fun disconnect()
}
