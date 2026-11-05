package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.debug.RememberFlowDiagnostics
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.orchestrator.SearchState
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test

class RememberFlowTest {
    private val context=ApplicationProvider.getApplicationContext<Context>()
    @Test fun onePhrasePersistsOnePhotoAndStatedLocationAndBacksUpAlongsideAPositionOnlyObject()=runBlocking {
        val result=RememberFlowDiagnostics.run(context)
        assertTrue(result.getBoolean("onePhraseAppearanceAndLocation"));assertTrue(result.getBoolean("reopenPassed"))
        assertTrue(result.getBoolean("backupRestoresOnePhotoAndPositionOnlyObjects"));assertEquals(1,result.getInt("imageApiCallsDuringRemember"))
    }
    @Test fun statedLocationDoesNotNeedAnAppearanceCameraOrVoice()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.core.onUserText("记住它")
            assertTrue(f.db.objectMemoryDao().all().isEmpty());assertTrue(f.core.state.value.lastSpeech!!.contains("记住这个杯子"))
            assertFalse(f.core.requiresCamera("记住水杯在书桌上"))
            f.core.onUserText("记住水杯在书桌上")
            val item=f.repo.findObject("水杯")!!
            assertTrue(item.embeddings.isEmpty());assertEquals("书桌上",f.repo.history(item.id).single().location)
            assertEquals(0,f.source.starts);assertEquals(0,f.voice.connects);assertEquals(0,f.verifier.calls)
            f.core.onUserText("查询水杯的位置历史");assertTrue(f.core.state.value.lastSpeech!!.contains("书桌上"))
        }
    }
    @Test fun addingAppearanceLaterRetainsThePositionOnlyIdentityAndItsHistory()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.core.onUserText("记住水杯在厨房");val original=f.repo.findObject("水杯")!!
            f.start();f.core.onUserText("记住水杯外观");f.awaitPhoto()
            assertEquals(original.id,f.repo.findObject("水杯")!!.id)
            assertEquals("厨房",f.repo.history(original.id).single().location)
            assertEquals(1,f.db.objectMemoryDao().appearances(original.id).size);assertEquals(1,f.verifier.memoryCalls)
            f.core.onUserText("记住它在床头")
            assertEquals("床头",f.repo.history(original.id).first().location)
            assertEquals(1,f.repo.findObjects("水杯").size)
        }
    }
    @Test fun anUnavailableImageApiCannotEraseTheAlreadySavedLocationWhenPhotoCaptureFails()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryFailure=java.io.IOException("isolated network unavailable");f.start();f.core.onUserText("记住水杯在厨房")
            withTimeout(10_000) { f.core.state.first { it.searchState==SearchState.IDLE && it.lastSpeech?.contains("位置已保留")==true } }
            val item=f.repo.findObject("水杯")!!;assertTrue(item.embeddings.isEmpty())
            assertEquals("厨房",f.repo.history(item.id).single().location);assertEquals(1,f.verifier.memoryCalls)
        }
    }
    @Test fun cancellingBeforeTheReferenceIsCapturedCannotCreateAPhantomObject()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryDelayMs=300;f.start();f.core.onUserText("记住水杯");f.core.cancelSearch();delay(800)
            assertTrue(f.db.objectMemoryDao().all().isEmpty());assertEquals(SearchState.CANCELLED,f.core.state.value.searchState)
        }
    }
    @Test fun existingAppearanceNeedsAnExplicitChoiceAndANewSameNameKeepsTheOldIdentity()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.start();f.core.onUserText("记住水杯在书桌");f.awaitPhoto()
            val original=f.repo.findObject("水杯")!!;val photo=f.db.objectMemoryDao().appearances(original.id).first().id
            f.core.onUserText("记住水杯外观");assertEquals(1,f.core.state.value.objectChoices.size)
            assertEquals(photo,f.db.objectMemoryDao().appearances(original.id).first().id)
            f.core.onUserText("再记住一件水杯");f.awaitPhoto()
            assertEquals(2,f.repo.findObjects("水杯").size)
            assertEquals(photo,f.db.objectMemoryDao().appearances(original.id).first().id)
            assertEquals("书桌",f.repo.history(original.id).single().location)
        }
    }
    @Test fun easierEnrollmentDoesNotAllowAnUncertainImageReviewToClaimTheObjectWasFound()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.start();f.core.onUserText("记住水杯");f.awaitPhoto();val item=f.repo.findObject("水杯")!!
            f.core.beginSearch("水杯",item.id)
            withTimeout(6_000) { while(f.verifier.findCalls==0) delay(50) }
            delay(100);assertEquals(0L,f.core.state.value.verifiedAtMs)
            assertNotEquals(SearchState.GUIDING,f.core.state.value.searchState)
            assertTrue(f.verifier.lastFindRequest!!.requiresPersonalMatch)
        }
    }
    @Test fun missingLocalDetectionsDoNotBlockAnIndependentVisualMemory()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.detector.visible=false;f.start();f.core.onUserText("记住这个杯子");f.awaitPhoto()
            val item=f.repo.findObject("杯子")!!
            assertEquals(1,f.db.objectMemoryDao().appearances(item.id).size)
            assertEquals("桌面上",f.repo.history(item.id).single().location)
            assertEquals(1,f.verifier.memoryCalls)
        }
    }
    @Test fun aPositionOnlyMemoryDoesNotRequestAPersonalImageComparisonWithoutReferences()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.core.onUserText("记住钥匙在抽屉");val item=f.repo.findObject("钥匙")!!
            f.start();f.core.beginSearch("钥匙",item.id)
            withTimeout(6_000) { while(f.verifier.findCalls==0) delay(50) }
            assertFalse(f.verifier.lastFindRequest!!.requiresPersonalMatch)
            assertEquals("抽屉",f.repo.history(item.id).single().location)
            assertEquals(0L,f.core.state.value.verifiedAtMs)
        }
    }
    @Test fun automaticCurrentPositionUncertaintyKeepsTheSavedPhotoAndStopsWithoutAFakeLocation()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryLocation=null;f.start();f.core.onUserText("记住水杯的外观和位置")
            withTimeout(8_000) { f.core.state.first { it.searchState==SearchState.IDLE && it.lastSpeech?.contains("位置仍待确认")==true } }
            val item=f.repo.findObject("水杯")!!
            assertEquals(1,f.db.objectMemoryDao().appearances(item.id).size);assertTrue(f.repo.history(item.id).isEmpty())
            assertEquals(1,f.verifier.calls);assertEquals(0L,f.core.state.value.verifiedAtMs)
        }
    }
}
