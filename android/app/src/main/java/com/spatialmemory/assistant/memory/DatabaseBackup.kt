package com.spatialmemory.assistant.memory

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** Called before the first Room connection, in this app's single process only. */
internal object DatabaseBackup {
    fun beforeUpgrade(context: Context, name: String) {
        require(name.matches(Regex("[a-zA-Z0-9._-]+")))
        val source = context.getDatabasePath(name)
        if (!source.isFile) return
        val needsUpgrade = SQLiteDatabase.openDatabase(source.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            if (db.version !in 1..3) false else {
                db.rawQuery("PRAGMA wal_checkpoint(FULL)", null).use { cursor ->
                    check(cursor.moveToFirst() && cursor.getInt(0) == 0) { "旧记录正在使用，暂未升级" }
                }
                true
            }
        }
        if (!needsUpgrade) return
        val directory = File(context.filesDir, "database-backups/$name").apply { check(isDirectory || mkdirs()) }
        val backup = File(directory, "before-v4-${System.currentTimeMillis()}.db")
        FileOutputStream(backup).use { output -> source.inputStream().use { it.copyTo(output) }; output.fd.sync() }
        fun digest(file: File): ByteArray = MessageDigest.getInstance("SHA-256").run {
            file.inputStream().use { input -> val buffer = ByteArray(8192); while (true) { val count = input.read(buffer); if (count < 0) break; update(buffer, 0, count) } }
            digest()
        }
        check(digest(source).contentEquals(digest(backup))) { "旧记录备份校验失败，暂未升级" }
        SQLiteDatabase.openDatabase(backup.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("PRAGMA integrity_check", null).use { check(it.moveToFirst() && it.getString(0) == "ok") { "旧记录备份不完整，暂未升级" } }
        }
    }
}
