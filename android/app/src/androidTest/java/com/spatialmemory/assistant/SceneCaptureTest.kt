package com.spatialmemory.assistant

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.backup.MemoryBackupArchive
import com.spatialmemory.assistant.debug.RememberFlowDiagnostics
import com.spatialmemory.assistant.dialogue.DialogueIntent
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.orchestrator.SearchState
import com.spatialmemory.assistant.realtime.*
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test

class SceneCaptureTest {
    private val context=ApplicationProvider.getApplicationContext<Context>()
    private suspend fun RememberFlowDiagnostics.Fixture.finished()=withTimeout(6000) { core.state.first { it.searchState==SearchState.IDLE && it.rememberedObjectId!=null } }

    @Test fun anUncertainReviewKeepsTheSceneAndStatusQueriesCannotEchoAModelSaveClaim()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.voice.connectSuccessfully=true;f.verifier.memoryDecision=ImageDecision.UNCERTAIN
            f.core.start(f.source,true);withTimeout(2000) { f.voice.state.first { it==RealtimeState.CONNECTED } }
            f.core.onUserText("记住这个杯子");f.finished()
            val item=f.repo.findObject("杯子")!!;val capture=f.repo.captures(item.id).single()
            assertTrue(File(capture.imagePath).isFile);assertEquals(CaptureStatus.SCENE_ONLY,capture.status)
            assertTrue(item.embeddings.isEmpty());assertTrue(f.repo.history(item.id).isEmpty())
            f.voice.events.emit(QwenEvent.Transcript("assistant","记住了，杯子在黄色圆桌上"));delay(100)
            assertFalse(f.core.state.value.lastSpeech.orEmpty().contains("黄色圆桌"))
            f.core.onUserText("你记住杯子了吗")
            assertTrue(f.core.state.value.lastSpeech!!.contains("当时画面已保存"));assertTrue(f.core.state.value.lastSpeech!!.contains("外观照片尚未保存"))
            f.core.onUserText("你记住，你记住那个杯子在哪里吗")
            assertTrue(f.core.state.value.lastSpeech!!.contains("位置仍未确认"));assertFalse(f.core.state.value.lastSpeech!!.contains("已经记住外观"))
        }
    }
    @Test fun unavailableTargetBoundsDoNotBlockAnIndependentlyVerifiedPosition()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryBox=emptyList();f.start();f.core.onUserText("记住这个杯子");f.finished()
            val item=f.repo.findObject("杯子")!!;val capture=f.repo.captures(item.id).single()
            assertEquals(CaptureStatus.LOCATION_ONLY,capture.status);assertEquals("桌面上",capture.verifiedLocation)
            assertTrue(f.db.objectMemoryDao().appearances(item.id).isEmpty());assertEquals("桌面上",f.repo.history(item.id).single().location)
            assertTrue(f.core.state.value.lastSpeech!!.contains("目标照片暂未提取"))
        }
    }
    @Test fun unknownPositionDoesNotDiscardAValidTargetReferenceOrItsScene()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryLocation=null;f.start();f.core.onUserText("记住这个杯子");f.finished()
            val item=f.repo.findObject("杯子")!!;assertEquals(CaptureStatus.APPEARANCE_ONLY,f.repo.captures(item.id).single().status)
            assertEquals(1,item.embeddings.size);assertTrue(f.repo.history(item.id).isEmpty());assertTrue(f.core.state.value.lastSpeech!!.contains("位置仍待确认"))
        }
    }
    @Test fun networkFailureDoesNotEraseTheCommandTimeScene()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryFailure=java.io.IOException("isolated failure");f.start();f.core.onUserText("记住这个杯子");f.finished()
            val item=f.repo.findObject("杯子")!!;val capture=f.repo.captures(item.id).single()
            assertEquals("NETWORK_ERROR",capture.failureKind);assertTrue(File(capture.imagePath).isFile)
            assertFalse(f.core.state.value.lastSpeech!!.contains("完整入镜"));assertTrue(f.core.state.value.lastSpeech!!.contains("连接未完成"))
        }
    }
    @Test fun sceneOnlyRecordsSurviveReopenAndActualArchiveRestoreWithoutBecomingObjectReferences()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.verifier.memoryDecision=ImageDecision.UNCERTAIN;f.start();f.core.onUserText("记住这个杯子");f.finished()
            val item=f.repo.findObject("杯子")!!;val before=f.repo.captures(item.id).single();f.core.stop()
            f.db.close();f.db=AppDatabase.open(context,f.dbName)
            assertEquals(before,f.db.objectMemoryDao().captures(item.id).single())
            val targetName="scene-restore-${f.id}.db";val target=AppDatabase.open(context,targetName)
            val account=UUID.randomUUID().toString()
            try {
                MemoryBackupArchive(context,f.db,f.photos,File(f.root,"export")).export(account).use { snapshot ->
                    MemoryBackupArchive(context,target,File(f.root,"restored"),File(f.root,"import")).restore(snapshot.file,account)
                    val after=target.objectMemoryDao().captures(item.id).single()
                    assertEquals(CaptureStatus.SCENE_ONLY,after.status);assertTrue(target.objectMemoryDao().appearances(item.id).isEmpty());assertTrue(target.objectMemoryDao().locations(item.id).isEmpty())
                    assertArrayEquals(File(before.imagePath).readBytes(),File(after.imagePath).readBytes())
                }
            } finally { target.close();context.deleteDatabase(targetName) }
        }
    }
    @Test fun anInitialImageWriteFailureCannotInventAnObjectOrSuccessfulReceipt()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            val repo=MemoryRepository(context,f.db.memoryDao(),f.db.objectMemoryDao(),f.photos) { _,_ -> throw java.io.IOException("disk full") }
            try { repo.captureScene("杯子",f.jpeg,1,"PHONE",System.currentTimeMillis());fail("Write should fail") } catch(expected: java.io.IOException) { assertNotNull(expected.message) }
            assertTrue(f.db.objectMemoryDao().all().isEmpty());assertEquals(0,f.photos.walkTopDown().count { it.isFile })
        }
    }
    @Test fun aFailedReferenceWriteRetainsTheOriginalSceneAndCanStillCommitTheVerifiedPlaceSeparately()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            val repo=MemoryRepository(context,f.db.memoryDao(),f.db.objectMemoryDao(),f.photos) { file,bytes -> if(file.parentFile!!.name=="references") throw java.io.IOException("reference failure") else file.writeBytes(bytes) }
            val time=System.currentTimeMillis();val scene=repo.captureScene("杯子",f.jpeg,1,"PHONE",time)
            val place=ObservedLocation("桌面上","桌面",time)
            try { repo.finishCapturedScene(scene,AppearanceSample(f.jpeg,floatArrayOf(.2f,.4f),time),null,null,place,"");fail("Reference should fail") } catch(expected: java.io.IOException) { assertNotNull(expected.message) }
            assertTrue(File(scene.capture.imagePath).isFile)
            val saved=repo.finishCapturedScene(scene,null,null,null,place,"PHOTO_WRITE_FAILED")
            assertEquals(CaptureStatus.LOCATION_ONLY,saved.capture.status);assertTrue(repo.history(scene.capture.objectId).single().confirmed)
        }
    }
    @Test fun concurrentEditsPreventStaleAnalysisFromReplacingNewerObjectDataButRetainTheScene()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            val time=System.currentTimeMillis();val scene=f.repo.captureScene("杯子",f.jpeg,1,"PHONE",time)
            f.repo.recordLocation(scene.capture.objectId,"用户后来提供的新位置")
            try { f.repo.finishCapturedScene(scene,null,null,null,ObservedLocation("旧画面位置","桌面",time),"");fail("Old analysis should not commit") } catch(expected: IllegalStateException) { assertNotNull(expected.message) }
            assertTrue(File(scene.capture.imagePath).isFile);assertEquals("用户后来提供的新位置",f.repo.history(scene.capture.objectId).single().location)
        }
    }
    @Test fun semanticInterpretationCanStartMemoryWhileRawModelProseCannot()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            f.voice.connectSuccessfully=true;f.voice.interpreted=DialogueIntent.RememberObject("杯子")
            f.core.start(f.source,true);withTimeout(2000) { f.voice.state.first { it==RealtimeState.CONNECTED } }
            f.core.onUserText("麻烦你替我保留眼前这件物品的信息");f.awaitPhoto()
            assertEquals(1,f.voice.interpretationCalls);assertEquals(1,f.repo.captures(f.repo.findObject("杯子")!!.id).size)
            f.core.onUserText("你记住它了吗");assertTrue(f.core.state.value.lastSpeech!!.contains("实际保存状态"))
        }
    }
    @Test fun versionThreeUpgradeKeepsObjectsPhotosPositionsAndCreatesAValidatedPreUpgradeBackup()=runBlocking {
        RememberFlowDiagnostics.withFixture(context) { f ->
            val item=f.repo.rememberObject("水杯","cup",listOf(AppearanceSample(f.jpeg,floatArrayOf(.2f,.4f),100)))
            f.repo.recordLocation(item.id,"旧桌子");val original=f.db.objectMemoryDao().byId(item.id);val photo=f.db.objectMemoryDao().appearances(item.id).single()
            f.db.close()
            SQLiteDatabase.openDatabase(context.getDatabasePath(f.dbName).path,null,SQLiteDatabase.OPEN_READWRITE).use { old -> old.execSQL("DROP TABLE object_scene_captures");old.version=3 }
            f.db=AppDatabase.open(context,f.dbName)
            assertEquals(4,f.db.openHelper.writableDatabase.version);assertEquals(original,f.db.objectMemoryDao().byId(item.id))
            assertArrayEquals(File(photo.referenceImagePath).readBytes(),File(f.db.objectMemoryDao().appearances(item.id).single().referenceImagePath).readBytes())
            assertEquals("旧桌子",f.db.objectMemoryDao().locations(item.id).single().location);assertTrue(f.db.objectMemoryDao().captures(item.id).isEmpty())
            val backups=File(context.filesDir,"database-backups/${f.dbName}");assertTrue(backups.listFiles().orEmpty().any { it.name.startsWith("before-v4-") })
            backups.deleteRecursively()
            Unit
        }
    }
}
