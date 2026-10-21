package com.spatialmemory.assistant.inference

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Test

class RgbTensorWriterTest {
    private val pixels = intArrayOf(0x00ff0000, 0x0000ff00)

    @Test fun writesNchwChannelsFirst() {
        assertArrayEquals(floatArrayOf(1f, 0f, 0f, 1f, 0f, 0f), write(channelsFirst = true), 0f)
    }

    @Test fun writesNhwcPixelsFirst() {
        assertArrayEquals(floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f), write(channelsFirst = false), 0f)
    }

    private fun write(channelsFirst: Boolean): FloatArray {
        val buffer = ByteBuffer.allocate(pixels.size * 3 * 4).order(ByteOrder.nativeOrder())
        buffer.putRgbFloats(pixels, channelsFirst)
        buffer.rewind()
        return FloatArray(pixels.size * 3).also { buffer.asFloatBuffer().get(it) }
    }
}
