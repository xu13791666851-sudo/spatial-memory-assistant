package com.spatialmemory.assistant.ui

import android.content.Context
import androidx.room.withTransaction
import com.spatialmemory.assistant.memory.*
import java.time.Instant
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

class NativeRecords(private val context: Context, private val db: AppDatabase, private val repository: MemoryRepository, private val pc: com.spatialmemory.assistant.pc.PcAssistantSession? = null) {
    suspend fun all(): JSONArray = if (pc != null) pc.records() else db.withTransaction {
        JSONArray().apply {
            for (item in db.objectMemoryDao().all()) {
                val location = db.objectMemoryDao().locations(item.id).firstOrNull()
                val captures=db.objectMemoryDao().captures(item.id)
                val latest=captures.firstOrNull()
                put(JSONObject().put("id", item.id).put("name", item.name).put("appearance", item.semanticDescription.orEmpty())
                    .put("sample_count", db.objectMemoryDao().appearances(item.id).size)
                    .put("scene_count",captures.size).put("capture_status_label",latest?.let { CaptureStatus.label(it.status) } ?: "")
                    .put("suggested_location",if(latest?.verifiedLocation==null) latest?.suggestedLocation.orEmpty() else "")
                    .put("recorded_at", Instant.ofEpochMilli(item.updatedAtMs).toString())
                    .put("created_at", Instant.ofEpochMilli(item.createdAtMs).toString())
                    .put("location", location?.location ?: UNKNOWN_LOCATION)
                    .put("location_source", location?.source ?: "")
                    .put("location_recorded_at", location?.recordedAtMs ?: 0)
                    .put("aliases", JSONArray()).put("relations", JSONArray()))
            }
        }
    }

    suspend fun history(id: String): List<LocationObservationEntity> {
        if (pc != null) return pc.history(id)
        checkNotNull(db.objectMemoryDao().byId(id)) { "这件物品已删除" }
        return repository.history(id)
    }

    suspend fun edit(p: JSONObject) = if (pc != null) pc.edit(p) else db.withTransaction {
        val dao = db.objectMemoryDao()
        val item = checkNotNull(dao.byId(p.getString("id"))) { "记录已删除" }
        check(Instant.ofEpochMilli(item.updatedAtMs).toString() == p.getString("recorded_at")) { "记录已变化，请重新打开" }
        val name = p.getString("name").trim()
        val description = p.optString("appearance").trim()
        val location = p.getString("location").trim()
        require(name.length in 1..40 && description.length <= 150 && location.length in 1..600) { "请检查名称、描述和位置的长度" }
        val latest = dao.locations(item.id).firstOrNull()
        val locationChanged = location != UNKNOWN_LOCATION && location != latest?.location
        if (name == item.name && description == item.semanticDescription.orEmpty() && !locationChanged) return@withTransaction
        dao.edit(item.id, name, normalizeObjectName(name), description, maxOf(System.currentTimeMillis(), item.updatedAtMs + 1))
        if (locationChanged) dao.saveLocation(LocationObservationEntity(UUID.randomUUID().toString(), item.id, null, location, "用户提供", null, false, System.currentTimeMillis(), "USER_STATEMENT"))
    }

    suspend fun delete(p: JSONObject) = if (pc != null) pc.delete(p) else repository.deleteObject(p.getString("id"), Instant.parse(p.getString("recorded_at")).toEpochMilli())
    companion object { const val UNKNOWN_LOCATION = "尚未记录位置" }
}
