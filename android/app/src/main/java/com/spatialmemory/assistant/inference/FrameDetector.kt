package com.spatialmemory.assistant.inference

interface FrameDetector {
    fun detect(jpeg: ByteArray, rotationDegrees: Int = 0, threshold: Float = .25f): List<Detection>
}
