package com.spatialmemory.assistant.realtime

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** TypeSafe rejects undersized images and ignores EXIF orientation; prepare pixels here. */
internal object JevReviewImages {
    fun prepare(jpeg: ByteArray, rotation: Int, longest: Int = 960): ByteArray {
        require(jpeg.size in 1..4_000_000 && rotation in listOf(0, 90, 180, 270))
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
        require(bounds.outWidth in 1..16_384 && bounds.outHeight in 1..16_384) { "照片无法读取" }
        val options = BitmapFactory.Options().apply { inSampleSize = 1 }
        while (max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 2048) options.inSampleSize *= 2
        val original = requireNotNull(BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, options)) { "照片无法读取" }
        var upright = original
        var scaled: Bitmap? = null
        var padded: Bitmap? = null
        try {
            if (rotation != 0) upright = Bitmap.createBitmap(original, 0, 0, original.width, original.height, Matrix().apply { postRotate(rotation.toFloat()) }, true)
            val ratio = minOf(1f, longest.toFloat() / max(upright.width, upright.height))
            val resized = Bitmap.createScaledBitmap(upright, max(1, (upright.width * ratio).roundToInt()), max(1, (upright.height * ratio).roundToInt()), true)
            scaled = resized
            val canvasBitmap = Bitmap.createBitmap(max(280, resized.width), max(280, resized.height), Bitmap.Config.ARGB_8888)
            padded = canvasBitmap
            Canvas(canvasBitmap).apply { drawColor(Color.LTGRAY); drawBitmap(resized, (canvasBitmap.width - resized.width) / 2f, (canvasBitmap.height - resized.height) / 2f, null) }
            return ByteArrayOutputStream().use { check(canvasBitmap.compress(Bitmap.CompressFormat.JPEG, 82, it)); it.toByteArray().also { require(it.size <= 600_000) { "照片过大" } } }
        } finally {
            padded?.recycle()
            if (scaled !== upright) scaled?.recycle()
            if (upright !== original) upright.recycle()
            original.recycle()
        }
    }
}
