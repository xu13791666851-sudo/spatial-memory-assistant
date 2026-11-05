package com.spatialmemory.assistant.realtime

import org.junit.Assert.*
import org.junit.Test

class VoiceRecoveryGateTest {
    @Test fun `only an idle timeout in a running session starts recovery`() {
        val gate = VoiceRecoveryGate()
        assertFalse(gate.begin("response_idle_timeout", false))
        assertFalse(gate.begin("invalid_api_key", true))
        assertFalse(gate.begin(null, true))
        assertTrue(gate.begin("response_idle_timeout", true))
        assertTrue(gate.pending)
        assertFalse(gate.begin("response_idle_timeout", true))
    }

    @Test fun `failed recovery does not loop and manual restart gets a fresh budget`() {
        val gate = VoiceRecoveryGate()
        assertTrue(gate.begin("response_idle_timeout", true))
        gate.failed()
        assertFalse(gate.pending)
        assertFalse(gate.begin("response_idle_timeout", true))
        gate.reset()
        assertFalse(gate.begin("response_idle_timeout", false))
        assertTrue(gate.begin("response_idle_timeout", true))
    }

    @Test fun `a recovered session can later recover from its own idle expiry`() {
        val gate = VoiceRecoveryGate()
        assertTrue(gate.begin("response_idle_timeout", true))
        gate.connected()
        assertFalse(gate.pending)
        assertTrue(gate.begin("response_idle_timeout", true))
    }
}
