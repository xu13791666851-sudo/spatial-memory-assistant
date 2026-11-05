package com.spatialmemory.assistant

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.debug.RememberFlowDiagnostics
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.orchestrator.SearchState
import com.spatialmemory.assistant.realtime.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test

class AutomaticMemoryTest {
    private val context=ApplicationProvider.getApplicationContext<Context>()
    @Test fun slowLocalInferenceCannotAgeOutOrBlockTheSeparateMemorySnapshot()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.detector.delayMs=2500;f.detector.visible=false;f.start()
            f.core.onUserText("记住这个杯子");f.awaitPhoto()
            val item=f.repo.findObject("杯子")!!;val location=f.repo.history(item.id).single()
            assertEquals("桌面上",location.location);assertEquals("CAMERA_VERIFIED",location.source)
            assertTrue(location.confirmed);assertNotNull(location.observedAtMs);assertTrue(f.verifier.memoryFrameAge<2000)
        }
    }
    @Test fun movingAfterTheCommandDoesNotInvalidateTheHistoricalSnapshotBeingRemembered()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryDelayMs=400;f.start();f.core.onUserText("记住这个杯子")
            withTimeout(2000) { while(f.verifier.memoryCalls==0) delay(10) }
            val white=Bitmap.createBitmap(180,180,Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
            val bytes=ByteArrayOutputStream().use { white.compress(Bitmap.CompressFormat.JPEG,90,it);it.toByteArray() };white.recycle()
            f.source.changeScene(bytes);f.awaitPhoto()
            val item=f.repo.findObject("杯子")!!;val photo=File(f.db.objectMemoryDao().appearances(item.id).first().referenceImagePath).readBytes()
            val decoded=BitmapFactory.decodeByteArray(photo,0,photo.size)
            assertTrue(Color.blue(decoded.getPixel(10,10))>Color.red(decoded.getPixel(10,10)));decoded.recycle()
            assertEquals("桌面上",f.repo.history(item.id).single().location);assertEquals(0L,f.core.state.value.verifiedAtMs)
        }
    }
    @Test fun cancellingAnInFlightObservationCannotPublishItsDelayedPhotosOrLocation()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryDelayMs=500;f.start();f.core.onUserText("记住这个杯子")
            withTimeout(2000) { while(f.verifier.memoryCalls==0) delay(10) }
            f.core.cancelSearch();delay(700)
            val kept=f.db.objectMemoryDao().all().single()
            assertEquals(1,f.db.objectMemoryDao().captures(kept.id).size);assertTrue(f.db.objectMemoryDao().appearances(kept.id).isEmpty());assertTrue(f.repo.history(kept.id).isEmpty())
            assertEquals(SearchState.CANCELLED,f.core.state.value.searchState)
        }
    }
    @Test fun automaticEnrichmentKeepsTheOriginalUserPositionAndAddsCameraHistoryToTheSameIdentity()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.core.onUserText("记住杯子在厨房");val before=f.repo.findObject("杯子")!!
            f.start();f.core.onUserText("记住这个杯子");f.awaitPhoto()
            assertEquals(before.id,f.repo.findObject("杯子")!!.id)
            val history=f.repo.history(before.id);assertEquals(2,history.size)
            assertTrue(history.any { it.location=="厨房" && it.source=="USER_STATEMENT" && !it.confirmed })
            assertTrue(history.any { it.location=="桌面上" && it.source=="CAMERA_VERIFIED" && it.confirmed })
        }
    }
    @Test fun aTypedSceneQuestionAfterSavingResumesConversationAndIsForwardedOnce()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.voice.connectSuccessfully=true;f.core.start(f.source,enableVoice=true)
            withTimeout(2000) { f.voice.state.first { it==RealtimeState.CONNECTED } }
            f.core.onUserText("记住这个杯子");f.awaitPhoto();assertFalse(f.voice.taskActive)
            f.core.onUserText("桌子上面有什么")
            withTimeout(2000) { f.core.state.first { it.lastSpeech?.startsWith("当前画面看到")==true } };assertEquals(1,f.voice.sceneQuestions.count { it=="桌子上面有什么" });assertTrue(f.voice.texts.isEmpty());assertFalse(f.voice.taskActive)
        }
    }
    @Test fun aSpokenQuestionCanResumeWhileMemoryFinishesWithoutDuplicatingItsTranscript()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.voice.connectSuccessfully=true;f.verifier.memoryDelayMs=500;f.core.start(f.source,enableVoice=true)
            withTimeout(2000) { f.voice.state.first { it==RealtimeState.CONNECTED } }
            f.core.onUserText("记住这个杯子")
            withTimeout(2000) { while(f.verifier.memoryCalls==0) delay(10) }
            f.voice.events.emit(QwenEvent.Transcript("user","桌子上面有什么"))
            withTimeout(2000) { while(f.voice.taskActive) delay(10) }
            assertTrue(f.voice.texts.isEmpty());f.awaitPhoto();assertFalse(f.voice.taskActive)
        }
    }
    @Test fun locationInsertFailureRollsBackAllNewObjectAndAppearanceRows()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            val old=f.repo.createWithLocation("旧物",null,"旧位置");val original=f.repo.history(old.id).single()
            val id=UUID.randomUUID().toString();val now=System.currentTimeMillis()
            val item=RememberedObjectEntity(id,"杯子","杯子","[]","cup",null,now,now)
            val photo=ObjectAppearanceEntity(UUID.randomUUID().toString(),id,byteArrayOf(0,0,0,0),File(f.root,"not-published.jpg").path,0,now)
            try {
                f.db.objectMemoryDao().commitAppearance(item,listOf(photo),null,original.copy(objectId=id,source="CAMERA_VERIFIED",confirmed=true,observedAtMs=now)) { true }
                fail("Conflicting location should abort the entire observation")
            } catch(expected: android.database.sqlite.SQLiteConstraintException) { assertNotNull(expected.message) }
            assertNull(f.repo.byId(id));assertTrue(f.db.objectMemoryDao().appearances(id).isEmpty())
            assertEquals(original,f.repo.history(old.id).single())
        }
    }
    @Test fun photoWriteFailureCannotLeaveAnAutomaticallyClaimedLocationWithoutItsObject()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            val failing=MemoryRepository(context,f.db.memoryDao(),f.db.objectMemoryDao(),f.photos) { _,_ -> throw java.io.IOException("isolated write failure") }
            try {
                failing.rememberObject("杯子","cup",listOf(AppearanceSample(f.jpeg,floatArrayOf(.2f,.4f),System.currentTimeMillis())),observedLocation=ObservedLocation("桌面上","桌面",System.currentTimeMillis()))
                fail("Write failure should not create an observation")
            } catch(expected: java.io.IOException) { assertNotNull(expected.message) }
            assertTrue(f.db.objectMemoryDao().all().isEmpty())
        }
    }
    @Test fun anUnclearObjectKeepsItsSceneWithoutInventingAppearanceOrPositionAndStillAnswersTheNextQuestion()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.voice.connectSuccessfully=true;f.verifier.memoryDecision=ImageDecision.UNCERTAIN;f.core.start(f.source,enableVoice=true)
            withTimeout(2000) { f.voice.state.first { it==RealtimeState.CONNECTED } }
            f.core.onUserText("记住这个杯子")
            withTimeout(6000) { f.core.state.first { it.searchState==SearchState.IDLE && it.lastSpeech?.contains("还未确认")==true } }
            val item=f.db.objectMemoryDao().all().single();assertEquals(1,f.verifier.memoryCalls);assertEquals(1,f.db.objectMemoryDao().captures(item.id).size);assertTrue(f.db.objectMemoryDao().appearances(item.id).isEmpty())
            f.core.onUserText("桌子上有什么");withTimeout(2000) { f.core.state.first { it.lastSpeech?.startsWith("当前画面看到")==true } };assertFalse(f.voice.taskActive);assertTrue(f.voice.texts.isEmpty())
        }
    }
}
