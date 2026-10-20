package com.spatialmemory.assistant.realtime

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaOrderGateTest {
    @Test fun `video waits for first audio frames`() {
        val gate = MediaOrderGate(audioWarmupMs = 1_000)
        assertFalse(gate.canSendVideo(10_000))
        gate.audioStarted(10_000)
        assertFalse(gate.canSendVideo(10_999))
        assertTrue(gate.canSendVideo(11_000))
    }
}
