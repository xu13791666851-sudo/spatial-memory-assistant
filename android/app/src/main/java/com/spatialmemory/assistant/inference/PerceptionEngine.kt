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

data class LearningView(val jpeg: ByteArray,val embedding: FloatArray,val normalizedBox: Box)
data class ObservedView(val targetJpeg: ByteArray,val sceneJpeg: ByteArray,val embedding: FloatArray)

class PerceptionEngine(
    private val matcher: TargetMatcher,
    private val embedder: ObjectEmbedder,
) {
    fun sceneJpeg(frame: FramePacket): ByteArray = embedder.crop(frame.jpeg,null,frame.rotationDegrees)
    /** Enrollment uses the independent visual locator, not a mandatory YOLO hit. */
    fun observedView(frame: FramePacket,normalizedBox: List<Float>): ObservedView {
        require(normalizedBox.size==4 && normalizedBox.all { it.isFinite() && it in 0f..1f } && normalizedBox[0]<normalizedBox[2] && normalizedBox[1]<normalizedBox[3])
        val scene=embedder.crop(frame.jpeg,null,frame.rotationDegrees)
        val options=BitmapFactory.Options().apply { inJustDecodeBounds=true }
        BitmapFactory.decodeByteArray(scene,0,scene.size,options)
        require(options.outWidth>0 && options.outHeight>0)
        val box=Box(normalizedBox[0]*options.outWidth,normalizedBox[1]*options.outHeight,normalizedBox[2]*options.outWidth,normalizedBox[3]*options.outHeight)
        require(box.width>=16 && box.height>=16) { "物品在画面中太小" }
        return ObservedView(embedder.crop(scene,box,0),scene,embedder.embed(scene,box,0))
    }

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

    fun learningSample(frame: FramePacket, target: String, detections: List<Detection>): LearningView? {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size, options)
        val rotated = frame.rotationDegrees % 180 != 0
        val width = (if (rotated) options.outHeight else options.outWidth).toFloat()
        val height = (if (rotated) options.outWidth else options.outHeight).toFloat()
        if(width<64 || height<64) return null
        fun distance(d: Detection)=kotlin.math.abs((d.box.left+d.box.right)/2/width-.5f)+kotlin.math.abs((d.box.top+d.box.bottom)/2/height-.5f)
        val matches=detections.filter { matcher.matches(target,it.label) && it.confidence>=.55f &&
            listOf(it.box.left,it.box.top,it.box.right,it.box.bottom).all(Float::isFinite) &&
            it.box.left>=0 && it.box.top>=0 && it.box.right<=width && it.box.bottom<=height && it.box.width>=48 && it.box.height>=48 }
            .sortedBy(::distance)
        if(matcher.supports(target) && matches.isEmpty()) return null
        if(matches.size>1 && distance(matches[1])-distance(matches[0])<.15f) return null
        val box=matches.firstOrNull()?.box ?: Box(width*.2f,height*.2f,width*.8f,height*.8f)
        val jpeg=embedder.crop(frame.jpeg,box,frame.rotationDegrees)
        if(matches.isEmpty()) {
            // Unknown YOLO classes are user-designated central views. Reject
            // featureless frames; do not claim a semantic/identity verification.
            val signature=SceneChangeGate().signature(jpeg) ?: return null
            val variance=(0..2).sumOf { channel ->
                val values=(channel until signature.size step 3).map { signature[it].toDouble() };val mean=values.average()
                values.sumOf { (it-mean)*(it-mean) }/values.size
            }/3
            if(variance<64) return null
        }
        return LearningView(jpeg,embedder.embed(frame.jpeg,box,frame.rotationDegrees),Box(box.left/width,box.top/height,box.right/width,box.bottom/height))
    }
}
