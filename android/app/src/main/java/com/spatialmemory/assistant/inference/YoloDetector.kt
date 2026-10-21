package com.spatialmemory.assistant.inference

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.json.JSONArray
import org.tensorflow.lite.Interpreter
import kotlin.math.roundToInt

data class ModelInfo(val inputShape: IntArray, val outputShape: IntArray, val labels: Int, val bytes: Long)

class YoloDetector(private val context: Context) : Closeable {
    private val labels = context.assets.open("yolo_labels.json").bufferedReader().use { reader ->
        val array = JSONArray(reader.readText())
        List(array.length()) { array.getString(it) }
    }
    private val modelBuffer = context.assets.openFd("exp.tflite").use { descriptor ->
        descriptor.createInputStream().channel.map(
            java.nio.channels.FileChannel.MapMode.READ_ONLY,
            descriptor.startOffset,
            descriptor.declaredLength,
        )
    }
    // Leave CPU time for microphone, playback and camera processing during inference.
    private val interpreter = Interpreter(modelBuffer, Interpreter.Options().apply { setNumThreads(2); setUseXNNPACK(true) })
    val info = ModelInfo(
        interpreter.getInputTensor(0).shape(),
        interpreter.getOutputTensor(0).shape(),
        labels.size,
        modelBuffer.capacity().toLong(),
    )

    @Synchronized
    fun detect(jpeg: ByteArray, rotationDegrees: Int = 0, threshold: Float = 0.25f): List<Detection> {
        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: error("JPEG decode failed")
        val bitmap = decoded.rotated(rotationDegrees)
        if (bitmap !== decoded) decoded.recycle()
        try {
            val channelsFirst = info.inputShape[1] == 3
            val inputHeight = info.inputShape[if (channelsFirst) 2 else 1]
            val inputWidth = info.inputShape[if (channelsFirst) 3 else 2]
            val scale = minOf(inputWidth / bitmap.width.toFloat(), inputHeight / bitmap.height.toFloat())
            val scaledWidth = (bitmap.width * scale).roundToInt()
            val scaledHeight = (bitmap.height * scale).roundToInt()
            val padX = (inputWidth - scaledWidth) / 2f
            val padY = (inputHeight - scaledHeight) / 2f
            val letterbox = Bitmap.createBitmap(inputWidth, inputHeight, Bitmap.Config.ARGB_8888)
            Canvas(letterbox).apply {
                drawColor(Color.rgb(114, 114, 114))
                drawBitmap(
                    bitmap,
                    null,
                    android.graphics.RectF(padX, padY, padX + scaledWidth, padY + scaledHeight),
                    Paint(Paint.FILTER_BITMAP_FLAG),
                )
            }
            val input = bitmapToFloatBuffer(letterbox, channelsFirst)
            letterbox.recycle()
            val outputTensor = interpreter.getOutputTensor(0)
            val output = ByteBuffer.allocateDirect(outputTensor.numBytes()).order(ByteOrder.nativeOrder())
            interpreter.run(input, output)
            output.rewind()
            val values = FloatArray(outputTensor.numBytes() / 4)
            output.asFloatBuffer().get(values)
            return YoloPostprocessor.decode(
                values, info.outputShape, labels, threshold, scale, padX, padY,
                inputWidth, inputHeight, bitmap.width, bitmap.height,
            )
        } finally {
            bitmap.recycle()
        }
    }

    private fun bitmapToFloatBuffer(bitmap: Bitmap, channelsFirst: Boolean): ByteBuffer {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return ByteBuffer.allocateDirect(pixels.size * 3 * 4).order(ByteOrder.nativeOrder()).apply {
            putRgbFloats(pixels, channelsFirst)
            rewind()
        }
    }

    override fun close() = interpreter.close()
}

private fun Bitmap.rotated(degrees: Int): Bitmap {
    if (degrees % 360 == 0) return this
    return Bitmap.createBitmap(this, 0, 0, width, height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
}
