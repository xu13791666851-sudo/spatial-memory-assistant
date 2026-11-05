package com.spatialmemory.assistant.realtime

/** Playback suppression is scoped to a task or local announcement, never a session latch. */
internal class PlaybackPolicy {
    @Volatile var taskActive=false
    @Volatile var localSpeechActive=false
    @Volatile var enabled=true
    val mayPlay: Boolean get()=enabled && !taskActive && !localSpeechActive
}
