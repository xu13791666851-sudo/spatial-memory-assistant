package com.spatialmemory.assistant.debug

internal data class PreviewTransform(val scale: Float, val offsetX: Float, val offsetY: Float)

internal fun fitCenterTransform(viewWidth: Int, viewHeight: Int, imageWidth: Int, imageHeight: Int): PreviewTransform {
    val scale = minOf(viewWidth / imageWidth.toFloat(), viewHeight / imageHeight.toFloat())
    return PreviewTransform(scale, (viewWidth - imageWidth * scale) / 2f, (viewHeight - imageHeight * scale) / 2f)
}
