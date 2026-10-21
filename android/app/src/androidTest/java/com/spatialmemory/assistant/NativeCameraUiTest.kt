package com.spatialmemory.assistant

import android.Manifest
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import java.io.File
import com.alibaba.aoq.clientsdk.AoqClientEngine
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.spatialmemory.assistant.api.AssistantController
import com.spatialmemory.assistant.debug.YoloPreviewView
import com.spatialmemory.assistant.inference.Box
import com.spatialmemory.assistant.inference.Detection
import com.spatialmemory.assistant.inference.YoloDetector
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.ui.PixelHomeActivity
import com.spatialmemory.assistant.camera.CameraSource
import com.spatialmemory.assistant.camera.FramePacket
import com.spatialmemory.assistant.realtime.CandidateVerificationRequest
import com.spatialmemory.assistant.realtime.QwenImageVerifier
import com.spatialmemory.assistant.realtime.parseDirectCredential
import com.spatialmemory.assistant.realtime.toConnectConfig
import com.spatialmemory.assistant.realtime.AoqQwenRealtimeClient
import com.spatialmemory.assistant.realtime.RealtimeState
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class NativeCameraUiTest {
    @Test fun keepsTheProvidersTcpFallbackPort() {
        val credential = parseDirectCredential("""{"aoqTokenForClient":"test","sid":"test","clientRelayCertFingerprint":"test","clientRelayEndpoints":[{"endpoint":"127.0.0.1","port":8443,"tcpPort":443,"route_index":1}]}""")
        assertEquals(443, credential.relayEndpoints.single().tcpPort)
        assertEquals(1, credential.relayEndpoints.single().routeIndex)
        assertEquals(com.alibaba.aoq.clientsdk.AoqClientEngine.AoqTrackMode.AoqTrackModeSegment,
            credential.toConnectConfig().subscribeTracks.first().trackMode)
    }
    @Test fun actualAndroidHttpClientCanGetImageConfirmation() = runBlocking {
        val jpeg = InstrumentationRegistry.getInstrumentation().context.assets.open("bus.jpg").use { it.readBytes() }
        val frame = FramePacket(1L, CameraSource.PHONE, System.currentTimeMillis(), jpeg)
        val request = CandidateVerificationRequest("acceptance", "public-bus", 1L, "公交车", null, "bus", .9f, listOf(0f, 0f, 1f, 1f))
        val result = QwenImageVerifier("", gateway = BuildConfig.GATEWAY_URL).verify(frame, null, request)
        assertTrue("Live Qwen must see the bus", result.visible)
    }

    @Test fun realModelDetectsObjectsAndEveryBoxCanBeDrawnWithoutRememberingAnything() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val jpeg = instrument.context.assets.open("bus.jpg").use { it.readBytes() }
        val detections = YoloDetector(context).use { it.detect(jpeg) }
        assertTrue("Real bundled YOLO must recognize the bus", detections.any { it.label == "bus" })
        assertTrue("Real bundled YOLO must recognize people", detections.any { it.label == "person" })
        instrument.runOnMainSync {
            val view = YoloPreviewView(context)
            val image = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)
            view.showFrame(image, listOf(
                Detection(41, "cup", .9f, Box(20f, 50f, 80f, 100f)),
                Detection(73, "book", .8f, Box(110f, 110f, 170f, 170f)),
            ), false)
            view.layout(0, 0, 200, 200)
            val output = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(output))
            assertEquals(Color.rgb(0, 230, 118), output.getPixel(20, 80))
            assertEquals(Color.rgb(0, 230, 118), output.getPixel(170, 140))
            assertTrue(view.contentDescription.contains("cup")); assertTrue(view.contentDescription.contains("book"))
            view.clearFrame(); output.recycle()
        }
    }

    @Test fun threeAppearanceSamplesRemainInTheActualDatabase() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val db = AppDatabase.get(context)
        val repository = MemoryRepository(context, db.memoryDao(), db.objectMemoryDao())
        val jpeg = InstrumentationRegistry.getInstrumentation().context.assets.open("bus.jpg").use { it.readBytes() }
        val name = "自动验收公交车"
        val item = repository.rememberObject(name, "bus", List(3) { AppearanceSample(jpeg, floatArrayOf(.25f, .5f, .25f), System.currentTimeMillis()) })
        try {
            val reopened = MemoryRepository(context, db.memoryDao(), db.objectMemoryDao()).findObject(name)
            assertNotNull(reopened); assertEquals(item.id, reopened!!.id); assertEquals(3, reopened.embeddings.size)
            assertEquals(3, db.objectMemoryDao().appearances(item.id).count { java.io.File(it.referenceImagePath).isFile })
        } finally { repository.deleteObject(item.id) }
    }

    @Test fun nativeCameraProducesAnalyzedFramesAndStopsWhenEnded() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        for (permission in listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)) {
            instrument.uiAutomation.executeShellCommand("pm grant ${context.packageName} $permission").close()
        }
        ActivityScenario.launch(PixelHomeActivity::class.java).use { scenario ->
            var controller: AssistantController? = null
            var realtime: AoqQwenRealtimeClient? = null
            scenario.onActivity { activity ->
                assertNotNull(activity.findViewById<YoloPreviewView>(R.id.native_yolo_overlay))
                val field = PixelHomeActivity::class.java.getDeclaredField("controller").apply { isAccessible = true }
                controller = field.get(activity) as AssistantController
                realtime = PixelHomeActivity::class.java.getDeclaredField("qwen").apply { isAccessible = true }.get(activity) as AoqQwenRealtimeClient
                activity.findViewById<Button>(R.id.native_voice).performClick()
            }
            // ARM-only vendor libraries run under translation on the x86 test emulator.
            val deadline = System.currentTimeMillis() + 120_000
            while (controller!!.state.value.yoloLatencyMs == null && System.currentTimeMillis() < deadline) Thread.sleep(200)
            assertTrue("CameraX must be running", controller!!.state.value.running)
            assertNotNull("Actual camera frames must reach YOLO: ${controller!!.state.value}", controller!!.state.value.yoloLatencyMs)
            assertEquals("Voice and YOLO must work in the same home session", RealtimeState.CONNECTED, realtime!!.state.value)
            // A fixed WAV goes through the real native audio encoder and cloud ASR;
            // do not substitute sendText or a fake transcript for the voice command.
            val sample = File(context.cacheDir, "voice-acceptance.wav")
            sample.writeBytes(instrument.context.assets.open("find-cup.wav").use { it.readBytes() })
            val engine = AoqQwenRealtimeClient::class.java.getDeclaredField("engine").apply { isAccessible = true }.get(realtime) as AoqClientEngine
            try {
                assertEquals(0, engine.startAudioFile("acceptance", AoqClientEngine.AoqAudioFileMixConfig().apply {
                    fileName = sample.absolutePath; cycles = 1; publishVolume = 100; playoutVolume = 0
                }))
                val spokenDeadline = System.currentTimeMillis() + 45_000
                while (controller!!.state.value.target != "水杯" && System.currentTimeMillis() < spokenDeadline) Thread.sleep(200)
                assertEquals("Cloud speech transcription must start the real search", "水杯", controller!!.state.value.target)
                File(context.filesDir, "voice-command-acceptance.json").writeText("""{"cloud_speech_command_started_search":true,"target":"水杯","input_method":"fixed WAV published through native SDK and real cloud ASR","physical_microphone_tested":false}""")
                instrument.uiAutomation.takeScreenshot()?.let { image ->
                    File(context.filesDir, "voice-command-acceptance.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    image.recycle()
                }
            } finally { engine.stopAudioFile("acceptance"); sample.delete() }
            scenario.onActivity { it.findViewById<Button>(R.id.native_voice).performClick() }
            val end = System.currentTimeMillis() + 10_000
            while (controller!!.state.value.running && System.currentTimeMillis() < end) Thread.sleep(100)
            assertFalse(controller!!.state.value.running)
        }
    }
}
