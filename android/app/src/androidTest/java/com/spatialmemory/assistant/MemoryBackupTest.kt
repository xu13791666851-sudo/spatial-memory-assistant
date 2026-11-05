package com.spatialmemory.assistant

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.backup.*
import com.spatialmemory.assistant.memory.*
import java.io.*
import java.util.UUID
import java.util.zip.*
import kotlinx.coroutines.runBlocking
import org.junit.*
import org.junit.Assert.*
import org.json.JSONObject

class MemoryBackupTest {
    @Test fun completeCaptureRoundTripPreservesSceneDescriptionTargetReferenceAndVerifiedLocation()=runBlocking {
        val repo=MemoryRepository(context,source.memoryDao(),source.objectMemoryDao(),sourcePhotos)
        val time=System.currentTimeMillis();val scene=repo.captureScene("杯子",jpeg(Color.BLUE),1,"PHONE",time)
        val finished=repo.finishCapturedScene(scene,AppearanceSample(jpeg(Color.BLUE),floatArrayOf(.1f,.9f),time),"蓝色杯身","黄色桌面上",ObservedLocation("桌面上","桌面",time),"")
        archive(source,sourcePhotos).export(account).use { snapshot ->
            archive(target,targetPhotos).restore(snapshot.file,account)
            val copy=target.objectMemoryDao().captures(scene.capture.objectId).single()
            assertEquals(CaptureStatus.COMPLETE,copy.status);assertEquals("蓝色杯身",copy.description);assertEquals("桌面上",copy.verifiedLocation)
            assertArrayEquals(File(finished.capture.imagePath).readBytes(),File(copy.imagePath).readBytes())
            assertEquals(1,target.objectMemoryDao().appearances(scene.capture.objectId).size);assertTrue(target.objectMemoryDao().locations(scene.capture.objectId).single().confirmed)
        }
    }
    @Test fun previousVersionOneArchivesRemainRestorableWithoutInventingSceneEvidence()=runBlocking {
        seed()
        archive(source,sourcePhotos).export(account).use { snapshot ->
            val old=rewrite(snapshot.file,"version-one.zip",{name,bytes ->
                if(name!="manifest.json") bytes else {
                    val manifest=JSONObject(String(bytes,Charsets.UTF_8));val state=manifest.getJSONObject("state");val objects=state.getJSONArray("objects")
                    for(i in 0 until objects.length()) objects.getJSONObject(i).remove("captures")
                    manifest.put("schema",1).put("stateDigest",MemoryBackupArchive.digest(state.toString().toByteArray(Charsets.UTF_8))).toString().toByteArray(Charsets.UTF_8)
                }
            })
            assertEquals(2,archive(target,targetPhotos).restore(old,account).restored)
            for(item in target.objectMemoryDao().all()) { assertEquals(3,target.objectMemoryDao().appearances(item.id).size);assertTrue(target.objectMemoryDao().captures(item.id).isEmpty()) }
        }
    }
    @Test fun aCorruptSceneImageCannotPartiallyRestoreItsObjectOrPosition()=runBlocking {
        val repo=MemoryRepository(context,source.memoryDao(),source.objectMemoryDao(),sourcePhotos)
        repo.captureScene("杯子",jpeg(Color.BLUE),1,"PHONE",System.currentTimeMillis())
        archive(source,sourcePhotos).export(account).use { snapshot ->
            val bad=rewrite(snapshot.file,"bad-scene.zip",{name,bytes -> if(name.startsWith("scenes/")) jpeg(Color.RED) else bytes})
            try { archive(target,targetPhotos).restore(bad,account);fail("Corrupt scene accepted") } catch(expected: IllegalArgumentException) { assertTrue(target.objectMemoryDao().all().isEmpty()) }
        }
    }
    private val context=ApplicationProvider.getApplicationContext<Context>()
    private val token=UUID.randomUUID().toString();private val account=UUID.randomUUID().toString()
    private val root=File(context.filesDir,"backup-test-$token").apply { mkdirs() }
    private val sourceName="backup-test-source-$token.db";private val targetName="backup-test-target-$token.db"
    private val source=AppDatabase.open(context,sourceName);private var target=AppDatabase.open(context,targetName)
    private val sourcePhotos=File(root,"source");private val targetPhotos=File(root,"target")
    private fun archive(db: AppDatabase,photos: File)=MemoryBackupArchive(context,db,photos,File(root,"cache"))
    private fun jpeg(color: Int): ByteArray {
        val bitmap=Bitmap.createBitmap(140,160,Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        return try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG,90,it);it.toByteArray() } } finally { bitmap.recycle() }
    }
    private suspend fun seed(): List<ObjectMemory> {
        val repo=MemoryRepository(context,source.memoryDao(),source.objectMemoryDao(),sourcePhotos)
        return listOf(Color.BLUE,Color.RED).map { color ->
            val item=repo.rememberObject("同名杯", "cup",List(3) { AppearanceSample(jpeg(color),FloatArray(48) { it/100f },1000L+it) })
            repo.recordLocation(item.id,"书桌","USER_STATEMENT",null,"用户提供")
            repo.recordLocation(item.id,"厨房","CAMERA_VERIFIED",2000,"画面左侧")
            source.objectMemoryDao().byId(item.id)!!.let { item.copy(revision=it.updatedAtMs) }
        }
    }
    private fun rewrite(original: File,name: String,transform: (String,ByteArray)->ByteArray,extra: String?=null): File {
        val result=File(root,name)
        ZipFile(original).use { input -> ZipOutputStream(result.outputStream()).use { output ->
            for(entry in input.entries().asSequence()) { output.putNextEntry(ZipEntry(entry.name));output.write(transform(entry.name,input.getInputStream(entry).readBytes()));output.closeEntry() }
            if(extra!=null) { output.putNextEntry(ZipEntry(extra));output.write(byteArrayOf(1));output.closeEntry() }
        } }
        return result
    }
    @After fun cleanup() { source.close();target.close();context.deleteDatabase(sourceName);context.deleteDatabase(targetName);root.deleteRecursively() }

    @Test fun roundTripPreservesDistinctSameNamesPhotosAndHistoricalSourcesAcrossReopen()=runBlocking {
        val items=seed()
        archive(source,sourcePhotos).export(account).use { snapshot ->
            assertEquals(2,snapshot.objectCount);val restored=archive(target,targetPhotos).restore(snapshot.file,account);assertEquals(2,restored.restored)
            target.close();target=AppDatabase.open(context,targetName)
            assertEquals(2,target.objectMemoryDao().findObjects("同名杯").size)
            for(item in items) {
                assertEquals(source.objectMemoryDao().byId(item.id),target.objectMemoryDao().byId(item.id))
                val originals=source.objectMemoryDao().appearances(item.id);val restoredPhotos=target.objectMemoryDao().appearances(item.id)
                assertEquals(3,restoredPhotos.size)
                originals.zip(restoredPhotos).forEach { (a,b) ->
                    assertEquals(a.id,b.id);assertArrayEquals(a.embeddingBlob,b.embeddingBlob)
                    assertEquals(MemoryBackupArchive.fileDigest(File(a.referenceImagePath)),MemoryBackupArchive.fileDigest(File(b.referenceImagePath)))
                    assertTrue(File(b.referenceImagePath).canonicalPath.startsWith(targetPhotos.canonicalPath+File.separator))
                }
                assertEquals(source.objectMemoryDao().locations(item.id),target.objectMemoryDao().locations(item.id))
            }
        }
    }
    @Test fun repeatedRestoreKeepsNewerLocalEditsAndDoesNotDuplicateHistory()=runBlocking {
        val item=seed().first()
        archive(source,sourcePhotos).export(account).use { snapshot ->
            archive(target,targetPhotos).restore(snapshot.file,account)
            target.objectMemoryDao().edit(item.id,"本地新名字","本地新名字","本地新描述",System.currentTimeMillis()+500)
            val repo=MemoryRepository(context,target.memoryDao(),target.objectMemoryDao(),targetPhotos);repo.recordLocation(item.id,"新的位置")
            val before=target.objectMemoryDao().byId(item.id);val history=target.objectMemoryDao().locations(item.id)
            val result=archive(target,targetPhotos).restore(snapshot.file,account)
            assertEquals(0,result.restored);assertEquals(2,result.kept);assertEquals(before,target.objectMemoryDao().byId(item.id));assertEquals(history,target.objectMemoryDao().locations(item.id))
        }
    }
    @Test fun corruptedPhotoAndPathTraversalCannotChangeExistingRecordsOrWriteOutsideStaging()=runBlocking {
        seed()
        archive(source,sourcePhotos).export(account).use { snapshot ->
            archive(target,targetPhotos).restore(snapshot.file,account)
            val before=target.objectMemoryDao().all()
            val bad=rewrite(snapshot.file,"bad.zip",{name,bytes -> if(name.startsWith("photos/")) jpeg(Color.GREEN) else bytes})
            val traversal=rewrite(snapshot.file,"traversal.zip",{_,bytes->bytes},"../outside-$token")
            for(file in listOf(bad,traversal)) {
                try { archive(target,targetPhotos).restore(file,account);fail("Unsafe archive accepted") }
                catch(expected: Exception) { assertTrue(expected is IllegalArgumentException || expected is ZipException) }
                assertEquals(before,target.objectMemoryDao().all())
            }
            assertFalse(File(root,"outside-$token").exists())
        }
    }
    @Test fun wrongAccountAndIncompleteDownloadAreRejectedBeforeDatabaseWrites()=runBlocking {
        seed()
        archive(source,sourcePhotos).export(account).use { snapshot ->
            try { archive(target,targetPhotos).restore(snapshot.file,UUID.randomUUID().toString());fail("Wrong account accepted") } catch(expected: IllegalArgumentException) { assertTrue(target.objectMemoryDao().all().isEmpty()) }
            val incomplete=File(root,"incomplete.zip").apply { writeBytes(snapshot.file.readBytes().copyOf(100)) }
            try { archive(target,targetPhotos).restore(incomplete,account);fail("Incomplete archive accepted") } catch(expected: IOException) { assertTrue(target.objectMemoryDao().all().isEmpty()) }
        }
    }
    @Test fun databaseConflictRollsBackEveryNewObjectAndRetainsExistingRecords()=runBlocking {
        seed()
        val collision=source.objectMemoryDao().all().sortedBy { it.id }.last().let { source.objectMemoryDao().locations(it.id).first() }
        val kept=RememberedObjectEntity(UUID.randomUUID().toString(),"原记录","原记录","[]",null,null,1,1)
        target.objectMemoryDao().saveObject(kept);target.objectMemoryDao().saveLocation(collision.copy(objectId=kept.id))
        archive(source,sourcePhotos).export(account).use { snapshot ->
            try { archive(target,targetPhotos).restore(snapshot.file,account);fail("Conflict should abort restoration") } catch(expected: android.database.sqlite.SQLiteConstraintException) { assertNotNull(expected.message) }
            assertEquals(listOf(kept),target.objectMemoryDao().all())
            assertEquals(1,target.objectMemoryDao().locations(kept.id).size)
            assertEquals(0,targetPhotos.walkTopDown().count { it.isFile })
        }
    }
    @Test fun exportsExcludeChatsPreferencesAndCredentialsAndRejectForeignPhotoPaths()=runBlocking {
        val item=seed().first()
        val sentinel="PRIVATE-SENTINEL-$token";source.conversationDao().add(ConversationMessageEntity(UUID.randomUUID().toString(),"user",sentinel,1))
        val foreign=File(root,"private-settings.txt").apply { writeText(sentinel) }
        archive(source,sourcePhotos).export(account).use { snapshot ->
            ZipFile(snapshot.file).use { zip -> for(entry in zip.entries().asSequence()) {
                assertTrue(entry.name=="manifest.json" || entry.name.startsWith("photos/"));assertFalse(String(zip.getInputStream(entry).readBytes(),Charsets.ISO_8859_1).contains(sentinel))
            } }
        }
        source.objectMemoryDao().deleteAppearances(item.id)
        source.objectMemoryDao().saveAppearances(listOf(ObjectAppearanceEntity(UUID.randomUUID().toString(),item.id,byteArrayOf(0,0,0,0),foreign.path,0,1)))
        try { archive(source,sourcePhotos).export(account);fail("Foreign file was included") } catch(expected: IllegalArgumentException) { assertEquals(sentinel,foreign.readText()) }
    }
}
