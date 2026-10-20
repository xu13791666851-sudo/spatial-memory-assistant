package com.spatialmemory.assistant.speech

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.io.Closeable
import java.util.Locale

enum class SpeechPriority { P0, P1, P2, P3 }
data class SpeechEvent(val key: String, val text: String, val priority: SpeechPriority)

internal class SpeechDeduplicator {
    private val spoken = mutableSetOf<String>()
    fun accept(event: SpeechEvent): Boolean = event.text.isNotBlank() && event.priority != SpeechPriority.P3 && spoken.add(event.key)
    fun clear() = spoken.clear()
}

class SpeechCoordinator(
    context: Context,
    private val microphoneEnabled: (Boolean) -> Unit,
) : Closeable {
    private val handler = Handler(Looper.getMainLooper())
    private val deduplicator = SpeechDeduplicator()
    @Volatile private var enabled = true
    fun setEnabled(value: Boolean) { enabled = value; if (!value) handler.post { waiting.clear(); tts.stop(); microphoneEnabled(true) } }
    private var ready = false
    private var closed = false
    private val waiting = ArrayDeque<SpeechEvent>()
    private lateinit var tts: TextToSpeech

    init {
        tts = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                tts.language = Locale.SIMPLIFIED_CHINESE
                handler.post(::drainWaiting)
            }
        }
        tts.apply {
        setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = microphoneEnabled(false)
            override fun onDone(utteranceId: String?) = resumeMicrophoneAfterSpeech()
            @Deprecated("Deprecated in Java") override fun onError(utteranceId: String?) = resumeMicrophoneAfterSpeech()
        })
        }
    }

    fun announce(event: SpeechEvent) {
        if (!enabled || !deduplicator.accept(event) || closed) return
        handler.post {
            if (!ready) waiting.addLast(event) else speak(event)
        }
    }

    fun reset() {
        deduplicator.clear()
        handler.post { waiting.clear(); tts.stop(); microphoneEnabled(true) }
    }

    private fun drainWaiting() {
        while (waiting.isNotEmpty()) speak(waiting.removeFirst())
    }

    private fun speak(event: SpeechEvent) {
        val queue = if (event.priority == SpeechPriority.P0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        tts.speak(event.text, queue, null, event.key)
    }

    private fun resumeMicrophoneAfterSpeech() {
        handler.postDelayed({ if (!tts.isSpeaking && !closed) microphoneEnabled(true) }, 150)
    }

    override fun close() {
        closed = true
        handler.post { waiting.clear(); tts.stop(); tts.shutdown() }
    }
}
