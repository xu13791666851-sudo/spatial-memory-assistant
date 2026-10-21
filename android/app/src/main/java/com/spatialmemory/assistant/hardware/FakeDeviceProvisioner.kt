package com.spatialmemory.assistant.hardware

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class FakeDeviceProvisioner : DeviceProvisioner {
    private val mutableState = MutableStateFlow(ProvisionState.IDLE)
    override val state = mutableState.asStateFlow()

    override suspend fun scan(): List<DeviceCandidate> {
        mutableState.value = ProvisionState.SCANNING
        delay(300)
        mutableState.value = ProvisionState.IDLE
        return listOf(DeviceCandidate("fixture-esp32", "ESP32 Camera (模拟)", -42))
    }

    override suspend fun provision(deviceId: String, ssid: String, password: CharArray): ProvisionResult {
        if (deviceId.isBlank() || ssid.isBlank() || password.isEmpty()) return ProvisionResult.Failure("设备、WiFi 和密码不能为空")
        mutableState.value = ProvisionState.CONNECTING
        return try {
            delay(500)
            mutableState.value = ProvisionState.CONNECTED
            ProvisionResult.Success(deviceId)
        } finally {
            password.fill('\u0000')
        }
    }

    override suspend fun cancel() { mutableState.value = ProvisionState.IDLE }
}
