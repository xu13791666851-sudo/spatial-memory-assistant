package com.spatialmemory.assistant.hardware

import kotlinx.coroutines.flow.StateFlow

data class HardwareStatus(val connected: Boolean, val cameraRunning: Boolean, val detail: String)

interface DeviceControl {
    val status: StateFlow<HardwareStatus>
    suspend fun refresh(): HardwareStatus
    suspend fun startCamera()
    suspend fun stopCamera()
}
