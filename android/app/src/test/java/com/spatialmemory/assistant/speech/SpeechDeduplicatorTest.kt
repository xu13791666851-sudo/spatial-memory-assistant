package com.spatialmemory.assistant.speech

import org.junit.Assert.*
import org.junit.Test

class SpeechDeduplicatorTest {
    @Test fun `speaks a business event once and ignores debug`() {
        val policy = SpeechDeduplicator()
        val found = SpeechEvent("search-1:found", "看到了", SpeechPriority.P0)
        assertTrue(policy.accept(found))
        assertFalse(policy.accept(found))
        assertFalse(policy.accept(SpeechEvent("debug", "帧 10", SpeechPriority.P3)))
        policy.clear()
        assertTrue(policy.accept(found))
    }
}
