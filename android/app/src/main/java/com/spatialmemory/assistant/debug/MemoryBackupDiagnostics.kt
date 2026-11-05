package com.spatialmemory.assistant.debug

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.spatialmemory.assistant.BuildConfig
import com.spatialmemory.assistant.backup.*
import com.spatialmemory.assistant.memory.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject

/** Host-permit gated diagnostics: fixture writes use uniquely named, separate DBs. */
object MemoryBackupDiagnostics {
    fun handle(activity: ComponentActivity,intent: Intent?,beforeChange: suspend ()->Unit): Job? {
        if(!BuildConfig.DEBUG || activity.packageName!="com.spatialmemory.assistant.iseeyou.tablettest.debug" || intent?.action!=Intent.ACTION_MAIN) return null
        val action=intent.getStringExtra("backup_command") ?: return null
        if(action !in setOf("LOCAL","SEND_CODE","STATUS","CLOUD","NETWORK","PREPARE_LINK","VERIFY_LINK","REMEMBER","AUTO_MEMORY","MEMORY_REPLAY","CONTROLLED_QWEN")) return null
        val permitFile=File(activity.filesDir,"memory-backup-permit.json")
        val command=runCatching {
            require(permitFile.length() in 1..2048)
            JSONObject(permitFile.readText()).also {
                require(it.getString("permit")==intent.getStringExtra("permit"))
                require(it.getLong("expiresAt")-System.currentTimeMillis() in 0..60_000)
            }
        }.getOrNull() ?: return null
        return activity.lifecycleScope.launch {
            // A tablet can recreate the portrait activity immediately after launch.
            // Claim the one-use permit only once the resumed instance has settled.
            delay(900)
            if (!activity.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) return@launch
            val current=runCatching { JSONObject(permitFile.readText()) }.getOrNull() ?: return@launch
            if(current.optString("permit")!=command.getString("permit") ||
                current.optLong("expiresAt")-System.currentTimeMillis() !in 0..60_000 || !permitFile.delete()) return@launch
            val result=JSONObject().put("action",action).put("nonce",command.getString("permit")).put("phase","running").put("passed",false)
                .put("cameraUsed",false).put("microphoneUsed",false).put("productionMemoryMutated",false)
            val report=File(activity.filesDir,"memory-backup-check.json");report.writeText(result.toString())
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            try {
                beforeChange()
                val store=BackupSessionStore(activity)
                when(action) {
                    "LOCAL" -> result.put("result",local(activity))
                    "REMEMBER" -> result.put("result",RememberFlowDiagnostics.run(activity))
                    "AUTO_MEMORY" -> result.put("result",AutomaticMemoryDiagnostics.run(activity))
                    "CONTROLLED_QWEN" -> result.put("result",ControlledConversationDiagnostics.realQwen(activity))
                    "MEMORY_REPLAY" -> {
                        val input=File(activity.filesDir,"automatic-memory-test-input.jpg")
                        try {
                            require(input.length() in 1..2_000_000 && MemoryBackupArchive.fileDigest(input)==command.getString("inputSha256"))
                            result.put("result",AutomaticMemoryDiagnostics.run(activity,input.readBytes()))
                        } finally { input.delete() }
                    }
                    "SEND_CODE" -> { result.put("codeSent",SupabaseBackupClient(store).sendCode(command.getString("email"))).put("awaitingCode",store.pending()!=null) }
                    "STATUS" -> result.put("loggedIn",store.session()!=null).put("awaitingCode",store.pending()!=null).put("requestRemainingSeconds",store.pendingRemainingSeconds())
                    "NETWORK" -> result.put("emailProviderEnabled",SupabaseBackupClient(store).connectivity())
                    "PREPARE_LINK" -> { File(activity.filesDir,"backup-email-public.json").writeText(store.prepareEmailProof().toString());result.put("proofImportPrepared",true) }
                    "VERIFY_LINK" -> {
                        val proof=File(activity.filesDir,"backup-email-proof.json")
                        try {
                            require(proof.length() in 1..2048)
                            SupabaseBackupClient(store).verifyEmailLink(store.consumeEmailProof(JSONObject(proof.readText())))
                            result.put("loggedIn",store.session()!=null)
                        } finally { proof.delete() }
                    }
                    "CLOUD" -> result.put("result",cloud(activity,store))
                }
                result.put("passed",true)
            } catch(error: TimeoutCancellationException) { result.put("failureKind","TIMEOUT").put("message","检查超时，原记录未改动") }
            catch(error: CancellationException) { result.put("failureKind","INTERRUPTED");throw error }
            catch(error: Exception) {
                if(error is BackupApiException) {
                    result.put("httpStatus",error.status).put("message",error.message)
                    error.providerCode?.let { result.put("providerCode",it) };error.retryAfterSeconds?.let { result.put("retryAfterSeconds",it) }
                }
                else {
                    val causes=generateSequence<Throwable>(error) { it.cause }.take(6).toList()
                    val messages=causes.joinToString(" ") { it.message.orEmpty() }
                    val reason=listOf("Connection reset","Connection refused","Network is unreachable","Permission denied","timeout","Unable to resolve host").firstOrNull { messages.contains(it,ignoreCase=true) }
                    result.put("failureKind",error.javaClass.simpleName).put("networkReason",reason ?: "not_reported").put("message","备份检查未完成，原有本地记录未改动")
                }
            } finally {
                result.put("phase","complete");report.writeText(result.toString(2));activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }
    private suspend fun local(context: android.content.Context): JSONObject = withContext(Dispatchers.IO) {
        val uid=UUID.randomUUID().toString();val root=File(context.filesDir,"backup-fixture-$uid").apply { check(mkdirs()) }
        val sourceName="backup-source-$uid.db";val targetName="backup-target-$uid.db"
        val source=AppDatabase.open(context,sourceName);var target=AppDatabase.open(context,targetName)
        var snapshot: PreparedMemoryBackup?=null
        try {
            val photos=File(root,"source");val repo=MemoryRepository(context,source.memoryDao(),source.objectMemoryDao(),photos)
            val bitmap=Bitmap.createBitmap(180,180,Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
            val jpeg=try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG,90,it);it.toByteArray() } } finally { bitmap.recycle() }
            repeat(2) { item ->
                val saved=repo.rememberObject("同名测试杯", "cup",List(3) { AppearanceSample(jpeg,FloatArray(48) { item+it/100f },System.currentTimeMillis()) })
                repo.recordLocation(saved.id,"测试位置一");repo.recordLocation(saved.id,"测试位置二")
            }
            val account=UUID.randomUUID().toString()
            snapshot=MemoryBackupArchive(context,source,photos,File(root,"export")).export(account)
            val first=MemoryBackupArchive(context,target,File(root,"target"),File(root,"import")).restore(snapshot.file,account)
            check(first.restored==2)
            target.close();target=AppDatabase.open(context,targetName)
            val rows=target.objectMemoryDao().all();check(rows.size==2 && rows.map { it.name }.distinct().size==1)
            var images=0;var events=0
            for(row in rows) { images+=target.objectMemoryDao().appearances(row.id).size;events+=target.objectMemoryDao().locations(row.id).size }
            check(images==6 && events==4)
            val again=MemoryBackupArchive(context,target,File(root,"target"),File(root,"import")).restore(snapshot.file,account)
            check(again.restored==0 && again.kept==2)
            JSONObject().put("objects",rows.size).put("photos",images).put("locations",events).put("sameNamesPreserved",true).put("reopenPassed",true).put("repeatRestoreIdempotent",true)
        } finally {
            snapshot?.close();source.close();target.close()
            context.deleteDatabase(sourceName);context.deleteDatabase(targetName);root.deleteRecursively()
        }
    }
    private suspend fun cloud(context: android.content.Context,store: BackupSessionStore): JSONObject=withContext(Dispatchers.IO) {
        val client=SupabaseBackupClient(store);val session=client.session()
        val uid=UUID.randomUUID().toString();val root=File(context.filesDir,"backup-cloud-check-$uid").apply { check(mkdirs()) }
        val targetName="backup-cloud-check-$uid.db";val target=AppDatabase.open(context,targetName)
        try {
            MemoryBackupArchive(context,AppDatabase.get(context)).export(session.userId).use { snapshot ->
                val uploaded=client.upload(snapshot,session)
                check(client.list(session).any { it.name==uploaded.name })
                val downloaded=File(root,"download.zip");client.download(uploaded,session,downloaded)
                check(MemoryBackupArchive.fileDigest(downloaded)==MemoryBackupArchive.fileDigest(snapshot.file))
                val restored=MemoryBackupArchive(context,target,File(root,"photos"),File(root,"staging")).restore(downloaded,session.userId)
                check(restored.restored==snapshot.objectCount && target.objectMemoryDao().all().size==snapshot.objectCount)
                check(client.anonymousReadDenied(uploaded,session)) { "备份空间意外允许公开读取" }
                JSONObject().put("uploadListDownloadPassed",true).put("downloadHashMatches",true).put("restoredIntoSeparateDatabase",true)
                    .put("objectCount",snapshot.objectCount).put("anonymousReadDenied",true).put("twoRealAccountsTested",false)
            }
        } finally { target.close();context.deleteDatabase(targetName);root.deleteRecursively() }
    }
}
