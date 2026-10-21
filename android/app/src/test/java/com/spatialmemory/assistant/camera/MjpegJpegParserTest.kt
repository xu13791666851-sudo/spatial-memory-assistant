package com.spatialmemory.assistant.camera

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class MjpegJpegParserTest {
    @Test fun `parses markers split across chunks`() {
        val parser = MjpegJpegParser()
        assertEquals(0, parser.feed(byteArrayOf(1, 0xFF.toByte())).size)
        val result = parser.feed(byteArrayOf(0xD8.toByte(), 3, 4, 0xFF.toByte(), 0xD9.toByte()))
        assertEquals(1, result.size)
        assertArrayEquals(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 3, 4, 0xFF.toByte(), 0xD9.toByte()), result.single())
    }

    @Test fun `drops oversized frame and recovers on next jpeg`() {
        val parser = MjpegJpegParser(maxFrameBytes = 5)
        parser.feed(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3, 4, 0xFF.toByte(), 0xD9.toByte()))
        val valid = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 7, 0xFF.toByte(), 0xD9.toByte())
        assertArrayEquals(valid, parser.feed(valid).single())
    }
}
