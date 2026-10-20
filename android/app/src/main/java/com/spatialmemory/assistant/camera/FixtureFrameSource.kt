package com.spatialmemory.assistant.camera

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import java.io.ByteArrayOutputStream
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

class FixtureFrameSource : FrameSource {
    override val source = CameraSource.ESP32_SIMULATED
    private val mutableState = MutableStateFlow(FrameSourceState.IDLE)
    private val mutableFrames = MutableSharedFlow<FramePacket>(extraBufferCapacity = 1)
    private var job: Job? = null
    private var nextId = 0L

    override val state = mutableState.asStateFlow()
    override val frames: Flow<FramePacket> = mutableFrames.asSharedFlow()

    override suspend fun start() {
        if (job?.isActive == true) return
        mutableState.value = FrameSourceState.STARTING
        val jpeg = fixtureJpeg()
        job = CoroutineScope(Dispatchers.Default).launch {
            mutableState.value = FrameSourceState.RUNNING
            while (isActive) {
                mutableFrames.tryEmit(FramePacket(++nextId, source, System.currentTimeMillis(), jpeg))
                delay(500)
            }
        }
    }

    override suspend fun stop() {
        job?.cancelAndJoin()
        job = null
        mutableState.value = FrameSourceState.STOPPED
    }

    private fun fixtureJpeg(): ByteArray {
        val bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.rgb(238, 234, 222))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.DKGRAY; textSize = 30f }
        canvas.drawText("ESP32 SIMULATED FRAME", 70f, 80f, paint)
        paint.color = Color.rgb(70, 65, 55)
        canvas.drawRect(110f, 260f, 530f, 300f, paint)
        paint.color = Color.rgb(195, 170, 60)
        canvas.drawCircle(320f, 245f, 22f, paint)
        return ByteArrayOutputStream().use {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 88, it)
            bitmap.recycle()
            it.toByteArray()
        }
    }
}
