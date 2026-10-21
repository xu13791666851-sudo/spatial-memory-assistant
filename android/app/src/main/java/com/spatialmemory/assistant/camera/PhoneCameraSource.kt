package com.spatialmemory.assistant.camera

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import android.util.Size
import android.os.SystemClock
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class PhoneCameraSource(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val previewView: PreviewView? = null,
) : FrameSource {
    override val source = CameraSource.PHONE
    private val mutableState = MutableStateFlow(FrameSourceState.IDLE)
    private val mutableFrames = MutableSharedFlow<FramePacket>(extraBufferCapacity = 1)
    private var provider: ProcessCameraProvider? = null
    private var analyzerExecutor: ExecutorService? = null
    private var nextId = 0L
    private val pacer = FramePacer()

    override val state = mutableState.asStateFlow()
    override val frames: Flow<FramePacket> = mutableFrames.asSharedFlow()

    override suspend fun start() {
        if (mutableState.value == FrameSourceState.RUNNING) return
        mutableState.value = FrameSourceState.STARTING
        pacer.reset()
        try {
            val cameraProvider = awaitProvider()
            val preview = Preview.Builder().build().also { previewView?.surfaceProvider?.let(it::setSurfaceProvider) }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
                    ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                ).build())
                .build()
            val executor = Executors.newSingleThreadExecutor().also { analyzerExecutor = it }
            analysis.setAnalyzer(executor) { image -> onImage(image) }
            cameraProvider.unbindAll()
            if (previewView == null) cameraProvider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, analysis)
            else cameraProvider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            provider = cameraProvider
            mutableState.value = FrameSourceState.RUNNING
        } catch (error: Throwable) {
            analyzerExecutor?.shutdownNow()
            analyzerExecutor = null
            mutableState.value = FrameSourceState.FAILED
            throw error
        }
    }

    override suspend fun stop() {
        provider?.unbindAll()
        provider = null
        analyzerExecutor?.shutdownNow()
        analyzerExecutor = null
        mutableState.value = FrameSourceState.STOPPED
    }

    private fun onImage(image: ImageProxy) {
        try {
            if (!pacer.offer(SystemClock.elapsedRealtime())) return
            val jpeg = image.toJpeg()
            mutableFrames.tryEmit(
                FramePacket(++nextId, source, System.currentTimeMillis(), jpeg, image.imageInfo.rotationDegrees),
            )
        } catch (error: Throwable) {
            Log.e(TAG, "Failed to convert CameraX frame", error)
            mutableState.value = FrameSourceState.FAILED
        } finally {
            image.close()
        }
    }

    private suspend fun awaitProvider(): ProcessCameraProvider = suspendCancellableCoroutine { continuation ->
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            try { continuation.resume(future.get()) }
            catch (error: Throwable) { continuation.resumeWithException(error) }
        }, ContextCompat.getMainExecutor(context))
    }

    private companion object {
        const val TAG = "PhoneCameraSource"
    }
}

private fun ImageProxy.toJpeg(): ByteArray {
    val bitmap = toBitmap()
    return try {
        ByteArrayOutputStream().use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 85, output)) { "Camera frame JPEG compression failed" }
            output.toByteArray()
        }
    } finally {
        bitmap.recycle()
    }
}
