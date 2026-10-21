package com.spatialmemory.assistant.realtime

internal class MediaOrderGate(private val audioWarmupMs: Long = 1_000) {
    private var videoReadyAtMs = Long.MAX_VALUE

    @Synchronized
    fun audioStarted(nowMs: Long) {
        videoReadyAtMs = nowMs + audioWarmupMs
    }

    @Synchronized
    fun canSendVideo(nowMs: Long) = nowMs >= videoReadyAtMs

    @Synchronized
    fun reset() {
        videoReadyAtMs = Long.MAX_VALUE
    }
}
