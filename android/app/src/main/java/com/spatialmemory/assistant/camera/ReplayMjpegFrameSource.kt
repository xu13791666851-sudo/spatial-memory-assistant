package com.spatialmemory.assistant.camera

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class ReplayMjpegFrameSource(
    private val framesProvider: suspend () -> List<ByteArray>,
    private val frameIntervalMs: Long = 200,
) : FrameSource {
    override val source = CameraSource.ESP32_SIMULATED
    private val mutableState = MutableStateFlow(FrameSourceState.IDLE)
    private val mutableFrames = MutableSharedFlow<FramePacket>(extraBufferCapacity = 1)
    private var job: Job? = null
    override val state = mutableState.asStateFlow()
    override val frames: Flow<FramePacket> = mutableFrames.asSharedFlow()

    override suspend fun start() {
        if (job?.isActive == true) return
        mutableState.value = FrameSourceState.STARTING
        val images = framesProvider().filter { it.size > 4 && it[0] == 0xFF.toByte() && it[1] == 0xD8.toByte() }
        if (images.isEmpty()) {
            mutableState.value = FrameSourceState.FAILED
            return
        }
        job = CoroutineScope(Dispatchers.Default).launch {
            mutableState.value = FrameSourceState.RUNNING
            var id = 0L
            while (isActive) for (jpeg in images) {
                mutableFrames.tryEmit(FramePacket(++id, source, System.currentTimeMillis(), jpeg))
                delay(frameIntervalMs)
                if (!isActive) break
            }
        }
    }

    override suspend fun stop() {
        job?.cancelAndJoin()
        job = null
        mutableState.value = FrameSourceState.STOPPED
    }
}
