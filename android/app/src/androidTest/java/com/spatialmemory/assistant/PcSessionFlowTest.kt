package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.memory.AppDatabase
import com.spatialmemory.assistant.pc.*
import com.spatialmemory.assistant.realtime.FakeQwenRealtimeClient
import com.spatialmemory.assistant.realtime.QwenRealtimeClient
import com.spatialmemory.assistant.speech.SpeechCoordinator
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test

class PcSessionFlowTest {
    @Test fun nativeClientCapturesFrozenFixtureAndQueriesRealPcRecordsWithoutAnySensors()=runBlocking {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val name="pc-session-${UUID.randomUUID()}.db";val db=AppDatabase.open(context,name)
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
        val speech=SpeechCoordinator(context) {}.apply { setEnabled(false) }
        val namespace="pc-check-${UUID.randomUUID()}"
        var conversationId=UUID.randomUUID().toString()
        val voiceStarted=CompletableDeferred<Unit>()
        val qwen=object: QwenRealtimeClient by FakeQwenRealtimeClient() {
            override suspend fun connect() { voiceStarted.complete(Unit);awaitCancellation() }
        }
        val remote=PcAssistantSession(context,db,qwen,speech,scope,{false},backupNamespace=namespace,jevNamespace=namespace,conversationId={conversationId})
        val raw=requireNotNull(InstrumentationRegistry.getArguments().getString("pc_pair"));PcConnection(context).save(raw)
        val bytes=InstrumentationRegistry.getInstrumentation().context.assets.open("bus.jpg").use { it.readBytes() }
        val fixtureFrames=MutableSharedFlow<FramePacket>(replay=1);val status=MutableStateFlow(FrameSourceState.IDLE)
        val source=object: FrameSource {
            override val source=CameraSource.PHONE
            override val state=status.asStateFlow()
            override val frames=fixtureFrames.asSharedFlow()
            override suspend fun start() { status.value=FrameSourceState.RUNNING;fixtureFrames.emit(FramePacket(1,CameraSource.PHONE,System.currentTimeMillis(),bytes)) }
            override suspend fun stop() { status.value=FrameSourceState.STOPPED }
        }
        try {
            remote.start(source,false)
            withTimeout(15_000) { remote.state.first { it.frameId==1L } }
            val target="互通杯"+UUID.randomUUID().toString().take(8)
            remote.submitText("记住这个$target")
            withTimeout(15_000) { while(true) {
                val items=remote.records()
                if((0 until items.length()).any {items.getJSONObject(it).optString("name")==target&&items.getJSONObject(it).optInt("sample_count")==1})break
                delay(50)
            } }
            val records=remote.records();val row=(0 until records.length()).map { records.getJSONObject(it) }.single { it.getString("name")==target }
            assertEquals(1,row.getInt("sample_count"));assertEquals(1,row.getInt("scene_count"));assertEquals("桌面上",row.getString("location"))
            remote.submitText("记住它了吗");withTimeout(10_000) { remote.state.first { it.lastSpeech.orEmpty().contains("已记住") } }
            remote.submitText("它上次在哪");withTimeout(10_000) { remote.state.first { it.lastSpeech.orEmpty().startsWith("上次")&&it.lastSpeech.orEmpty().contains("桌面上") } }
            fixtureFrames.emit(FramePacket(2,CameraSource.PHONE,System.currentTimeMillis(),bytes));withTimeout(10_000) { remote.state.first { it.frameId==2L } }
            remote.submitText("桌子上面有什么");withTimeout(10_000) { remote.state.first { it.lastSpeech.orEmpty().contains("测试杯") } }
            conversationId=UUID.randomUUID().toString()
            remote.resetConversation()
            assertFalse(remote.state.value.running)
            assertNull(remote.state.value.rememberedObjectId)
            assertNull(remote.state.value.lastSpeech)
            remote.submitText("它上次在哪")
            withTimeout(10_000) { remote.state.first { it.lastSpeech!=null } }
            assertFalse(remote.state.value.lastSpeech.orEmpty().contains("桌面上"))
            remote.submitText("${target}上次在哪")
            withTimeout(10_000) { remote.state.first { it.lastSpeech.orEmpty().startsWith("上次")&&it.lastSpeech.orEmpty().contains("桌面上") } }
            remote.start(source,true)
            withTimeout(10_000) { voiceStarted.await() }
            remote.stop();assertFalse(remote.state.value.running);assertEquals(FrameSourceState.STOPPED,status.value)
            delay(100);assertNull("Cancelling a voice startup must not leave an error on the homepage",remote.state.value.error)
        } finally { remote.stop();scope.cancel();speech.close();db.close();context.deleteDatabase(name) }
    }
}
