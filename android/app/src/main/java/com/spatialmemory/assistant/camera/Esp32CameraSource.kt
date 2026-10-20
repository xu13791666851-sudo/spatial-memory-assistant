package com.spatialmemory.assistant.camera

import com.spatialmemory.assistant.hardware.Esp32Api
import java.io.IOException
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.OkHttpClient

class Esp32CameraSource(
    private val api: Esp32Api,
    private val http: OkHttpClient = OkHttpClient(),
) : FrameSource {
    override val source = CameraSource.ESP32
    private val mutableState = MutableStateFlow(FrameSourceState.IDLE)
    private val mutableFrames = MutableSharedFlow<FramePacket>(extraBufferCapacity = 1)
    private val ids = AtomicLong()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private var call: Call? = null
    override val state = mutableState.asStateFlow()
    override val frames: Flow<FramePacket> = mutableFrames.asSharedFlow()

    override suspend fun start() {
        if (job?.isActive == true) return
        mutableState.value = FrameSourceState.STARTING
        api.refresh()
        api.startCamera()
        job = scope.launch {
            val parser = MjpegJpegParser()
            try {
                val activeCall = http.newCall(api.streamRequest()).also { call = it }
                activeCall.execute().use { response ->
                    if (!response.isSuccessful) throw IOException("ESP32 视频流失败：HTTP ${response.code}")
                    val input = response.body?.byteStream() ?: throw IOException("ESP32 视频流为空")
                    val buffer = ByteArray(8192)
                    mutableState.value = FrameSourceState.RUNNING
                    while (isActive) {
                        val count = input.read(buffer)
                        if (count < 0) throw IOException("ESP32 视频流已断开")
                        parser.feed(buffer, count).forEach { jpeg ->
                            mutableFrames.tryEmit(FramePacket(ids.incrementAndGet(), source, System.currentTimeMillis(), jpeg))
                        }
                    }
                }
            } catch (error: Throwable) {
                if (isActive) mutableState.value = FrameSourceState.FAILED
            } finally {
                call = null
            }
        }
    }

    override suspend fun stop() {
        call?.cancel()
        job?.cancelAndJoin()
        job = null
        runCatching { api.stopCamera() }
        mutableState.value = FrameSourceState.STOPPED
    }
}
