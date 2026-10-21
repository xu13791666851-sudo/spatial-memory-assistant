package com.spatialmemory.assistant.realtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ResponseRequestGateTest {
    @Test fun `keeps only latest request until active response finishes`() {
        val gate = ResponseRequestGate<String>()
        assertEquals("first", gate.request("first"))
        assertNull(gate.request("second"))
        assertNull(gate.request("latest"))
        assertEquals("latest", gate.finished())
        assertNull(gate.finished())
    }

    @Test fun `retries request rejected by server active response`() {
        val gate = ResponseRequestGate<String>()
        assertEquals("confirm target", gate.request("confirm target"))
        gate.rejectedBecauseActive()
        assertEquals("confirm target", gate.finished())
    }

    @Test fun `queues request while semantic vad response is active`() {
        val gate = ResponseRequestGate<String>()
        gate.started()
        assertNull(gate.request("confirm target"))
        assertEquals("confirm target", gate.finished())
    }
}
