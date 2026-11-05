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
    data class Error(val message: String, val code: String? = null) : QwenEvent
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
    val requiresPersonalMatch: Boolean = false,
    val learning: Boolean = false,
    val memoryObservation: Boolean = false,
)

interface QwenRealtimeClient {
    val state: StateFlow<RealtimeState>
    val events: Flow<QwenEvent>
    suspend fun connect()
    suspend fun sendFrame(frame: FramePacket, prompt: String)
    suspend fun sendText(text: String)
    fun setMicrophoneEnabled(enabled: Boolean)
    fun setTaskMode(active: Boolean) = Unit
    suspend fun interpretUser(text: String,currentTarget: String?,knownNames: List<String>): com.spatialmemory.assistant.dialogue.DialogueIntent? = null
    suspend fun describeScene(frame: FramePacket,target: String?,question: String): SceneDescription? = null
    suspend fun interrupt()
    suspend fun disconnect()
}
