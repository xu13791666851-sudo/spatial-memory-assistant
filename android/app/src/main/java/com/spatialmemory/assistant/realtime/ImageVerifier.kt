package com.spatialmemory.assistant.realtime

import com.spatialmemory.assistant.camera.FramePacket

/** Image review owns its result and cancellation; it never uses the voice event bus. */
interface ImageVerifier {
    suspend fun verify(fullFrame: FramePacket, cropFrame: FramePacket?, request: CandidateVerificationRequest, references: List<ByteArray> = emptyList()): ImageReview
}

enum class ImageDecision { CONFIRMED, REJECTED, UNCERTAIN }
data class MemoryObservation(val normalizedBox: List<Float>,val location: String?,val anchor: String?,val locationConfidence: Float,
    val targetVisible: Boolean=true,val appearanceClear: Boolean=true,val failureKind: String="",
    val visibilityConfidence: Float=0f,val clarityConfidence: Float=0f,val boxConfidence: Float=0f)

data class ImageReview(val decision: ImageDecision, val result: QwenEvent.TargetVisible?, val reason: String = "",val observation: MemoryObservation? = null) {
    val visible: Boolean get() = decision == ImageDecision.CONFIRMED
}

/** A positive result must still describe the current source/task/object revision. */
internal object EvidenceFreshness {
    fun accepts(capturedAtMs: Long, nowMs: Long, sameSource: Boolean, sameTask: Boolean, sameRevision: Boolean, sceneDifference: Float): Boolean =
        nowMs >= capturedAtMs && nowMs - capturedAtMs <= 12_000 && sameSource && sameTask && sameRevision && sceneDifference.isFinite() && sceneDifference < 18f
}
