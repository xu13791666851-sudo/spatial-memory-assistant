package com.spatialmemory.assistant.backup

import com.spatialmemory.assistant.BuildConfig
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.*

class BackupApiException(val status: Int, message: String,val providerCode: String?=null,val retryAfterSeconds: Long?=null): IOException(message)
data class CloudMemoryBackup(val name: String,val size: Long)

/** Official Auth/Storage protocol. The publishable key is not an admin key. */
class SupabaseBackupClient(
    private val store: BackupSessionStore,
    private val http: OkHttpClient=OkHttpClient.Builder().callTimeout(60,TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build(),
    testEndpoint: String?=null,
) {
    private val base=(testEndpoint ?: BuildConfig.SUPABASE_URL).toHttpUrl()
    private val relay=if(testEndpoint==null) BuildConfig.GATEWAY_URL.toHttpUrl() else null
    private val sessionMutex=Mutex()
    private val mailMutex=Mutex()
    init {
        require(if(testEndpoint==null) base.isHttps && base.host=="awkzcvvzrsfjvqlloqqi.supabase.co" else base.host in setOf("127.0.0.1","localhost"))
        require(relay==null || (relay.isHttps && relay.host=="i-see-you-android-core-test.pages.dev"))
    }
    companion object {
        const val BUCKET="iseeyou-memory-backups"
        const val LOGIN_REQUIRED="还没有有效的登录申请。请先发送“登录备份 你的邮箱”，收到邮件后复制按钮链接并发送“登录链接 链接地址”。出现“备份账号已登录”才算完成。"
    }
    private fun destination(path: String): HttpUrl = if(relay==null) base.newBuilder().addPathSegments(path).build() else relay.newBuilder().addPathSegments("api/android/backup/$path").build()
    private fun request(path: String,token: String?=null): Request.Builder = Request.Builder().url(destination(path))
        .header("apikey",BuildConfig.SUPABASE_PUBLISHABLE_KEY).apply { if(token!=null) header("Authorization","Bearer $token") }
    private fun json(value: JSONObject)=value.toString().toRequestBody("application/json".toMediaType())
    private suspend fun <T> execute(request: Request,consume: (Response)->T): T = suspendCancellableCoroutine { continuation ->
        val call=http.newCall(request);continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object: Callback {
            override fun onFailure(call: Call,error: IOException) { if(continuation.isActive) continuation.resumeWith(Result.failure(error)) }
            override fun onResponse(call: Call,response: Response) {
                if(!continuation.isActive) { response.close();return }
                val result=runCatching { response.use {
                    if(!it.isSuccessful) {
                        // Never surface raw provider bodies, email addresses or tokens.
                        val code=runCatching { JSONObject(it.peekBody(8192).string()).let { body -> body.optString("error_code").ifBlank { body.optString("code") } } }.getOrDefault("")
                        val safeCode=code.takeIf { value -> value in setOf("email_address_not_authorized","email_address_invalid","otp_expired","otp_disabled","over_email_send_rate_limit","over_request_rate_limit") }
                        val retry=it.header("Retry-After")?.toLongOrNull()?.takeIf { value -> value in 1..3600 }
                        throw BackupApiException(it.code,when {
                            code in setOf("email_address_not_authorized","email_address_invalid") -> "项目邮件服务尚未允许这个邮箱，请检查邮件配置"
                            code in setOf("otp_expired","otp_disabled") -> "这条登录链接或验证码已过期或已使用，本次尚未登录。请重新申请登录邮件。"
                            code=="over_email_send_rate_limit" -> "登录邮件已达到服务发送限额（默认每小时两封）。请先使用最近收到且未点击的邮件链接；没有可用链接时需等额度恢复。"
                            it.code==401 -> "备份登录已失效，请重新登录"
                            it.code==403 -> "云端访问未获允许，请检查备份规则和登录账号"
                            it.code==404 -> "云端备份空间尚未准备好"
                            it.code==429 -> "登录或备份请求暂时受限，请稍后再试。已有邮件链接仍可用于验证，不必反复申请邮件。"
                            it.code in 300..399 -> "备份地址发生跳转，本次已停止连接"
                            else -> "云端操作未完成（HTTP ${it.code}），本地记忆仍保留"
                        },safeCode,retry)
                    }
                    consume(it)
                } }
                if(continuation.isActive) continuation.resumeWith(result)
            }
        })
    }
    private suspend fun text(request: Request): String=execute(request) { response ->
        val body=response.body ?: error("云端返回为空")
        body.source().request(65_537);require(body.source().buffer.size<=65_536) { "云端返回内容过大" };body.string()
    }
    suspend fun sendCode(email: String,resend: Boolean=false): Boolean = mailMutex.withLock {
        require(email.length<=254 && android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) { "请检查邮箱地址" }
        if(!resend && store.pending()?.equals(email,ignoreCase=true)==true) return@withLock false
        val remaining=(store.mailAttemptAllowedAt()-System.currentTimeMillis()+999)/1000
        if(remaining>0) throw BackupApiException(429,"刚才已经申请过登录邮件，请等待 $remaining 秒后再申请；已有邮件链接可以继续验证。",retryAfterSeconds=remaining)
        store.mailAttempted()
        try { text(request("auth/v1/otp").post(json(JSONObject().put("email",email).put("create_user",true))).build()) }
        catch(error: BackupApiException) {
            if(error.status==429) store.mailAttempted(waitSeconds=error.retryAfterSeconds ?: 60)
            throw error
        }
        store.pending(email)
        true
    }
    suspend fun verifyCode(code: String): BackupSession {
        require(code.matches(Regex("[0-9]{6,10}"))) { "请输入邮件中的数字验证码" }
        val email=store.pending() ?: error(LOGIN_REQUIRED)
        return verify(request("auth/v1/verify").post(json(JSONObject().put("email",email).put("token",code).put("type","email"))).build(),email)
    }
    suspend fun verifyEmailLink(value: String): BackupSession {
        val email=store.pending() ?: error(LOGIN_REQUIRED)
        require(value.length<=4096) { "登录链接无效" }
        val link=value.toHttpUrl()
        require(link.isHttps && link.host=="awkzcvvzrsfjvqlloqqi.supabase.co" && link.encodedPath=="/auth/v1/verify" && link.username.isEmpty() && link.password.isEmpty() && link.fragment==null) { "请复制当前项目邮件中的原始登录链接" }
        val hash=link.queryParameter("token") ?: link.queryParameter("token_hash") ?: error("登录链接不完整")
        val type=link.queryParameter("type") ?: error("登录链接不完整")
        require(hash.matches(Regex("[A-Za-z0-9_-]{20,256}")) && type in setOf("email","signup","magiclink")) { "登录链接无效" }
        // Never open/follow the supplied URL or its redirect_to. Submit only the
        // one-use email proof to this project's fixed verified HTTPS endpoint.
        return verify(request("auth/v1/verify").post(json(JSONObject().put("token_hash",hash).put("type",type))).build(),email)
    }
    private suspend fun verify(request: Request,email: String): BackupSession = try { finishLogin(JSONObject(text(request)),email) }
    catch(error: BackupApiException) {
        if(error.providerCode in setOf("otp_expired","otp_disabled")) store.cancelPending()
        throw error
    }
    private fun finishLogin(body: JSONObject,email: String): BackupSession {
        require(body.getJSONObject("user").getString("email").equals(email,ignoreCase=true)) { "登录邮件与本次请求不匹配" }
        val result=parseSession(body);store.save(result);return result
    }
    suspend fun connectivity(): Boolean {
        val body=JSONObject(text(request("auth/v1/settings").get().build()))
        return body.optJSONObject("external")?.optBoolean("email",false)==true
    }
    private fun parseSession(body: JSONObject): BackupSession {
        val user=body.getJSONObject("user").getString("id");UUID.fromString(user)
        val access=body.getString("access_token");val refresh=body.getString("refresh_token")
        require(access.length in 20..16000 && refresh.length in 10..16000)
        val expires=body.getLong("expires_in");require(expires in 1..31_536_000)
        return BackupSession(user,access,refresh,System.currentTimeMillis()+expires*1000)
    }
    suspend fun session(): BackupSession=sessionMutex.withLock {
        val old=store.session() ?: error("请先在对话记录输入“登录备份 你的邮箱”")
        if(old.expiresAtMs>System.currentTimeMillis()+60_000) old else {
            val url=destination("auth/v1/token").newBuilder().addQueryParameter("grant_type","refresh_token").build()
            val updated=parseSession(JSONObject(text(request("auth/v1/token").url(url).post(json(JSONObject().put("refresh_token",old.refreshToken))).build())))
            require(updated.userId==old.userId) { "登录账号发生变化，请重新登录" };store.save(updated);updated
        }
    }
    private fun path(user: String,name: String): String {
        UUID.fromString(user)
        require(name.matches(Regex("[0-9]{13}-[a-f0-9-]{36}\\.zip"))) { "备份名称无效" }
        return "$user/$name"
    }
    suspend fun upload(snapshot: PreparedMemoryBackup, session: BackupSession): CloudMemoryBackup {
        require(snapshot.file.length() in 1..MemoryBackupArchive.MAX_BYTES)
        val name="${System.currentTimeMillis()}-${UUID.randomUUID()}.zip"
        text(request("storage/v1/object/$BUCKET/${path(session.userId,name)}",session.accessToken)
            .header("x-upsert","false").post(snapshot.file.asRequestBody("application/zip".toMediaType())).build())
        return CloudMemoryBackup(name,snapshot.file.length())
    }
    suspend fun list(session: BackupSession): List<CloudMemoryBackup> {
        UUID.fromString(session.userId)
        val body=JSONObject().put("prefix",session.userId+"/").put("limit",10).put("offset",0).put("sortBy",JSONObject().put("column","name").put("order","desc"))
        val array=JSONArray(text(request("storage/v1/object/list/$BUCKET",session.accessToken).post(json(body)).build()))
        require(array.length()<=10)
        return (0 until array.length()).mapNotNull { i ->
            val item=array.getJSONObject(i);val name=item.getString("name")
            if(!name.matches(Regex("[0-9]{13}-[a-f0-9-]{36}\\.zip"))) null else {
                val size=item.optJSONObject("metadata")?.optLong("size",-1) ?: -1
                require(size in -1..MemoryBackupArchive.MAX_BYTES);CloudMemoryBackup(name,size)
            }
        }.sortedByDescending { it.name }
    }
    suspend fun download(backup: CloudMemoryBackup,session: BackupSession,destination: File) {
        val cancellation=currentCoroutineContext()
        try {
            execute(request("storage/v1/object/authenticated/$BUCKET/${path(session.userId,backup.name)}",session.accessToken).get().build()) { response ->
                val body=response.body ?: error("备份内容为空")
                require(body.contentLength()<=MemoryBackupArchive.MAX_BYTES)
                var finished=false
                try {
                cancellation.ensureActive()
                FileOutputStream(destination).use { output -> body.byteStream().use { input ->
                    val bytes=ByteArray(8192);var total=0L
                    while(true) { cancellation.ensureActive();val n=input.read(bytes);if(n<0)break;total+=n;require(total<=MemoryBackupArchive.MAX_BYTES);output.write(bytes,0,n) }
                    require(total>0 && (backup.size<0 || backup.size==total)) { "备份下载不完整" };output.fd.sync()
                } }
                finished=true
                } finally { if(!finished || !cancellation.isActive) destination.delete() }
            }
        } catch(error: Throwable) { destination.delete();throw error }
    }
    suspend fun anonymousReadDenied(backup: CloudMemoryBackup,session: BackupSession): Boolean = try {
        execute(request("storage/v1/object/public/$BUCKET/${path(session.userId,backup.name)}").get().build()) { false }
    } catch(error: BackupApiException) { error.status in setOf(400,401,403,404) }
}
