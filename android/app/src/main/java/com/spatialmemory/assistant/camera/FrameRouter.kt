package com.spatialmemory.assistant.camera

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class FrameRouter(private val maxAgeMs: Long = 2_500) {
    private val latest = MutableStateFlow<FramePacket?>(null)
    private var generation = 0L
    private var activeSource: CameraSource? = null

    val frame: StateFlow<FramePacket?> = latest.asStateFlow()

    @Synchronized
    fun switchTo(source: CameraSource): Long {
        generation++
        activeSource = source
        latest.value = null
        return generation
    }

    @Synchronized
    fun offer(frame: FramePacket, token: Long, nowMs: Long = System.currentTimeMillis()): Boolean {
        if (token != generation || frame.source != activeSource || nowMs - frame.capturedAtMs > maxAgeMs) return false
        latest.value = frame
        return true
    }

    @Synchronized
    fun stop() {
        generation++
        activeSource = null
        latest.value = null
    }
}
