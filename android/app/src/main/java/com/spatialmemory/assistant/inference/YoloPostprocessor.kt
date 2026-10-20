package com.spatialmemory.assistant.inference

object YoloPostprocessor {
    fun decode(
        values: FloatArray,
        shape: IntArray,
        labels: List<String>,
        confidenceThreshold: Float,
        scale: Float,
        padX: Float,
        padY: Float,
        modelInputWidth: Int,
        modelInputHeight: Int,
        originalWidth: Int,
        originalHeight: Int,
        iouThreshold: Float = 0.45f,
    ): List<Detection> {
        require(shape.size == 3 && shape[0] == 1) { "Expected output [1,C,N] or [1,N,C], got ${shape.contentToString()}" }
        val channelsFirst = shape[1] == labels.size + 4
        val channels = if (channelsFirst) shape[1] else shape[2]
        val candidates = if (channelsFirst) shape[2] else shape[1]
        require(channels == labels.size + 4) { "Output channels $channels do not match ${labels.size} labels" }

        fun value(candidate: Int, channel: Int) = if (channelsFirst) {
            values[channel * candidates + candidate]
        } else {
            values[candidate * channels + channel]
        }

        val normalizedCoordinates = (0 until candidates).maxOf { candidate ->
            (0..3).maxOf { channel -> kotlin.math.abs(value(candidate, channel)) }
        } <= 2f
        val xFactor = if (normalizedCoordinates) modelInputWidth.toFloat() else 1f
        val yFactor = if (normalizedCoordinates) modelInputHeight.toFloat() else 1f

        val detections = ArrayList<Detection>()
        for (candidate in 0 until candidates) {
            var classId = 0
            var confidence = value(candidate, 4)
            for (index in 1 until labels.size) {
                val score = value(candidate, index + 4)
                if (score > confidence) { confidence = score; classId = index }
            }
            if (confidence < confidenceThreshold) continue
            val centerX = value(candidate, 0) * xFactor
            val centerY = value(candidate, 1) * yFactor
            val width = value(candidate, 2) * xFactor
            val height = value(candidate, 3) * yFactor
            val box = Box(
                ((centerX - width / 2 - padX) / scale).coerceIn(0f, originalWidth.toFloat()),
                ((centerY - height / 2 - padY) / scale).coerceIn(0f, originalHeight.toFloat()),
                ((centerX + width / 2 - padX) / scale).coerceIn(0f, originalWidth.toFloat()),
                ((centerY + height / 2 - padY) / scale).coerceIn(0f, originalHeight.toFloat()),
            )
            if (box.width > 1f && box.height > 1f) detections += Detection(classId, labels[classId], confidence, box)
        }
        return classAwareNms(detections, iouThreshold)
    }

    fun classAwareNms(detections: List<Detection>, iouThreshold: Float): List<Detection> {
        val kept = ArrayList<Detection>()
        for (candidate in detections.sortedByDescending { it.confidence }) {
            if (kept.none { it.classId == candidate.classId && it.box.iou(candidate.box) > iouThreshold }) kept += candidate
        }
        return kept
    }
}
