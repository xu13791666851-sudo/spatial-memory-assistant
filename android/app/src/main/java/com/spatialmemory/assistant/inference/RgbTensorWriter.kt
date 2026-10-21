package com.spatialmemory.assistant.inference

import java.nio.ByteBuffer

internal fun ByteBuffer.putRgbFloats(pixels: IntArray, channelsFirst: Boolean) {
    fun component(pixel: Int, shift: Int) = ((pixel shr shift) and 0xff) / 255f
    if (channelsFirst) {
        for (shift in intArrayOf(16, 8, 0)) pixels.forEach { putFloat(component(it, shift)) }
    } else {
        pixels.forEach { pixel ->
            putFloat(component(pixel, 16))
            putFloat(component(pixel, 8))
            putFloat(component(pixel, 0))
        }
    }
}
