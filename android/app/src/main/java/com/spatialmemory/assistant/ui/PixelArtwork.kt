package com.spatialmemory.assistant.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.view.View

internal object PixelColors {
    val paper = Color.rgb(255, 251, 237)
    val ink = Color.rgb(12, 28, 80)
    val blue = Color.rgb(21, 82, 232)
    val pale = Color.rgb(223, 240, 255)
    val line = Color.rgb(136, 176, 237)
    val muted = Color.rgb(98, 114, 142)
}

/** Integer stepped corners, shared by the native screen and dialogs. */
internal class PixelBorder(private val fill: Int, private val density: Float) : Drawable() {
    private val paint = Paint()
    override fun draw(canvas: Canvas) {
        val step = 3 * density
        val stroke = 2 * density
        val left = bounds.left + stroke / 2
        val top = bounds.top + stroke / 2
        val right = bounds.right - stroke / 2
        val bottom = bounds.bottom - stroke / 2
        val path = Path().apply {
            moveTo(left + step * 2, top); lineTo(right - step * 2, top)
            lineTo(right - step * 2, top + step); lineTo(right - step, top + step)
            lineTo(right - step, top + step * 2); lineTo(right, top + step * 2)
            lineTo(right, bottom - step * 2); lineTo(right - step, bottom - step * 2)
            lineTo(right - step, bottom - step); lineTo(right - step * 2, bottom - step)
            lineTo(right - step * 2, bottom); lineTo(left + step * 2, bottom)
            lineTo(left + step * 2, bottom - step); lineTo(left + step, bottom - step)
            lineTo(left + step, bottom - step * 2); lineTo(left, bottom - step * 2)
            lineTo(left, top + step * 2); lineTo(left + step, top + step * 2)
            lineTo(left + step, top + step); lineTo(left + step * 2, top + step); close()
        }
        paint.style = Paint.Style.FILL; paint.color = fill; canvas.drawPath(path, paint)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = stroke; paint.color = PixelColors.ink
        canvas.drawPath(path, paint)
    }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java") override fun getOpacity() = PixelFormat.TRANSLUCENT
}

internal class PixelWordmark(context: Context) : View(context) {
    private val paint = Paint()
    private val glyphs = mapOf(
        'I' to listOf("111", "010", "010", "010", "010", "010", "111"),
        'S' to listOf("11111", "10000", "10000", "11111", "00001", "00001", "11111"),
        'E' to listOf("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
        'Y' to listOf("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
        'O' to listOf("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
        'U' to listOf("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    )
    init { contentDescription = "I SEE YOU"; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES }
    override fun onDraw(canvas: Canvas) {
        val unit = minOf(width / 70f, height / 13f)
        val top = (height - unit * 7) / 2
        val ring = listOf("00111100", "01100110", "11000011", "10011001", "10011001", "11000011", "01100110", "00111100")
        paint.color = PixelColors.blue
        ring.forEachIndexed { y, row -> row.forEachIndexed { x, v -> if (v == '1') canvas.drawRect(x * unit, top + y * unit, (x + 1) * unit, top + (y + 1) * unit, paint) } }
        var offset = 12f
        paint.color = PixelColors.ink
        for (letter in "I SEE YOU") {
            if (letter == ' ') { offset += 3; continue }
            val rows = glyphs.getValue(letter)
            rows.forEachIndexed { y, row -> row.forEachIndexed { x, v -> if (v == '1') canvas.drawRect((offset + x) * unit, top + y * unit, (offset + x + 1) * unit, top + (y + 1) * unit, paint) } }
            offset += rows[0].length + 1
        }
    }
}
