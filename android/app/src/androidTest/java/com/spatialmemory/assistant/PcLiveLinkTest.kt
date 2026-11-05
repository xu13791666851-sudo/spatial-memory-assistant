package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.spatialmemory.assistant.memory.AppDatabase
import com.spatialmemory.assistant.pc.PcAssistantSession
import com.spatialmemory.assistant.realtime.FakeQwenRealtimeClient
import com.spatialmemory.assistant.speech.SpeechCoordinator
import kotlinx.coroutines.*
import org.junit.Assume.assumeTrue
import org.junit.Assert.*
import org.junit.Test

/** Explicitly invoked owned-app link check. No activity, capture or speech. */
class PcLiveLinkTest {
    @Test fun connectOwnedMemoryWithoutOpeningCameraOrMicrophone()=runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("pc_live_check")=="owned-app-backup-no-sensors")
        val context=ApplicationProvider.getApplicationContext<Context>()
        val db=AppDatabase.get(context)
        val before=db.objectMemoryDao().all().map { it.id }.toSet()
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
        val speech=SpeechCoordinator(context) {}.apply { setEnabled(false) }
        val remote=PcAssistantSession(context,db,FakeQwenRealtimeClient(),speech,scope,{false})
        try {
            remote.connect()
            val records=remote.records();val ids=(0 until records.length()).map { records.getJSONObject(it).getString("id") }.toSet()
            assertTrue(ids.containsAll(before));assertFalse(remote.state.value.running)
            // Keep the authenticated channel available for the PC's explicit
            // backup/download/independent-restore/public-image verification.
            repeat(60) { delay(1000);assertFalse(remote.state.value.running) }
            assertEquals(before,db.objectMemoryDao().all().map { it.id }.toSet())
        } finally { remote.stop();scope.cancel();speech.close() }
    }
}
