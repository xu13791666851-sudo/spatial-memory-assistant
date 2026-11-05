package com.spatialmemory.assistant.memory

import android.content.Context
import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "item_memories")
data class ItemMemoryEntity(
    @PrimaryKey val id: String, val name: String, val normalizedName: String, val location: String,
    val anchor: String, val source: String, val observedAtMs: Long, val recordedAtMs: Long, val confirmed: Boolean,
)

@Entity(tableName = "conversation_messages")
data class ConversationMessageEntity(@PrimaryKey val id: String, val role: String, val text: String, val createdAtMs: Long)

@Entity(tableName = "remembered_objects", indices = [Index(value = ["normalizedName"])])
data class RememberedObjectEntity(
    @PrimaryKey val id: String, val name: String, val normalizedName: String, val aliasesJson: String,
    val yoloLabel: String?, val semanticDescription: String?, val createdAtMs: Long, val updatedAtMs: Long,
)

@Entity(
    tableName = "object_appearances",
    foreignKeys = [ForeignKey(entity = RememberedObjectEntity::class, parentColumns = ["id"], childColumns = ["objectId"], onDelete = ForeignKey.CASCADE)],
    indices = [Index("objectId")],
)
data class ObjectAppearanceEntity(
    @PrimaryKey val id: String, val objectId: String, val embeddingBlob: ByteArray,
    val referenceImagePath: String, val viewIndex: Int, val capturedAtMs: Long,
)

@Entity(
    tableName = "location_observations",
    foreignKeys = [ForeignKey(entity = RememberedObjectEntity::class, parentColumns = ["id"], childColumns = ["objectId"], onDelete = ForeignKey.CASCADE)],
    indices = [Index("objectId")],
)
data class LocationObservationEntity(
    @PrimaryKey val id: String, val objectId: String, val placeId: String?, val location: String,
    val anchor: String, val observedAtMs: Long?, val confirmed: Boolean,
    val recordedAtMs: Long, val source: String,
)

@Dao
interface MemoryDao {
    @Query("SELECT * FROM item_memories WHERE confirmed = 1 ORDER BY recordedAtMs DESC") suspend fun all(): List<ItemMemoryEntity>
    @Query("DELETE FROM item_memories WHERE normalizedName = :name") suspend fun deleteName(name: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(item: ItemMemoryEntity)
    @Query("SELECT * FROM item_memories WHERE normalizedName = :name AND confirmed = 1 ORDER BY recordedAtMs DESC") suspend fun find(name: String): List<ItemMemoryEntity>
    @Query("DELETE FROM item_memories") suspend fun clear()
}

@Dao
interface ObjectMemoryDao {
    @Query("SELECT * FROM remembered_objects ORDER BY updatedAtMs DESC") suspend fun all(): List<RememberedObjectEntity>
    @Query("SELECT * FROM remembered_objects WHERE id = :id") suspend fun byId(id: String): RememberedObjectEntity?
    @Query("UPDATE remembered_objects SET name = :name, normalizedName = :normalizedName, semanticDescription = :description, updatedAtMs = :time WHERE id = :id") suspend fun edit(id: String, name: String, normalizedName: String, description: String, time: Long)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun saveObject(item: RememberedObjectEntity)
    @Update suspend fun updateObject(item: RememberedObjectEntity)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun saveAppearances(items: List<ObjectAppearanceEntity>)
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun saveLocation(item: LocationObservationEntity)
    @Query("SELECT * FROM remembered_objects WHERE normalizedName = :name LIMIT 1") suspend fun findObject(name: String): RememberedObjectEntity?
    @Query("SELECT * FROM remembered_objects WHERE normalizedName = :name ORDER BY createdAtMs, id") suspend fun findObjects(name: String): List<RememberedObjectEntity>
    @Query("SELECT * FROM object_appearances WHERE objectId = :objectId ORDER BY viewIndex") suspend fun appearances(objectId: String): List<ObjectAppearanceEntity>
    @Query("SELECT * FROM location_observations WHERE objectId = :objectId ORDER BY recordedAtMs DESC, id DESC") suspend fun locations(objectId: String): List<LocationObservationEntity>
    @Query("DELETE FROM object_appearances WHERE objectId = :objectId") suspend fun deleteAppearances(objectId: String)
    @Query("DELETE FROM remembered_objects WHERE id = :objectId") suspend fun deleteObject(objectId: String)
    @Query("SELECT * FROM object_scene_captures WHERE objectId = :objectId ORDER BY recordedAtMs DESC, id DESC") suspend fun captures(objectId: String): List<SceneCaptureEntity>
    @Query("SELECT * FROM object_scene_captures WHERE id = :id") suspend fun capture(id: String): SceneCaptureEntity?
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun saveCapture(item: SceneCaptureEntity)
    @Update suspend fun updateCapture(item: SceneCaptureEntity)

