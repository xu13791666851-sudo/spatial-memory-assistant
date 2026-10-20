package com.spatialmemory.assistant.orchestrator

import com.spatialmemory.assistant.camera.CameraSource
import com.spatialmemory.assistant.camera.FramePacket
import com.spatialmemory.assistant.inference.Detection

enum class SearchState { IDLE, LEARNING, SEARCHING, VERIFYING, GUIDING, COMPLETED, CANCELLED }

data class AnalyzedFrame(val frame: FramePacket, val detections: List<Detection>)

data class AssistantState(
    val running: Boolean = false,
    val target: String? = null,
    val searchId: String? = null,
    val searchState: SearchState = SearchState.IDLE,
    val source: CameraSource? = null,
    val frameId: Long? = null,
    val frameAgeMs: Long? = null,
    val detections: List<Detection> = emptyList(),
    val rememberedObjectId: String? = null,
    val learningSamples: Int = 0,
    val candidateScore: Float? = null,
    val appearanceSimilarity: Float? = null,
    val yoloLatencyMs: Long? = null,
    val embeddingLatencyMs: Long? = null,
    val qwenVerifying: Boolean = false,
    val candidateBox: List<Float>? = null,
    val verifiedAtMs: Long = 0,
    val qwenLatencyMs: Long? = null,
    val lastSpeech: String? = null,
    val message: String = "尚未开始",
    val error: String? = null,
)

internal fun AssistantState.messageWhileProcessing(frameId: Long): String = when (searchState) {
    SearchState.LEARNING, SearchState.VERIFYING, SearchState.GUIDING, SearchState.COMPLETED, SearchState.CANCELLED -> message
    else -> "已收到第 $frameId 帧，YOLO 推理中…"
}
