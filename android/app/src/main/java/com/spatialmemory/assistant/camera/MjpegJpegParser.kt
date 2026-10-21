package com.spatialmemory.assistant.camera

import java.io.ByteArrayOutputStream

class MjpegJpegParser(private val maxFrameBytes: Int = 512 * 1024) {
    private var previous = -1
    private var frame: ByteArrayOutputStream? = null

    fun feed(bytes: ByteArray, length: Int = bytes.size): List<ByteArray> {
        val complete = mutableListOf<ByteArray>()
        for (index in 0 until length) {
            val current = bytes[index].toInt() and 0xFF
            if (frame == null) {
                if (previous == 0xFF && current == 0xD8) frame = ByteArrayOutputStream().apply { write(0xFF); write(0xD8) }
            } else {
                frame!!.write(current)
                if (frame!!.size() > maxFrameBytes) frame = null
                else if (previous == 0xFF && current == 0xD9) {
                    complete += frame!!.toByteArray()
                    frame = null
                }
            }
            previous = current
        }
        return complete
    }
}
