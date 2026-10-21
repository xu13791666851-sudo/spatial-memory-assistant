package com.spatialmemory.assistant.camera

/** Limit expensive analysis conversion; the independent CameraX preview remains continuous. */
internal class FramePacer(private val intervalMs: Long = 200) {
    private var previous: Long? = null
    fun offer(monotonicMs: Long): Boolean {
        val last = previous
        if (last != null && monotonicMs >= last && monotonicMs - last < intervalMs) return false
        previous = monotonicMs
        return true
    }
    fun reset() { previous = null }
}
