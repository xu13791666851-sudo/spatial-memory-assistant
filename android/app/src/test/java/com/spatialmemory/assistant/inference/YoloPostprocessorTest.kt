package com.spatialmemory.assistant.inference

import org.junit.Assert.assertEquals
import org.junit.Test

class YoloPostprocessorTest {
    @Test fun `decodes channels first and applies class aware nms`() {
        val candidates = 2
        val values = FloatArray(6 * candidates)
        fun put(channel: Int, candidate: Int, value: Float) { values[channel * candidates + candidate] = value }
        put(0, 0, 100f); put(1, 0, 100f); put(2, 0, 40f); put(3, 0, 40f); put(4, 0, .9f); put(5, 0, .1f)
        put(0, 1, 102f); put(1, 1, 101f); put(2, 1, 40f); put(3, 1, 40f); put(4, 1, .8f); put(5, 1, .1f)
        val result = YoloPostprocessor.decode(values, intArrayOf(1, 6, 2), listOf("KEY", "phone"), .25f, 1f, 0f, 0f, 640, 640, 640, 640)
        assertEquals(1, result.size)
        assertEquals("KEY", result.single().label)
        assertEquals(.9f, result.single().confidence)
    }

    @Test fun `scales normalized model coordinates to image pixels`() {
        val values = floatArrayOf(.5f, .5f, .25f, .5f, .9f, .1f)
        val result = YoloPostprocessor.decode(
            values, intArrayOf(1, 6, 1), listOf("KEY", "phone"), .25f,
            1f, 0f, 0f, 640, 640, 640, 640,
        )

        assertEquals(240f, result.single().box.left)
        assertEquals(160f, result.single().box.top)
        assertEquals(400f, result.single().box.right)
        assertEquals(480f, result.single().box.bottom)
    }
}
