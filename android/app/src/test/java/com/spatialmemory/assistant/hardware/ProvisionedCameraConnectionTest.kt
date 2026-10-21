package com.spatialmemory.assistant.hardware

import org.junit.Assert.*
import org.junit.Test

class ProvisionedCameraConnectionTest {
    @Test fun usesTheActualFirmwareStreamPortAndPreservesAuthentication() {
        val connection = ProvisionResult.Success("camera-one", "http://192.168.1.50/", "device-token").cameraConnection()
        assertEquals("http://192.168.1.50", connection.baseUrl)
        assertEquals("http://192.168.1.50:81/stream", connection.streamUrl)
        assertEquals("camera-one", connection.deviceId)
        assertEquals("device-token", connection.token)
        assertFalse(connection.legacyCameraWebServer)
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsMissingDeviceAddress() {
        ProvisionResult.Success("camera-one", "", "").cameraConnection()
    }
}
