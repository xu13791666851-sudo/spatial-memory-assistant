package com.spatialmemory.assistant.conversation

import android.content.ContentValues
import android.content.Context
import android.content.SharedPreferences
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.util.UUID
import org.json.JSONArray

data class ChatMessage(val role: String, val text: String, val createdAtMs: Long)
data class ChatSession(
    val id: String, val createdAtMs: Long, val updatedAtMs: Long,
    val legacy: Boolean, val messageCount: Int, val preview: String,
)

/** Chat retention is independent of the durable object-memory database. */
class ConversationStore(
    context: Context,
    databaseName: String = "chat-history.db",
    private val legacyPreferences: SharedPreferences = context.getSharedPreferences("iseeyou-native", Context.MODE_PRIVATE),
    private val now: () -> Long = System::currentTimeMillis,
) : SQLiteOpenHelper(context.applicationContext, databaseName, null, 1) {
    companion object {
        const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000
    }

    override fun onConfigure(db: SQLiteDatabase) { db.setForeignKeyConstraintsEnabled(true) }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE sessions(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, legacy INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)")
        db.execSQL("CREATE INDEX messages_session_time ON messages(session_id, id)")
        db.execSQL("CREATE INDEX messages_expiry ON messages(created_at)")
        db.execSQL("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    private fun setting(db: SQLiteDatabase, key: String): String? =
        db.rawQuery("SELECT value FROM settings WHERE key=?", arrayOf(key)).use { if(it.moveToFirst()) it.getString(0) else null }

    private fun set(db: SQLiteDatabase, key: String, value: String) {
        db.insertWithOnConflict("settings", null, ContentValues().apply {
            put("key", key); put("value", value)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun create(db: SQLiteDatabase, time: Long, legacy: Boolean = false): String {
        val id = UUID.randomUUID().toString()
        db.insertOrThrow("sessions", null, ContentValues().apply {
            put("id", id); put("created_at", time); put("updated_at", time); put("legacy", if(legacy) 1 else 0)
        })
        return id
    }

    private fun insert(db: SQLiteDatabase, session: String, role: String, words: String, time: Long) {
        db.insertOrThrow("messages", null, ContentValues().apply {
            put("session_id", session); put("role", role); put("text", words); put("created_at", time)
        })
    }

    @Synchronized fun initialize(): String {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val time = now()
            if(setting(db, "migrated") == null) {
                // The old list has no dates. Retain it for 30 days from migration.
                val old = JSONArray(legacyPreferences.getString("native-chat", "[]"))
                if(old.length() > 0) {
                    val session = create(db, time, legacy = true)
                    repeat(old.length()) { index ->
                        val item = old.getJSONObject(index)
                        val words = item.getString("text")
                        if(words.isNotBlank()) insert(db, session, if(item.optString("role") == "user") "user" else "assistant", words, time)
                    }
                }
                set(db, "migrated", "1")
            }
            db.delete("messages", "created_at <= ?", arrayOf((time - RETENTION_MS).toString()))
            db.delete("sessions", "updated_at <= ?", arrayOf((time - RETENTION_MS).toString()))
            var current = setting(db, "current")
            val exists = current != null && db.rawQuery("SELECT 1 FROM sessions WHERE id=?", arrayOf(current)).use { it.moveToFirst() }
            if(!exists) {
                current = create(db, time)
                set(db, "current", current)
            }
            db.setTransactionSuccessful()
            return checkNotNull(current)
        } finally {
            db.endTransaction()
            // Remove only after the migration transaction committed successfully.
            if(setting(db, "migrated") != null && legacyPreferences.contains("native-chat")) {
                check(legacyPreferences.edit().remove("native-chat").commit())
            }
        }
    }

    @Synchronized fun newSession(): String {
        initialize()
        val db = writableDatabase
        db.beginTransaction()
        try {
            val id = create(db, now())
            set(db, "current", id)
            db.setTransactionSuccessful()
            return id
        } finally { db.endTransaction() }
    }

    @Synchronized fun append(role: String, words: String): Boolean {
        if(words.isBlank()) return false
        val session = initialize()
        val db = writableDatabase
        val normalized = if(role == "user") "user" else "assistant"
        db.beginTransaction()
        try {
            val duplicate = db.rawQuery("SELECT role,text FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1", arrayOf(session)).use {
                it.moveToFirst() && it.getString(0) == normalized && it.getString(1) == words
            }
            if(duplicate) return false
            val time = now()
            insert(db, session, normalized, words, time)
            db.update("sessions", ContentValues().apply { put("updated_at", time) }, "id=?", arrayOf(session))
            db.setTransactionSuccessful()
            return true
        } finally { db.endTransaction() }
    }

    @Synchronized fun messages(session: String = initialize(), limit: Int = 200): List<ChatMessage> {
        initialize()
        require(limit in 1..100_000)
        return readableDatabase.rawQuery(
            "SELECT role,text,created_at FROM (SELECT id,role,text,created_at FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id",
            arrayOf(session, limit.toString()),
        ).use { cursor -> buildList { while(cursor.moveToNext()) add(ChatMessage(cursor.getString(0), cursor.getString(1), cursor.getLong(2))) } }
    }

    @Synchronized fun sessions(): List<ChatSession> {
        initialize()
        return readableDatabase.rawQuery(
            "SELECT s.id,s.created_at,s.updated_at,s.legacy,COUNT(m.id),COALESCE((SELECT text FROM messages WHERE session_id=s.id ORDER BY id LIMIT 1),'') FROM sessions s LEFT JOIN messages m ON m.session_id=s.id GROUP BY s.id HAVING COUNT(m.id)>0 ORDER BY s.updated_at DESC,s.rowid DESC", null,
        ).use { cursor -> buildList {
            while(cursor.moveToNext()) add(ChatSession(cursor.getString(0), cursor.getLong(1), cursor.getLong(2), cursor.getInt(3) == 1, cursor.getInt(4), cursor.getString(5)))
        } }
    }
}
