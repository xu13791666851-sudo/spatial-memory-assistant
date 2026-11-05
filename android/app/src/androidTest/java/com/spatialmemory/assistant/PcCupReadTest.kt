package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.memory.AppDatabase
import com.spatialmemory.assistant.pc.PcAssistantSession
import com.spatialmemory.assistant.realtime.FakeQwenRealtimeClient
import com.spatialmemory.assistant.speech.SpeechCoordinator
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test

/** Read existing owned records through the real phone-PC connection; never start sensors. */
class PcCupReadTest {
    @Test fun savedCupCanBeRecalledByAliasWithoutCameraOrMicrophone() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val db = AppDatabase.get(context)
        val before = db.objectMemoryDao().all().map { it.id }.toSet()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val speech = SpeechCoordinator(context) {}.apply { setEnabled(false) }
        val remote = PcAssistantSession(context, db, FakeQwenRealtimeClient(), speech, scope, { false })
        try {
            remote.connect()
            val rows = remote.records()
            val cup = (0 until rows.length()).map { rows.getJSONObject(it) }.single { it.getString("name") == "蓝色水杯" }
            remote.submitText("蓝色水杯上次在哪里")
            withTimeout(10_000) { remote.state.first { it.lastSpeech.orEmpty().contains("笔记本电脑右侧") } }
            assertEquals(cup.getString("id"), remote.state.value.rememberedObjectId)
            remote.submitText("我的杯子在哪")
            delay(800)
            assertEquals(cup.getString("id"), remote.state.value.rememberedObjectId)
            assertTrue(remote.state.value.lastSpeech.orEmpty().contains("笔记本电脑右侧"))
            assertFalse(remote.state.value.running)
            assertFalse(remote.requiresCamera("我的杯子在哪"))
            assertTrue(remote.requiresCamera("现在这个桌面上有没有？"))
            // Give the host's explicitly requested public-image check time to use
            // the verified in-memory key; it never receives private camera images.
            delay(40_000)
            assertEquals(before, db.objectMemoryDao().all().map { it.id }.toSet())
            assertFalse(remote.state.value.running)
        } finally { remote.stop(); scope.cancel(); speech.close() }
    }
}