    @Transaction
    suspend fun commitScene(item: RememberedObjectEntity,capture: SceneCaptureEntity,expectedRevision: Long?,allowed: ()->Boolean) {
        check(allowed()) { "本轮已取消" }
        require(capture.objectId==item.id && capture.status==CaptureStatus.CAPTURED)
        if(expectedRevision==null) saveObject(item) else {
            check(byId(item.id)?.updatedAtMs==expectedRevision) { "物品记录已变化" };updateObject(item)
        }
        saveCapture(capture);check(allowed()) { "本轮已取消" }
    }

    @Transaction
    suspend fun finishScene(item: RememberedObjectEntity,capture: SceneCaptureEntity,samples: List<ObjectAppearanceEntity>?,location: LocationObservationEntity?,expectedRevision: Long,allowed: ()->Boolean) {
        check(allowed()) { "本轮已取消" }
        check(byId(item.id)?.updatedAtMs==expectedRevision) { "物品记录已变化，原画面已保留" }
        val original=checkNotNull(this.capture(capture.id)) { "画面记录已不存在" }
        require(original.objectId==item.id && capture.objectId==item.id && original.imagePath==capture.imagePath && capture.status in CaptureStatus.all)
        samples?.let { require(it.isNotEmpty() && it.all { s->s.objectId==item.id });deleteAppearances(item.id);saveAppearances(it) }
        location?.let { require(it.objectId==item.id && it.source=="CAMERA_VERIFIED" && it.confirmed && it.observedAtMs==capture.capturedAtMs);saveLocation(it) }
        updateObject(item);updateCapture(capture);check(allowed()) { "本轮已取消" }
    }

    @Transaction
    suspend fun createWithLocation(item: RememberedObjectEntity,event: LocationObservationEntity,newIdentity: Boolean) {
        check(newIdentity || findObjects(item.normalizedName).isEmpty()) { "已有同名物品，请选择具体是哪一件" }
        require(event.objectId==item.id && event.source=="USER_STATEMENT" && !event.confirmed && event.observedAtMs==null)
        saveObject(item);saveLocation(event)
    }

    @Transaction
    suspend fun commitAppearance(item: RememberedObjectEntity, samples: List<ObjectAppearanceEntity>, expectedRevision: Long?, observedLocation: LocationObservationEntity?=null,allowed: () -> Boolean) {
        check(allowed()) { "本轮采集已取消，未保存" }
        if (expectedRevision == null) saveObject(item) else {
            check(byId(item.id)?.updatedAtMs == expectedRevision) { "这件物品已修改，请重新打开后再采集" }
            updateObject(item)
            deleteAppearances(item.id)
        }
        saveAppearances(samples)
        observedLocation?.let {
            require(it.objectId==item.id && it.source=="CAMERA_VERIFIED" && it.confirmed && it.observedAtMs!=null)
            saveLocation(it)
        }
        check(allowed()) { "本轮采集已取消，未保存" }
    }

    @Transaction
    suspend fun appendLocation(id: String, expectedRevision: Long?, event: LocationObservationEntity) {
        val current = checkNotNull(byId(id)) { "这件物品已删除" }
        check(expectedRevision == null || current.updatedAtMs == expectedRevision) { "记录已变化，请重新打开" }
        require(event.objectId == id)
        saveLocation(event)
        updateObject(current.copy(updatedAtMs = maxOf(System.currentTimeMillis(), current.updatedAtMs + 1)))
    }

