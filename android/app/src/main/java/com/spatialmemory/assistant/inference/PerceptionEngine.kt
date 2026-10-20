package com.spatialmemory.assistant.inference

import android.graphics.BitmapFactory
import com.spatialmemory.assistant.camera.FramePacket
import java.util.UUID

data class ObjectCandidate(
    val id: String,
    val taskId: String,
    val frameId: Long,
    val label: String,
    val yoloConfidence: Float,
    val appearanceSimilarity: Float?,
    val combinedScore: Float,
    val box: Box,
    val frame: FramePacket,
    val cropJpeg: ByteArray,
    val frameWidth: Int,
    val frameHeight: Int,
)

fun Box.centerX(frameWidth: Int): Float = ((left + right) / 2f / frameWidth).coerceIn(0f, 1f)

class PerceptionEngine(
    private val matcher: TargetMatcher,
    private val embedder: ObjectEmbedder,
) {
    fun candidates(
        frame: FramePacket,
        taskId: String,
        target: String,
        detections: List<Detection>,
        referenceEmbeddings: List<FloatArray>,
    ): List<ObjectCandidate> {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size, bounds)
        val rotated = frame.rotationDegrees % 180 != 0
        val frameWidth = if (rotated) bounds.outHeight else bounds.outWidth
        val frameHeight = if (rotated) bounds.outWidth else bounds.outHeight
        return detections.asSequence()
            .filter { matcher.matches(target, it.label) && it.confidence >= 0.50f }
            .map { detection ->
                val embedding = if (referenceEmbeddings.isEmpty()) null else embedder.embed(frame.jpeg, detection.box, frame.rotationDegrees)
                val similarity = embedding?.let { value -> referenceEmbeddings.maxOf { embedder.similarity(value, it) } }
                ObjectCandidate(
                    id = UUID.randomUUID().toString(),
                    taskId = taskId,
                    frameId = frame.id,
                    label = detection.label,
                    yoloConfidence = detection.confidence,
                    appearanceSimilarity = similarity,
                    combinedScore = similarity?.let { detection.confidence * 0.35f + it * 0.65f } ?: detection.confidence,
                    box = detection.box,
                    frame = frame,
                    cropJpeg = embedder.crop(frame.jpeg, detection.box, frame.rotationDegrees),
                    frameWidth = frameWidth,
                    frameHeight = frameHeight,
                )
            }
            .sortedByDescending { it.combinedScore }
            .toList()
    }

    fun learningSample(frame: FramePacket, target: String, detections: List<Detection>): Pair<ByteArray, FloatArray> {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size, options)
        val rotated = frame.rotationDegrees % 180 != 0
        val width = (if (rotated) options.outHeight else options.outWidth).toFloat()
        val height = (if (rotated) options.outWidth else options.outHeight).toFloat()
        val match = detections.filter { matcher.matches(target, it.label) }
            .minByOrNull { kotlin.math.abs((it.box.left + it.box.right) / 2 - width / 2) + kotlin.math.abs((it.box.top + it.box.bottom) / 2 - height / 2) }
        val box = match?.box ?: Box(width * 0.25f, height * 0.25f, width * 0.75f, height * 0.75f)
        return embedder.crop(frame.jpeg, box, frame.rotationDegrees) to embedder.embed(frame.jpeg, box, frame.rotationDegrees)
    }
}
