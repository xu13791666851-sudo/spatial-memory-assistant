package com.spatialmemory.assistant.realtime

internal class ResponseRequestGate<T> {
    private var active = false
    private var sent: T? = null
    private var pending: T? = null

    @Synchronized
    fun request(value: T): T? {
        if (active) {
            pending = value
            return null
        }
        active = true
        sent = value
        return value
    }

    @Synchronized
    fun started() {
        active = true
    }

    @Synchronized
    fun rejectedBecauseActive() {
        if (pending == null) pending = sent
        active = true
    }

    @Synchronized
    fun finished(): T? {
        active = false
        sent = null
        val next = pending ?: return null
        pending = null
        active = true
        sent = next
        return next
    }

    @Synchronized
    fun reset() {
        active = false
        sent = null
        pending = null
    }
}
