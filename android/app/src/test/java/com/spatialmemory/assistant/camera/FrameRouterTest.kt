package com.spatialmemory.assistant.camera

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameRouterTest {
    @Test fun `rejects stale and previous-source frames`() {
        val router = FrameRouter(maxAgeMs = 100)
        val token = router.switchTo(CameraSource.PHONE)
        assertTrue(router.offer(FramePacket(1, CameraSource.PHONE, 950, byteArrayOf(1)), token, 1_000))
        assertFalse(router.offer(FramePacket(2, CameraSource.PHONE, 800, byteArrayOf(2)), token, 1_000))
        router.switchTo(CameraSource.ESP32_SIMULATED)
        assertFalse(router.offer(FramePacket(3, CameraSource.PHONE, 1_000, byteArrayOf(3)), token, 1_000))
        router.stop()
        assertNull(router.frame.value)
    }
}
