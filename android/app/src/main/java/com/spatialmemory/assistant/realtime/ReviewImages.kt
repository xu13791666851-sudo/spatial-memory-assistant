package com.spatialmemory.assistant.realtime

import android.graphics.*
import java.io.ByteArrayOutputStream

/** Keeps the deployed gateway's two-image contract: scene + labeled comparison sheet. */
internal object ReviewImages {
    fun upright(jpeg: ByteArray, degrees: Int): ByteArray {
        if (degrees % 360 == 0) return jpeg
        val input = decode(jpeg)
        val output = Bitmap.createBitmap(input, 0, 0, input.width, input.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
        return try { encode(output) } finally { if (output !== input) output.recycle(); input.recycle() }
    }

    fun comparison(candidate: ByteArray?, references: List<ByteArray>): ByteArray {
        require(references.size in 1..3)
        val image = Bitmap.createBitmap(768, 824, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(image)
            canvas.drawColor(Color.WHITE)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 23f }
            val entries = listOf(candidate to "CURRENT CANDIDATE") + references.mapIndexed { index, bytes -> bytes to "REFERENCE ${index + 1}" }
            for ((index, entry) in entries.withIndex()) {
                val x = (index % 2) * 384f
                val y = (index / 2) * 412f
                canvas.drawText(entry.second, x + 8, y + 25, paint)
                val bytes = entry.first ?: continue
                val bitmap = decode(bytes)
                try {
                    val scale = minOf(368f / bitmap.width, 368f / bitmap.height)
                    val width = bitmap.width * scale; val height = bitmap.height * scale
                    val left = x + (384 - width) / 2; val top = y + 36 + (368 - height) / 2
                    canvas.drawBitmap(bitmap, null, RectF(left, top, left + width, top + height), paint)
                } finally { bitmap.recycle() }
            }
            return encode(image)
        } finally { image.recycle() }
    }

    private fun decode(jpeg: ByteArray) = checkNotNull(BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)) { "复核照片无法读取" }
    private fun encode(bitmap: Bitmap) = ByteArrayOutputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it)); it.toByteArray() }
}
