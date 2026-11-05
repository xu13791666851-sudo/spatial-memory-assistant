package com.spatialmemory.assistant

import android.Manifest
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.ui.NativeGatewayCredentialClient
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collect
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.*
import org.junit.Test
import com.alibaba.aoq.clientsdk.AoqClientEngine
import com.alibaba.aoq.clientsdk.AoqClientListener
import java.util.concurrent.atomic.AtomicInteger
import com.spatialmemory.assistant.ui.PixelHomeActivity

class RealtimeConnectionTest {
    @Test fun cancellingStartupDoesNotRetryOrLeaveAConnectingState() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        var attempts = 0
        val began = CompletableDeferred<Unit>()
        val client = AoqQwenRealtimeClient(context, {
            attempts++
            began.complete(Unit)
            awaitCancellation()
        })
        val connection = launch { client.connect() }
        began.await()
        connection.cancelAndJoin()
        assertEquals(1, attempts)
        assertEquals(RealtimeState.DISCONNECTED, client.state.value)
    }

    /** Explicit emulator-only network check. Host starts it with -no-audio. */
    @Test fun actualControlledIntentsAndFixedSceneNeverExposeFreeSpeech(): Unit = runBlocking {
        val arguments=InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue(arguments.getString("externalQwen")=="true")
        org.junit.Assume.assumeTrue(android.os.Build.HARDWARE in setOf("ranchu","goldfish"))
        val context=ApplicationProvider.getApplicationContext<Context>()
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        android.os.ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}")).use { it.readBytes() }
        val foreground=ActivityScenario.launch(PixelHomeActivity::class.java)
        val report=org.json.JSONObject().put("passed",false).put("physicalMicrophoneUsed",false).put("emulatedSilentAudioUsed",true)
            .put("liveCameraUsed",false).put("fixture","public-bus-test-asset").put("productionMemoryMutated",false)
        val address=arguments.getString("gatewayIpv4") ?: error("Host-verified gateway address required for this emulator check")
        require(address.matches(Regex("[0-9.]{7,15}")))
        val http=okhttp3.OkHttpClient.Builder().dns(object: okhttp3.Dns {
            override fun lookup(hostname: String): List<java.net.InetAddress> = if(hostname=="i-see-you-android-core-test.pages.dev")
                listOf(java.net.InetAddress.getByAddress(hostname,address.split('.').map { it.toInt().toByte() }.toByteArray())) else okhttp3.Dns.SYSTEM.lookup(hostname)
        }).build()
        var attempts=0
        val client=AoqQwenRealtimeClient(context,{
            attempts++;if(attempts==1) throw java.io.IOException("injected local retry")
            withContext(Dispatchers.IO) {
                val request=okhttp3.Request.Builder().url(BuildConfig.GATEWAY_URL+"/api/android/credential")
                    .post("{}".toRequestBody("application/json".toMediaType())).build()
                http.newCall(request).execute().use { response -> check(response.isSuccessful);parseDirectCredential(checkNotNull(response.body).string()) }
            }
        },sceneDescriber=QwenSceneDescriber(BuildConfig.GATEWAY_URL,http)::describe)
        val rawEvents=AtomicInteger();val events=launch(start=CoroutineStart.UNDISPATCHED) { client.events.collect { if(it is QwenEvent.Transcript && it.role=="assistant") rawEvents.incrementAndGet() } }
        var phase="connect"
        try {
            client.connect();assertEquals(2,attempts);assertEquals(RealtimeState.CONNECTED,client.state.value)
            phase="remember";assertTrue(client.interpretUser("请帮我把这个也存起来","杯子",listOf("杯子")) is com.spatialmemory.assistant.dialogue.DialogueIntent.RememberObject)
            phase="history";assertTrue(client.interpretUser("你还记得它上次放哪了吗","杯子",listOf("杯子")) is com.spatialmemory.assistant.dialogue.DialogueIntent.RecallLocation)
            phase="status";assertTrue(client.interpretUser("你记住它了吗","杯子",listOf("杯子")) is com.spatialmemory.assistant.dialogue.DialogueIntent.CheckMemory)
            phase="scene_intent";assertTrue(client.interpretUser("桌上现在有哪些东西","杯子",listOf("杯子")) is com.spatialmemory.assistant.dialogue.DialogueIntent.DescribeScene)
            report.put("realIntentCasesPassed",4).put("pronounResolutionPassed",true)
            phase="scene_pixels"
            val jpeg=instrumentation.context.assets.open("bus.jpg").use { it.readBytes() }
            val frame=com.spatialmemory.assistant.camera.FramePacket(900001,com.spatialmemory.assistant.camera.CameraSource.PHONE,System.currentTimeMillis(),jpeg)
            repeat(3) { client.sendFrame(frame,"");delay(300) }
            val scene=client.describeScene(frame,"公交车","描述本次画面里公交车的颜色、外观与相对位置")
            report.put("publicFixtureObservation",org.json.JSONObject().put("targetVisible",scene?.targetVisible)
                .put("description",scene?.description).put("location",scene?.location).put("items",org.json.JSONArray(scene?.items?.map { it.name } ?: emptyList<String>())))
            assertNotNull("No structured observation returned",scene)
            assertEquals("Wrong scene identity",frame.id,scene!!.frameId)
            assertTrue("The public bus was not visible to the model",scene.targetVisible)
            assertTrue("The public bus has no appearance description",scene.description.isNotBlank())
            assertTrue("The public bus appearance must be grounded in its pixels",Regex("白|灰|蓝").containsMatchIn(scene.description))
            assertEquals(0,rawEvents.get())
            report.put("fixedSceneDescriptionPassed",true).put("frameIdMatches",true).put("uncontrolledAssistantTranscriptsExposed",rawEvents.get()).put("testDnsOverrideUsed",true).put("passed",true)
        } catch(error: Throwable) {
            report.put("failurePhase",phase).put("failureKind",error.javaClass.simpleName);throw error
        } finally {
            java.io.File(context.filesDir,"controlled-qwen-live.json").writeText(report.toString(2))
            withContext(NonCancellable) { client.disconnect();events.cancelAndJoin();foreground.close() }
        }
    }
}
