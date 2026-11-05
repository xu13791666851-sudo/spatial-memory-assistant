package com.spatialmemory.assistant.backup

import android.content.Context
import androidx.room.InvalidationTracker
import com.spatialmemory.assistant.memory.AppDatabase
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Backup is separate from finding and image review; commands reuse Records. */
class MemoryBackupCoordinator(
    context: Context, private val db: AppDatabase, private val scope: CoroutineScope,
    private val reply: (String)->Unit, private val beforeRestore: suspend ()->Unit,
    private val automatic: ()->Boolean = { true },
) : AutoCloseable {
    private val app=context.applicationContext
    private val store=BackupSessionStore(app)
    private val client=SupabaseBackupClient(store)
    private val archive=MemoryBackupArchive(app,db)
    private val serial=Mutex()
    private val status=app.getSharedPreferences("memory-backup-status",Context.MODE_PRIVATE)
    private var pending: Job?=null
    private var command: Job?=null
    private val observer=object: InvalidationTracker.Observer("remembered_objects","object_appearances","location_observations","object_scene_captures") {
        override fun onInvalidated(tables: Set<String>) { schedule() }
    }
    init { db.invalidationTracker.addObserver(observer) }
    companion object {
        private fun rawLink(text: String)=text.trim().let { (it.startsWith("https://") || it.startsWith("http://")) && it.contains("/auth/v1/verify") }
        fun sensitive(text: String)=text.trim().startsWith("登录备份") || text.trim().startsWith("重发备份邮件") || text.trim().startsWith("验证码") || text.trim().startsWith("登录链接") || rawLink(text)
        fun accepts(text: String): Boolean {
            val clean=text.trim().trimEnd('。','！','!','？','?')
            return clean in setOf("备份记忆","备份我的记忆","恢复记忆","恢复我的记忆","备份状态","退出备份","取消备份登录") || sensitive(clean)
        }
    }
    fun handle(text: String): Boolean {
        if(!accepts(text)) return false
        if(command?.isActive==true) { reply("上一项备份操作仍在进行，请稍候");return true }
        val clean=text.trim().trimEnd('。','！','!','？','?')
        command=scope.launch {
            serial.withLock {
                try {
                    when {
                        clean.startsWith("登录备份") || clean.startsWith("重发备份邮件") -> {
                            val resend=clean.startsWith("重发备份邮件")
                            val email=clean.removePrefix(if(resend) "重发备份邮件" else "登录备份").trim()
                            if(email.isBlank()) reply("请在对话记录输入“登录备份 你的邮箱”")
                            else {
                                val sent=client.sendCode(email,resend)
                                reply((if(sent) "登录邮件已发送。" else "登录申请仍有效，本次没有重复发信。")+"请使用最近收到的邮件，复制按钮链接，在这里输入“登录链接 链接地址”。先不要点击邮件按钮。应用保留申请一小时，链接是否有效仍由服务端验证；出现“备份账号已登录”才算完成。")
                            }
                        }
                        clean.startsWith("验证码") -> { client.verifyCode(clean.removePrefix("验证码").trim());reply("备份账号已登录。记忆变化后会自动备份；输入“恢复记忆”可补回云端保存的物品。") }
                        clean.startsWith("登录链接") -> { client.verifyEmailLink(clean.removePrefix("登录链接").trim());reply("备份账号已登录。记忆变化后会自动备份；输入“恢复记忆”可补回云端保存的物品。") }
                        rawLink(clean) -> { client.verifyEmailLink(clean);reply("备份账号已登录。记忆变化后会自动备份；输入“恢复记忆”可补回云端保存的物品。") }
                        clean=="退出备份" -> { pending?.cancel();store.signOut();reply("已退出云端备份，本地物品和对话仍保留") }
                        clean=="取消备份登录" -> { store.cancelPending();reply("已取消这次备份登录") }
                        clean=="备份状态" -> {
                            val time=status.getLong("lastSuccess",0)
                            reply(if(store.session()==null) "云端备份尚未登录，本地记忆正常保存" else if(time==0L) "备份账号已登录，尚无成功上传的物品备份" else "最近备份完成于 "+DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(time)))
                        }
                        clean.startsWith("恢复") -> restore()
                        else -> backup(true)
                    }
                } catch(error: CancellationException) { throw error }
                catch(error: Exception) { reply(safeMessage(error)) }
            }
            if(store.session()!=null) schedule()
        }
        return true
    }
    fun schedule() {
        if (!automatic()) return
        scope.launch {
            pending?.cancel()
            if(store.session()==null) return@launch
            pending=scope.launch {
                delay(1800)
                serial.withLock {
                    try { backup(false) } catch(error: CancellationException) { throw error } catch(error: Exception) { /* Local records remain authoritative; next start retries. */ }
                }
            }
        }
    }
    private suspend fun backup(manual: Boolean) {
        val session=client.session()
        archive.export(session.userId).use { snapshot ->
            if(snapshot.objectCount==0) { if(manual) reply("还没有已保存的物品，本地对话仍保留");return }
            if(!manual && snapshot.digest==store.lastDigest(session.userId)) return
            val uploaded=client.upload(snapshot,session)
            val check=File(app.cacheDir,"backup-check-${UUID.randomUUID()}.zip")
            try {
                client.download(uploaded,session,check)
                require(MemoryBackupArchive.fileDigest(check)==MemoryBackupArchive.fileDigest(snapshot.file)) { "备份上传校验失败" }
            } finally { check.delete() }
            store.uploaded(session.userId,snapshot.digest);status.edit().putLong("lastSuccess",System.currentTimeMillis()).apply()
            if(manual) reply("已备份 ${snapshot.objectCount} 件物品、参考照片和位置历史，本地记录仍保留")
        }
    }
    private suspend fun restore() {
        beforeRestore()
        val session=client.session();val latest=client.list(session).firstOrNull()
        if(latest==null) { reply("这个账号暂时没有物品备份");return }
        val download=File(app.cacheDir,"backup-download-${UUID.randomUUID()}.zip")
        try {
            client.download(latest,session,download)
            val result=archive.restore(download,session.userId)
            reply("已补回 ${result.restored} 件物品，保留 ${result.kept} 件现有记录。恢复的是历史记忆，当前位置仍需重新查看。")
        } finally { download.delete() }
    }
    private fun safeMessage(error: Exception): String = if(error is BackupApiException) error.message.orEmpty() else when {
        error is IllegalStateException && store.session()==null -> SupabaseBackupClient.LOGIN_REQUIRED
        else -> "备份操作未完成，请检查网络或验证码后重试；原有本地记录完整保留"
    }
    override fun close() { db.invalidationTracker.removeObserver(observer);pending?.cancel();command?.cancel() }
}