    @Transaction
    suspend fun deleteAtRevision(id: String, expectedRevision: Long?) {
        val item = checkNotNull(byId(id)) { "这件物品已删除" }
        check(expectedRevision == null || item.updatedAtMs == expectedRevision) { "记录已变化，请重新打开" }
        deleteObject(id)
    }
}

@Dao
interface ConversationDao {
    @Insert suspend fun add(message: ConversationMessageEntity)
    @Query("SELECT * FROM conversation_messages ORDER BY createdAtMs") suspend fun all(): List<ConversationMessageEntity>
    @Query("DELETE FROM conversation_messages") suspend fun clear()
}

@Database(
    entities = [ItemMemoryEntity::class, ConversationMessageEntity::class, RememberedObjectEntity::class, ObjectAppearanceEntity::class, LocationObservationEntity::class, SceneCaptureEntity::class],
    version = 4,
    exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun memoryDao(): MemoryDao
    abstract fun objectMemoryDao(): ObjectMemoryDao
    abstract fun conversationDao(): ConversationDao

    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `remembered_objects` (`id` TEXT NOT NULL, `name` TEXT NOT NULL, `normalizedName` TEXT NOT NULL, `aliasesJson` TEXT NOT NULL, `yoloLabel` TEXT, `semanticDescription` TEXT, `createdAtMs` INTEGER NOT NULL, `updatedAtMs` INTEGER NOT NULL, PRIMARY KEY(`id`))")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_remembered_objects_normalizedName` ON `remembered_objects` (`normalizedName`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `object_appearances` (`id` TEXT NOT NULL, `objectId` TEXT NOT NULL, `embeddingBlob` BLOB NOT NULL, `referenceImagePath` TEXT NOT NULL, `viewIndex` INTEGER NOT NULL, `capturedAtMs` INTEGER NOT NULL, PRIMARY KEY(`id`), FOREIGN KEY(`objectId`) REFERENCES `remembered_objects`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_object_appearances_objectId` ON `object_appearances` (`objectId`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `location_observations` (`id` TEXT NOT NULL, `objectId` TEXT NOT NULL, `placeId` TEXT, `location` TEXT NOT NULL, `anchor` TEXT NOT NULL, `observedAtMs` INTEGER NOT NULL, `confirmed` INTEGER NOT NULL, PRIMARY KEY(`id`), FOREIGN KEY(`objectId`) REFERENCES `remembered_objects`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_location_observations_objectId` ON `location_observations` (`objectId`)")
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("DROP INDEX IF EXISTS index_remembered_objects_normalizedName")
                db.execSQL("CREATE INDEX index_remembered_objects_normalizedName ON remembered_objects(normalizedName)")
                // Keep the old timestamp as the recording time. Earlier UI edits did not
                // distinguish the observation time from the moment of editing.
                db.execSQL("CREATE TABLE location_observations_v3 (`id` TEXT NOT NULL, `objectId` TEXT NOT NULL, `placeId` TEXT, `location` TEXT NOT NULL, `anchor` TEXT NOT NULL, `observedAtMs` INTEGER, `confirmed` INTEGER NOT NULL, `recordedAtMs` INTEGER NOT NULL, `source` TEXT NOT NULL, PRIMARY KEY(`id`), FOREIGN KEY(`objectId`) REFERENCES `remembered_objects`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)")
                db.execSQL("INSERT INTO location_observations_v3 SELECT id, objectId, placeId, location, anchor, NULL, 0, observedAtMs, 'LEGACY_IMPORT' FROM location_observations")
                db.execSQL("DROP TABLE location_observations")
                db.execSQL("ALTER TABLE location_observations_v3 RENAME TO location_observations")
                db.execSQL("CREATE INDEX index_location_observations_objectId ON location_observations(objectId)")
                // At version 2 a name identified at most one object. Resolve legacy
                // name-based positions once, before allowing duplicate names.
                db.execSQL("""INSERT INTO remembered_objects
                    SELECT 'legacy-' || m.id, m.name, m.normalizedName, '[]', NULL, NULL, m.recordedAtMs, m.recordedAtMs
                    FROM item_memories m WHERE m.id = (SELECT n.id FROM item_memories n WHERE n.normalizedName = m.normalizedName ORDER BY n.recordedAtMs DESC, n.id DESC LIMIT 1)
                    AND NOT EXISTS (SELECT 1 FROM remembered_objects o WHERE o.normalizedName = m.normalizedName)""")
                db.execSQL("""INSERT INTO location_observations
                    SELECT 'import-' || m.id, o.id, NULL, m.location, m.anchor, NULL, 0, m.recordedAtMs, 'LEGACY_IMPORT'
                    FROM item_memories m JOIN remembered_objects o ON o.normalizedName = m.normalizedName""")
            }
        }

        val MIGRATION_3_4 = object : Migration(3,4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS object_scene_captures (`id` TEXT NOT NULL, `objectId` TEXT NOT NULL, `imagePath` TEXT NOT NULL, `frameId` INTEGER NOT NULL, `cameraSource` TEXT NOT NULL, `capturedAtMs` INTEGER NOT NULL, `recordedAtMs` INTEGER NOT NULL, `status` TEXT NOT NULL, `description` TEXT, `suggestedLocation` TEXT, `verifiedLocation` TEXT, `failureKind` TEXT NOT NULL, PRIMARY KEY(`id`), FOREIGN KEY(`objectId`) REFERENCES `remembered_objects`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_object_scene_captures_objectId ON object_scene_captures(objectId)")
            }
        }

        fun open(context: Context, name: String): AppDatabase {
            DatabaseBackup.beforeUpgrade(context, name)
            return Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, name)
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4).build()
        }

        @Volatile private var instance: AppDatabase? = null
        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: open(context, "spatial-memory.db").also { instance = it }
        }
    }
}
