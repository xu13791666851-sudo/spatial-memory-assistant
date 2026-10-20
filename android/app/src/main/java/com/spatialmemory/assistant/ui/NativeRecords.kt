package com.spatialmemory.assistant.ui

import android.content.Context
import androidx.room.withTransaction
import com.spatialmemory.assistant.memory.*
import java.time.Instant
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** UI edits operate on the same Room objects used by the perception engine. */
class NativeRecords(private val context: Context, private val db: AppDatabase, private val repository: MemoryRepository) {
    suspend fun all(): JSONArray = JSONArray().apply {
        val legacy = db.memoryDao().all()
        for (item in db.objectMemoryDao().all()) {
            val location = db.objectMemoryDao().locations(item.id).firstOrNull()?.location
                ?: legacy.firstOrNull { it.normalizedName == item.normalizedName }?.location
            put(JSONObject().put("id", item.id).put("name", item.name).put("appearance", item.semanticDescription.orEmpty()).put("sample_count", db.objectMemoryDao().appearances(item.id).size)
                .put("recorded_at", Instant.ofEpochMilli(item.updatedAtMs).toString()).put("location", location ?: "已记住外观，尚未记录位置").put("aliases", JSONArray()).put("relations", JSONArray()))
        }
    }
    suspend fun edit(p: JSONObject) = db.withTransaction {
        val item = checkNotNull(db.objectMemoryDao().byId(p.getString("id"))) { "记录已删除" }
        check(Instant.ofEpochMilli(item.updatedAtMs).toString() == p.getString("recorded_at")) { "记录已变化" }
        val name = p.getString("name").trim(); val description = p.optString("appearance").trim(); val location = p.getString("location").trim()
        require(name.length in 1..40 && description.length <= 150 && location.length in 1..600)
        val normalized = name.replace(Regex("^(这个|那个|一个|一只|我的)"), "").lowercase()
        val collision = db.objectMemoryDao().findObject(normalized); check(collision == null || collision.id == item.id)
        db.objectMemoryDao().edit(item.id, name, normalized, description, System.currentTimeMillis())
        if (location != "已记住外观，尚未记录位置") {
            db.objectMemoryDao().saveLocation(LocationObservationEntity(UUID.randomUUID().toString(), item.id, null, location, "用户提供", System.currentTimeMillis(), true))
        }
    }
    suspend fun delete(p: JSONObject) {
        val item = checkNotNull(db.objectMemoryDao().byId(p.getString("id")))
        check(Instant.ofEpochMilli(item.updatedAtMs).toString() == p.getString("recorded_at"))
        repository.deleteObject(item.id)
        db.memoryDao().deleteName(item.normalizedName)
    }
}
