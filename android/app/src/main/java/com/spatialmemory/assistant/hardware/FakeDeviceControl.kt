package com.spatialmemory.assistant.hardware

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class FakeDeviceControl : DeviceControl {
    private val mutableStatus = MutableStateFlow(HardwareStatus(true, false, "模拟设备已连接"))
    override val status = mutableStatus.asStateFlow()
    override suspend fun refresh() = mutableStatus.value
    override suspend fun startCamera() { mutableStatus.value = mutableStatus.value.copy(cameraRunning = true) }
    override suspend fun stopCamera() { mutableStatus.value = mutableStatus.value.copy(cameraRunning = false) }
}
