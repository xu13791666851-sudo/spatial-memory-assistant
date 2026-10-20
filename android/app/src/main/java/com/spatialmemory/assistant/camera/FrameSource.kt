package com.spatialmemory.assistant.camera

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

enum class CameraSource { PHONE, ESP32_SIMULATED, ESP32 }
enum class FrameSourceState { IDLE, STARTING, RUNNING, FAILED, STOPPED }

data class FramePacket(
    val id: Long,
    val source: CameraSource,
    val capturedAtMs: Long,
    val jpeg: ByteArray,
    val rotationDegrees: Int = 0,
)

interface FrameSource {
    val source: CameraSource
    val state: StateFlow<FrameSourceState>
    val frames: Flow<FramePacket>
    suspend fun start()
    suspend fun stop()
}
