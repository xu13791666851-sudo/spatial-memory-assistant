package com.spatialmemory.assistant.pc

import org.junit.Assert.*
import org.junit.Test

class PcTurnFeedbackTest {
    @Test fun `fillers do not replace the active find command`() {
        assertTrue(PcTurnFeedback.ignores("好的。"))
        assertFalse(PcTurnFeedback.ignores("好的，找钥匙"))
        assertFalse(PcTurnFeedback.ignores("取消"))
    }
    @Test fun `a new command rejects late replies and clearing from the previous command`() {
        val feedback = PcTurnFeedback()
        feedback.begin("cup")
        assertTrue(feedback.accepts("cup"))
        feedback.begin("keys")
        assertFalse(feedback.accepts("cup"))
        assertTrue(feedback.accepts("keys"))
    }
    @Test fun `results suppress late acknowledgements and a new turn resets the gate`() {
        val feedback = PcTurnFeedback()
        feedback.begin("cup")
        assertTrue(feedback.shouldSpeak("ack"))
        assertTrue(feedback.shouldSpeak("result"))
        assertFalse(feedback.shouldSpeak("ack"))
        feedback.begin("keys")
        assertTrue(feedback.shouldSpeak("ack"))
    }
}
