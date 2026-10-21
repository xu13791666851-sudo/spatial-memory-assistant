package com.spatialmemory.assistant.debug

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import com.spatialmemory.assistant.inference.Detection

class YoloPreviewView(context: Context) : View(context) {
    private var bitmap: Bitmap? = null
    private var detections: List<Detection> = emptyList()
    private var drawImage = true
    private val boxPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0, 230, 118); style = Paint.Style.STROKE; strokeWidth = 5f }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 36f }
    private val labelPaint = Paint().apply { color = Color.argb(210, 0, 0, 0); style = Paint.Style.FILL }
    private val waitingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.LTGRAY; textSize = 38f; textAlign = Paint.Align.CENTER }

    init {
        setBackgroundColor(Color.TRANSPARENT)
        contentDescription = "识别画面，等待视频帧"
    }

    fun showFrame(next: Bitmap, boxes: List<Detection>, includeImage: Boolean = true) {
        val previous = bitmap
        bitmap = next
        detections = boxes
        drawImage = includeImage
        contentDescription = if (boxes.isEmpty()) "识别画面，当前没有检测结果" else boxes.joinToString(prefix = "检测到：") { "${it.label} ${(it.confidence * 100).toInt()}%" }
        invalidate()
        previous?.takeIf { it !== next }?.recycle()
    }

    fun clearFrame() {
        bitmap?.recycle()
        bitmap = null
        detections = emptyList()
        contentDescription = "识别画面，已停止"
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val image = bitmap
        if (image == null) {
            canvas.drawText("等待视频帧…", width / 2f, height / 2f, waitingPaint)
            return
        }
        val transform = fitCenterTransform(width, height, image.width, image.height)
        val destination = RectF(
            transform.offsetX,
            transform.offsetY,
            transform.offsetX + image.width * transform.scale,
            transform.offsetY + image.height * transform.scale,
        )
        if (drawImage) canvas.drawBitmap(image, null, destination, null)
        detections.forEach { detection ->
            val box = RectF(
                transform.offsetX + detection.box.left * transform.scale,
                transform.offsetY + detection.box.top * transform.scale,
                transform.offsetX + detection.box.right * transform.scale,
                transform.offsetY + detection.box.bottom * transform.scale,
            )
            canvas.drawRect(box, boxPaint)
            val label = "${detection.label} ${(detection.confidence * 100).toInt()}%"
            val baseline = maxOf(box.top, textPaint.textSize)
            canvas.drawRect(box.left, baseline - textPaint.textSize, box.left + textPaint.measureText(label) + 16f, baseline + 8f, labelPaint)
            canvas.drawText(label, box.left + 8f, baseline, textPaint)
        }
    }
}
