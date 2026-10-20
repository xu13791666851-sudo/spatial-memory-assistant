package com.spatialmemory.assistant.inference

data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width get() = right - left
    val height get() = bottom - top
    fun iou(other: Box): Float {
        val intersection = (minOf(right, other.right) - maxOf(left, other.left)).coerceAtLeast(0f) *
            (minOf(bottom, other.bottom) - maxOf(top, other.top)).coerceAtLeast(0f)
        val union = width * height + other.width * other.height - intersection
        return if (union <= 0f) 0f else intersection / union
    }
}

data class Detection(val classId: Int, val label: String, val confidence: Float, val box: Box)
