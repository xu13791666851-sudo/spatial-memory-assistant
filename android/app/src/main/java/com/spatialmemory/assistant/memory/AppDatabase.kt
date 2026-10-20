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

@Entity(tableName = "remembered_objects", indices = [Index(value = ["normalizedName"], unique = true)])
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
    val anchor: String, val observedAtMs: Long, val confirmed: Boolean,
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
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun saveObject(item: RememberedObjectEntity)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun saveAppearances(items: List<ObjectAppearanceEntity>)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun saveLocation(item: LocationObservationEntity)
    @Query("SELECT * FROM remembered_objects WHERE normalizedName = :name LIMIT 1") suspend fun findObject(name: String): RememberedObjectEntity?
    @Query("SELECT * FROM object_appearances WHERE objectId = :objectId ORDER BY viewIndex") suspend fun appearances(objectId: String): List<ObjectAppearanceEntity>
    @Query("SELECT * FROM location_observations WHERE objectId = :objectId AND confirmed = 1 ORDER BY observedAtMs DESC") suspend fun locations(objectId: String): List<LocationObservationEntity>
    @Query("DELETE FROM remembered_objects WHERE id = :objectId") suspend fun deleteObject(objectId: String)
}

@Dao
interface ConversationDao {
    @Insert suspend fun add(message: ConversationMessageEntity)
    @Query("SELECT * FROM conversation_messages ORDER BY createdAtMs") suspend fun all(): List<ConversationMessageEntity>
    @Query("DELETE FROM conversation_messages") suspend fun clear()
}

@Database(
    entities = [ItemMemoryEntity::class, ConversationMessageEntity::class, RememberedObjectEntity::class, ObjectAppearanceEntity::class, LocationObservationEntity::class],
    version = 2,
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

        @Volatile private var instance: AppDatabase? = null
        fun get(context: Context): AppDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, "spatial-memory.db")
                .addMigrations(MIGRATION_1_2)
                .build().also { instance = it }
        }
    }
}
