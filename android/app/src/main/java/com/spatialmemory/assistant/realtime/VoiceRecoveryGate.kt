package com.spatialmemory.assistant.realtime

/** One controlled recovery per failed session; a successful connection opens a new budget. */
internal class VoiceRecoveryGate {
    var pending = false
        private set
    private var attempted = false

    fun begin(code: String?, running: Boolean): Boolean {
        if (!running || pending || attempted || code != "response_idle_timeout") return false
        pending = true
        attempted = true
        return true
    }

    fun connected() {
        pending = false
        attempted = false
    }

    fun failed() { pending = false }

    fun reset() {
        pending = false
        attempted = false
    }
}
