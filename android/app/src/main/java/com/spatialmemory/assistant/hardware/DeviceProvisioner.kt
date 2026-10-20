package com.spatialmemory.assistant.hardware

import kotlinx.coroutines.flow.StateFlow

enum class ProvisionState { IDLE, SCANNING, CONNECTING, CONNECTED, FAILED }
data class DeviceCandidate(val id: String, val name: String, val signal: Int)
sealed interface ProvisionResult {
    data class Success(val deviceId: String, val baseUrl: String = "", val token: String = "") : ProvisionResult
    data class Failure(val reason: String) : ProvisionResult
}

interface DeviceProvisioner {
    val state: StateFlow<ProvisionState>
    suspend fun scan(): List<DeviceCandidate>
    suspend fun provision(deviceId: String, ssid: String, password: CharArray): ProvisionResult
    suspend fun cancel()
}
