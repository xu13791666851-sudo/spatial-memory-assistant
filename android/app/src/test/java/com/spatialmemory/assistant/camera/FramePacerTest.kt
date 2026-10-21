package com.spatialmemory.assistant.camera

import org.junit.Assert.*
import org.junit.Test

class FramePacerTest {
    @Test fun skipsExtraConversionsButAcceptsFreshFramesAndNewSessions() {
        val pacer = FramePacer(200)
        assertTrue(pacer.offer(1000)); assertFalse(pacer.offer(1010)); assertFalse(pacer.offer(1199))
        assertTrue(pacer.offer(1200)); assertTrue(pacer.offer(1600))
        pacer.reset(); assertTrue(pacer.offer(1601))
    }
}
