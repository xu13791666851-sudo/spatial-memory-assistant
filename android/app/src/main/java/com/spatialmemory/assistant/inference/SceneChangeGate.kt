package com.spatialmemory.assistant.inference

import android.graphics.Bitmap
import android.graphics.BitmapFactory
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

    private fun signature(jpeg: ByteArray): IntArray? {
        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return null
        val scaled = Bitmap.createScaledBitmap(decoded, 8, 8, true)
        val pixels = IntArray(64)
        scaled.getPixels(pixels, 0, 8, 0, 0, 8, 8)
        if (scaled !== decoded) scaled.recycle()
        decoded.recycle()
        return pixels.map { pixel ->
            val red = pixel shr 16 and 0xff
            val green = pixel shr 8 and 0xff
            val blue = pixel and 0xff
            (red * 30 + green * 59 + blue * 11) / 100
        }.toIntArray()
    }

    companion object {
        internal fun meanDifference(first: IntArray, second: IntArray): Float {
            require(first.size == second.size && first.isNotEmpty())
            return first.indices.sumOf { abs(first[it] - second[it]) }.toFloat() / first.size
        }
    }
}
