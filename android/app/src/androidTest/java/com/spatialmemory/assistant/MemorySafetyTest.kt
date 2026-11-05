package com.spatialmemory.assistant

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.ui.NativeRecords
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*

/** Run only on the dedicated emulator. Fixtures never use spatial-memory.db. */
class MemorySafetyTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val token = UUID.randomUUID().toString()
    private val name = "memory-safety-$token.db"
    private val photos = File(context.filesDir, "memory-safety-$token")
    private var database: AppDatabase? = null
    private fun db() = database ?: AppDatabase.open(context, name).also { database = it }
    private fun repository() = MemoryRepository(context, db().memoryDao(), db().objectMemoryDao(), photos)
    private fun samples(): List<AppearanceSample> = listOf(Color.RED, Color.BLUE, Color.GREEN).map { color ->
        val bitmap = Bitmap.createBitmap(40, 40, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        val jpeg = ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it); it.toByteArray() }
        bitmap.recycle()
        AppearanceSample(jpeg, floatArrayOf(.2f, .5f, .3f), 1234)
    }
    @After fun removeOnlyThisFixture() {
        database?.close()
        check(name.startsWith("memory-safety-") && name.contains(token))
        context.deleteDatabase(name)
        photos.deleteRecursively()
        File(context.filesDir, "database-backups/$name").deleteRecursively()
    }

    @Test fun sameNamesRemainIndependentAndUpdatesPreserveIdentityAndHistory() = runBlocking {
        val repo = repository()
        val first = repo.rememberObject("水杯", "cup", samples())
        val second = repo.rememberObject("水杯", "cup", samples())
        assertNotEquals(first.id, second.id)
        assertEquals(2, repo.findObjects("水杯").size)
        assertNull(repo.findObject("水杯"))
        repo.recordLocation(first.id, "书桌", expectedRevision = first.revision)
        repo.recordLocation(second.id, "厨房", expectedRevision = second.revision)
        val current = repo.byId(first.id)!!
        val oldFiles = db().objectMemoryDao().appearances(first.id).map { File(it.referenceImagePath) }
        val updated = repo.rememberObject("水杯", "cup", samples(), first.id, current.revision)
        assertEquals(first.id, updated.id)
        assertEquals(listOf("书桌"), repo.history(first.id).map { it.location })
        assertEquals(listOf("厨房"), repo.history(second.id).map { it.location })
        assertTrue(oldFiles.all(File::isFile))
        repo.deleteObject(first.id, updated.revision)
        assertNull(repo.byId(first.id))
        assertEquals(second.id, repo.findObject("水杯")!!.id)
        assertEquals("厨房", repo.history(second.id).single().location)
        assertTrue(db().objectMemoryDao().appearances(second.id).all { File(it.referenceImagePath).isFile })
    }

    @Test fun diskFailurePreservesPreviousPhotosAndRemovesPartialBatch() = runBlocking {
        val repo = repository()
        val first = repo.rememberObject("水杯", "cup", samples())
        val before = db().objectMemoryDao().appearances(first.id)
        var writes = 0
        val failing = MemoryRepository(context, db().memoryDao(), db().objectMemoryDao(), photos) { file, bytes ->
            if (++writes == 2) throw IOException("injected storage failure")
            file.writeBytes(bytes)
        }
        try { failing.rememberObject("水杯", "cup", samples(), first.id, first.revision); fail("must fail") }
        catch (expected: IOException) { assertTrue(expected.message!!.contains("injected")) }
        assertEquals(first.revision, repo.byId(first.id)!!.revision)
        assertEquals(before.map { it.id }, db().objectMemoryDao().appearances(first.id).map { it.id })
        assertTrue(before.all { File(it.referenceImagePath).isFile })
        assertEquals(0, File(photos, ".staging").listFiles()!!.size)
        assertEquals(3, photos.walkTopDown().count { it.extension == "jpg" })
    }

    @Test fun metadataFailureRollsBackReplacementAndKeepsHistory() = runBlocking {
        val repo = repository()
        val first = repo.rememberObject("水杯", "cup", samples())
        repo.recordLocation(first.id, "桌边")
        val dao = db().objectMemoryDao()
        val item = dao.byId(first.id)!!
        val before = dao.appearances(first.id)
        try {
            dao.commitAppearance(item.copy(updatedAtMs = item.updatedAtMs + 1), listOf(before[0], before[0]), item.updatedAtMs) { true }
            fail("duplicate appearance IDs must fail the transaction")
        } catch (expected: android.database.sqlite.SQLiteConstraintException) { /* real SQLite failure */ }
        assertEquals(item.updatedAtMs, dao.byId(first.id)!!.updatedAtMs)
        assertEquals(before.map { it.id }, dao.appearances(first.id).map { it.id })
        assertEquals("桌边", repo.history(first.id).single().location)
    }

    @Test fun cancellationAtCommitPreservesOldRecordAndNewIdentityIsNotPublished() = runBlocking {
        val repo = repository()
        val first = repo.rememberObject("水杯", "cup", samples())
        var validations = 0
        try {
            repo.rememberObject("水杯", "cup", samples(), first.id, first.revision) { ++validations < 5 }
            fail("cancelled save must fail")
        } catch (expected: IllegalStateException) { assertTrue(expected.message!!.contains("取消")) }
        assertEquals(first.revision, repo.byId(first.id)!!.revision)
        assertEquals(3, db().objectMemoryDao().appearances(first.id).size)
        assertEquals(3, photos.walkTopDown().count { it.extension == "jpg" })
    }

    @Test fun editsAppendLocationsOnlyWhenChangedAndStaleEditsCannotOverwrite() = runBlocking {
        val repo = repository()
        val first = repo.rememberObject("水杯", "cup", samples())
        val records = NativeRecords(context, db(), repo)
        val original = records.all().getJSONObject(0)
        records.edit(JSONObject(original.toString()).put("location", "书桌"))
        val afterLocation = records.all().getJSONObject(0)
        records.edit(JSONObject(afterLocation.toString()).put("appearance", "蓝色带把手"))
        assertEquals(1, repo.history(first.id).size)
        val afterDescription = records.all().getJSONObject(0)
        records.edit(JSONObject(afterDescription.toString()).put("location", "厨房"))
        assertEquals(listOf("厨房", "书桌"), repo.history(first.id).map { it.location })
        assertTrue(repo.history(first.id).all { it.source == "USER_STATEMENT" && !it.confirmed && it.observedAtMs == null })
        try { records.edit(JSONObject(original.toString()).put("location", "旧窗口误写")); fail("must reject stale edit") }
        catch (expected: IllegalStateException) { assertTrue(expected.message!!.contains("变化")) }
        assertEquals("厨房", repo.history(first.id).first().location)
    }

    @Test fun versionTwoMigrationPreservesRecordsPhotosAndCreatesValidatedBackup() = runBlocking {
        createOldDatabase(2)
        val database = db()
        assertEquals(4, database.openHelper.writableDatabase.version)
        val dao = database.objectMemoryDao()
        assertEquals(2, dao.all().size)
        assertEquals(1, dao.appearances("existing").size)
        assertTrue(File(dao.appearances("existing").single().referenceImagePath).isFile)
        assertEquals(setOf("旧书桌", "旧厨房"), dao.locations("existing").map { it.location }.toSet())
        assertTrue(dao.locations("existing").all { it.observedAtMs == null && it.source == "LEGACY_IMPORT" && !it.confirmed })
        assertEquals(1000L, dao.locations("existing").first { it.id == "old-position" }.recordedAtMs)
        assertEquals(2, database.memoryDao().all().size)
        assertEquals("旧对话", database.conversationDao().all().single().text)
        val backups = File(context.filesDir, "database-backups/$name").listFiles()!!.filter { it.extension == "db" }
        assertEquals(1, backups.size)
        SQLiteDatabase.openDatabase(backups.single().path, null, SQLiteDatabase.OPEN_READONLY).use { old ->
            assertEquals(2, old.version)
            old.rawQuery("SELECT COUNT(*) FROM object_appearances", null).use { assertTrue(it.moveToFirst()); assertEquals(1, it.getInt(0)) }
        }
        database.close(); this@MemorySafetyTest.database = null
        assertEquals(2, db().objectMemoryDao().all().size)
        assertEquals(1, File(context.filesDir, "database-backups/$name").listFiles()!!.count { it.extension == "db" })
    }

    @Test fun versionOneUpgradeImportsLegacyOnlyObjectsWithoutGuessingPictures() = runBlocking {
        createOldDatabase(1)
        val dao = db().objectMemoryDao()
        assertEquals(2, dao.all().size)
        assertEquals(0, dao.appearances(dao.findObjects("钥匙").single().id).size)
        assertEquals("旧抽屉", dao.locations(dao.findObjects("钥匙").single().id).single().location)
    }

    private fun createOldDatabase(version: Int) {
        check(database == null && !context.getDatabasePath(name).exists())
        context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null).use { old ->
            old.execSQL("CREATE TABLE item_memories (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, normalizedName TEXT NOT NULL, location TEXT NOT NULL, anchor TEXT NOT NULL, source TEXT NOT NULL, observedAtMs INTEGER NOT NULL, recordedAtMs INTEGER NOT NULL, confirmed INTEGER NOT NULL)")
            old.execSQL("CREATE TABLE conversation_messages (id TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, createdAtMs INTEGER NOT NULL)")
            old.execSQL("INSERT INTO item_memories VALUES ('linked', '水杯', '水杯', '旧厨房', '桌边', 'OLD', 500, 600, 1)")
            old.execSQL("INSERT INTO item_memories VALUES ('legacy-only', '钥匙', '钥匙', '旧抽屉', '抽屉', 'OLD', 700, 800, 1)")
            old.execSQL("INSERT INTO conversation_messages VALUES ('conversation', 'user', '旧对话', 900)")
            if (version == 2) {
                old.execSQL("CREATE TABLE remembered_objects (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, normalizedName TEXT NOT NULL, aliasesJson TEXT NOT NULL, yoloLabel TEXT, semanticDescription TEXT, createdAtMs INTEGER NOT NULL, updatedAtMs INTEGER NOT NULL)")
                old.execSQL("CREATE UNIQUE INDEX index_remembered_objects_normalizedName ON remembered_objects(normalizedName)")
                old.execSQL("CREATE TABLE object_appearances (id TEXT NOT NULL PRIMARY KEY, objectId TEXT NOT NULL, embeddingBlob BLOB NOT NULL, referenceImagePath TEXT NOT NULL, viewIndex INTEGER NOT NULL, capturedAtMs INTEGER NOT NULL, FOREIGN KEY(objectId) REFERENCES remembered_objects(id) ON DELETE CASCADE)")
                old.execSQL("CREATE INDEX index_object_appearances_objectId ON object_appearances(objectId)")
                old.execSQL("CREATE TABLE location_observations (id TEXT NOT NULL PRIMARY KEY, objectId TEXT NOT NULL, placeId TEXT, location TEXT NOT NULL, anchor TEXT NOT NULL, observedAtMs INTEGER NOT NULL, confirmed INTEGER NOT NULL, FOREIGN KEY(objectId) REFERENCES remembered_objects(id) ON DELETE CASCADE)")
                old.execSQL("CREATE INDEX index_location_observations_objectId ON location_observations(objectId)")
                old.execSQL("INSERT INTO remembered_objects VALUES ('existing', '水杯', '水杯', '[]', 'cup', '旧外观', 100, 200)")
                photos.mkdirs()
                val photo = File(photos, "old.jpg").apply { writeBytes(samples().first().jpeg) }
                old.execSQL("INSERT INTO object_appearances VALUES (?, ?, ?, ?, ?, ?)", arrayOf("old-photo", "existing", byteArrayOf(0, 0, 0, 0), photo.path, 0, 300))
                old.execSQL("INSERT INTO location_observations VALUES ('old-position', 'existing', NULL, '旧书桌', '用户提供', 1000, 1)")
            }
            old.version = version
        }
    }
}
