package com.spatialmemory.assistant.inference

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import kotlin.math.abs

class SceneChangeGate(
    private val minimumIntervalMs: Long = 2_500,
    private val differenceThreshold: Float = 18f,
) {
    private var lastAcceptedAt = Long.MIN_VALUE
    private var lastSignature: IntArray? = null

    fun offer(jpeg: ByteArray, nowMs: Long): Boolean {
        if (lastSignature != null && nowMs - lastAcceptedAt < minimumIntervalMs) return false
        val signature = signature(jpeg) ?: return false
        return offerSignature(signature, nowMs)
    }

    internal fun offerSignature(signature: IntArray, nowMs: Long): Boolean {
        val previous = lastSignature
        if (previous == null) {
            lastSignature = signature
            lastAcceptedAt = nowMs
            return true
        }
        if (nowMs - lastAcceptedAt < minimumIntervalMs || meanDifference(previous, signature) < differenceThreshold) return false
        lastSignature = signature
        lastAcceptedAt = nowMs
        return true
    }

    fun reset() {
        lastAcceptedAt = Long.MIN_VALUE
        lastSignature = null
    }

    fun signature(jpeg: ByteArray, rotationDegrees: Int = 0, region: List<Float>? = null): IntArray? {
        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return null
        val images = linkedSetOf(decoded)
        try {
            val upright = if (rotationDegrees % 360 == 0) decoded else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, Matrix().apply { postRotate(rotationDegrees.toFloat()) }, true).also(images::add)
            val crop = if (region == null) upright else {
                if (region.size != 4 || region.any { !it.isFinite() || it !in 0f..1f } || region[2] <= region[0] || region[3] <= region[1]) return null
                val left = (region[0] * upright.width).toInt().coerceIn(0, upright.width - 1)
                val top = (region[1] * upright.height).toInt().coerceIn(0, upright.height - 1)
                val right = (region[2] * upright.width).toInt().coerceIn(left + 1, upright.width)
                val bottom = (region[3] * upright.height).toInt().coerceIn(top + 1, upright.height)
                Bitmap.createBitmap(upright, left, top, right - left, bottom - top).also(images::add)
            }
            val scaled = Bitmap.createScaledBitmap(crop, 8, 8, true).also(images::add)
            val pixels = IntArray(64)
            scaled.getPixels(pixels, 0, 8, 0, 0, 8, 8)
            return IntArray(192) { index -> pixels[index / 3] shr (16 - (index % 3) * 8) and 0xff }
        } finally { images.forEach { it.recycle() } }
    }

    companion object {
        internal fun meanDifference(first: IntArray, second: IntArray): Float {
            require(first.size == second.size && first.isNotEmpty())
            return first.indices.sumOf { abs(first[it] - second[it]) }.toFloat() / first.size
        }
    }
}
