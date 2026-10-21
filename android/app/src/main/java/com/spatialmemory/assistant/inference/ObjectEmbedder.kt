package com.spatialmemory.assistant.inference

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import java.io.ByteArrayOutputStream
import kotlin.math.sqrt

interface ObjectEmbedder {
    fun embed(jpeg: ByteArray, box: Box? = null, rotationDegrees: Int = 0): FloatArray
    fun crop(jpeg: ByteArray, box: Box?, rotationDegrees: Int = 0): ByteArray

    fun similarity(left: FloatArray, right: FloatArray): Float {
        if (left.size != right.size || left.isEmpty()) return 0f
        var dot = 0f
        var leftNorm = 0f
        var rightNorm = 0f
        for (index in left.indices) {
            dot += left[index] * right[index]
            leftNorm += left[index] * left[index]
            rightNorm += right[index] * right[index]
        }
        return if (leftNorm == 0f || rightNorm == 0f) 0f else dot / sqrt(leftNorm * rightNorm)
    }
}

class HistogramObjectEmbedder : ObjectEmbedder {
    // shortcut: 色彩直方图不擅长区分同色同类物品，拿到经真机验证的特征 TFLite 模型后替换此实现。
    override fun embed(jpeg: ByteArray, box: Box?, rotationDegrees: Int): FloatArray {
        val bitmap = decodeAndCrop(jpeg, box, rotationDegrees)
        try {
            val scaled = Bitmap.createScaledBitmap(bitmap, 64, 64, true)
            try {
                val pixels = IntArray(64 * 64)
                scaled.getPixels(pixels, 0, 64, 0, 0, 64, 64)
                val bins = FloatArray(48)
                pixels.forEach { pixel ->
                    bins[((pixel shr 16) and 0xff) / 16]++
                    bins[16 + ((pixel shr 8) and 0xff) / 16]++
                    bins[32 + (pixel and 0xff) / 16]++
                }
                val norm = sqrt(bins.sumOf { (it * it).toDouble() }).toFloat().coerceAtLeast(1f)
                return bins.map { it / norm }.toFloatArray()
            } finally {
                if (scaled !== bitmap) scaled.recycle()
            }
        } finally {
            bitmap.recycle()
        }
    }

    override fun crop(jpeg: ByteArray, box: Box?, rotationDegrees: Int): ByteArray {
        val bitmap = decodeAndCrop(jpeg, box, rotationDegrees)
        return try {
            ByteArrayOutputStream().use { output ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output)
                output.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }
    }

    private fun decodeAndCrop(jpeg: ByteArray, box: Box?, rotationDegrees: Int): Bitmap {
        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: error("JPEG decode failed")
        val rotated = if (rotationDegrees % 360 == 0) decoded else {
            Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, Matrix().apply { postRotate(rotationDegrees.toFloat()) }, true)
                .also { decoded.recycle() }
        }
        if (box == null) return rotated
        val left = box.left.toInt().coerceIn(0, rotated.width - 1)
        val top = box.top.toInt().coerceIn(0, rotated.height - 1)
        val width = box.width.toInt().coerceIn(1, rotated.width - left)
        val height = box.height.toInt().coerceIn(1, rotated.height - top)
        return Bitmap.createBitmap(rotated, left, top, width, height).also { rotated.recycle() }
    }
}

