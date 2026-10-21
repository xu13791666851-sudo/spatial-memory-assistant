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
        }, QwenImageVerifier("", gateway = BuildConfig.GATEWAY_URL))
        val connection = launch { client.connect() }
        began.await()
        connection.cancelAndJoin()
        assertEquals(1, attempts)
        assertEquals(RealtimeState.DISCONNECTED, client.state.value)
    }

    @Test fun actualRealtimeSessionAcceptsTextAndReturnsAnAnswer() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.RECORD_AUDIO}").close()
        // Android microphone access is allowed only while the app is in the foreground.
        val foreground = ActivityScenario.launch(PixelHomeActivity::class.java)
        var attempts = 0
        val client = AoqQwenRealtimeClient(context,
            {
                attempts++
                if (attempts == 1) throw java.io.IOException("Injected first-attempt network failure")
                NativeGatewayCredentialClient(BuildConfig.GATEWAY_URL).get()
            },
            QwenImageVerifier("", gateway = BuildConfig.GATEWAY_URL))
        try {
            client.connect()
            assertEquals(RealtimeState.CONNECTED, client.state.value)
            assertEquals("Must recover without a second button tap", 2, attempts)
            val engine = AoqQwenRealtimeClient::class.java.getDeclaredField("engine").apply { isAccessible = true }.get(client) as AoqClientEngine
            val audibleFrames = AtomicInteger()
            val observer = object : AoqClientListener.AoqAudioFrameListener {
                override fun onPlaybackAudioFrame(frame: AoqClientEngine.AoqAudioFrameData) {
                    if (frame.dataPtr?.any { it != 0.toByte() } == true) audibleFrames.incrementAndGet()
                }
            }
            assertEquals(0, engine.setAudioFrameObserver(observer))
            assertEquals(0, engine.enableAudioFrameObserver(true, AoqClientEngine.AoqAudioSource.AoqAudioSourcePlayback, AoqClientEngine.AoqAudioObserverConfig()))
            val answer = async(start = CoroutineStart.UNDISPATCHED) {
                withTimeout(30_000) { client.events.first { it is QwenEvent.Transcript && it.role == "assistant" } }
            }
            client.sendText("请只回答：语音连接测试成功。")
            assertTrue((answer.await() as QwenEvent.Transcript).text.isNotBlank())
            withTimeout(15_000) { while (audibleFrames.get() == 0) delay(100) }
            assertTrue("Provider must return actual non-silent audio", audibleFrames.get() > 0)
        } finally { client.disconnect(); foreground.close() }
    }
}
