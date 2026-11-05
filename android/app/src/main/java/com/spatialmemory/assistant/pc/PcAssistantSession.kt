package com.spatialmemory.assistant.pc

import android.content.Context
import com.spatialmemory.assistant.backup.*
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.dialogue.*
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.orchestrator.*
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.security.JevKeyStore
import com.spatialmemory.assistant.speech.*
import java.io.IOException
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.*

/** Native capture/ASR/output; PC is the sole task and new-memory authority. */
class PcAssistantSession(
    context: Context,private val db: AppDatabase,private val qwen: QwenRealtimeClient,
    private val speech: SpeechCoordinator,private val scope: CoroutineScope,
    private val localBackup: (String)->Boolean,
    backupNamespace: String="main",jevNamespace: String="main",
    private val conversationId: ()->String = { "default" },private val memoryChanged: ()->Unit={},
) {
    private val app=context.applicationContext
    private val connection=PcConnection(app)
    private val store=BackupSessionStore(app,backupNamespace)
    private val cloud=SupabaseBackupClient(store)
    private val archive=MemoryBackupArchive(app,db)
    private val keyStore=JevKeyStore(app,namespace=jevNamespace,provider=JevProvider.OPENROUTER)
    private val mutex=Mutex()
    private val pending=java.util.concurrent.ConcurrentHashMap<String,CompletableDeferred<JSONObject>>()
    private val mutableState=MutableStateFlow(AssistantState(message="等待连接电脑"))
    private val analyzed=MutableSharedFlow<AnalyzedFrame>(extraBufferCapacity=1)
    val state=mutableState.asStateFlow()
    val analyzedFrames=analyzed.asSharedFlow()
    private var socket: WebSocket?=null
    private var http: OkHttpClient?=null
    private var connected=false
    private var boundConversationId: String?=null
    private var source: FrameSource?=null
    private var sourceJob: Job?=null
    private var uploadJob: Job?=null
    private var qwenJob: Job?=null
    private var voiceJob: Job?=null
    private var latest: FramePacket?=null
    private val sentFrames=linkedMapOf<Long,FramePacket>()
    private var serial=0L
    private var utteranceSerial=0L
    private var serverSerial=0L
    private val spoken=linkedSetOf<String>()
    private val dialogue=FindDialogueEngine()

    companion object {
        fun sensitive(text: String)=text.trim().startsWith("连接电脑")||text.trim().startsWith("iseeyou-pc://")
    }
    private suspend fun rpc(type: String,body: JSONObject=JSONObject(),timeout: Long=60_000): JSONObject {
        val requestId=UUID.randomUUID().toString();val result=CompletableDeferred<JSONObject>();pending[requestId]=result
        try {
            check(socket?.send(body.put("type",type).put("requestId",requestId).toString())==true) { "电脑未连接，请检查电脑服务和同一网络" }
            val reply=withTimeout(timeout) { result.await() }
            check(!reply.has("error")) { message(reply.optString("error")) }
            return reply
        } finally { pending.remove(requestId) }
    }
    private fun message(code: String)=when(code) {
        "fresh_frame_required","stale_frame" -> "还没有新鲜画面，请先开启语音找物并调整镜头"
        "account_conflict","archive_account_invalid" -> "电脑记忆属于另一个备份账号，请检查当前登录账号，原数据仍保留"
        "memory_changed" -> "这件物品记录已变化，本次没有覆盖，请重新打开"
        "backup_login_required" -> "请先登录备份账号"
        "jev_not_configured" -> "Jev 尚未就绪，当时画面仍会保留"
        "capture_limit" -> "这件物品的画面记录已达到本版上限，原记录仍保留"
        "client_operation_failed","client_response_timeout" -> "这次请求未完成，已保存的物品记录仍保留，请重试。"
        else -> "这次没有完成，请再试一次。"
    }
    private fun sessionJson(s: BackupSession)=JSONObject().put("userId",s.userId).put("accessToken",s.accessToken).put("refreshToken",s.refreshToken).put("expiresAtMs",s.expiresAtMs)
    suspend fun connect()=mutex.withLock {
        if(connected) {
            if(boundConversationId!=conversationId())resetConversation()
            return@withLock
        }
        val profile=connection.read() ?: error("请先在对话记录输入“连接电脑 ”并粘贴电脑生成的连接地址")
        http=profile.http();val opened=CompletableDeferred<Unit>();serverSerial=0;spoken.clear()
        socket=http!!.newWebSocket(Request.Builder().url(profile.origin+"/v1/session").header("Authorization","Bearer "+profile.token).build(),object: WebSocketListener() {
            override fun onOpen(webSocket: WebSocket,response: Response) { opened.complete(Unit) }
            override fun onMessage(webSocket: WebSocket,text: String) {
                scope.launch { if(socket===webSocket)runCatching { receive(JSONObject(text)) }.onFailure { mutableState.value=mutableState.value.copy(error="电脑返回内容未完成") } }
            }
            override fun onFailure(webSocket: WebSocket,t: Throwable,response: Response?) { opened.completeExceptionally(IOException("电脑连接未完成，请确认电脑服务已启动且处于同一网络"));if(socket===webSocket)disconnected() }
            override fun onClosed(webSocket: WebSocket,code: Int,reason: String) { if(socket===webSocket)disconnected() }
        })
        try {
            withTimeout(10_000) { opened.await() }
            val session=if(store.session()!=null)cloud.session() else null
            val hello=JSONObject().put("session",session?.let(::sessionJson) ?: JSONObject.NULL).put("conversationId",conversationId())
            if(keyStore.isVerified())hello.put("openrouterKey",keyStore.read())
            val capabilities=rpc("hello",hello).getJSONObject("result")
            check(capabilities.optBoolean("conversationSessions")) { "请更新电脑服务后再连接，本版需要独立会话支持" }
            if(session!=null)withContext(Dispatchers.IO) {
                archive.export(session.userId).use { snapshot ->
                    val response=http!!.newCall(Request.Builder().url(profile.origin+"/v1/import").header("Authorization","Bearer "+profile.token).post(snapshot.file.asRequestBody("application/zip".toMediaType())).build()).execute()
                    response.use { check(it.isSuccessful) { "旧记忆导入电脑尚未完成，平板原数据完整保留" } }
                }
            }
            connected=true;boundConversationId=conversationId();mutableState.value=mutableState.value.copy(error=null,message="电脑已连接，记忆由电脑统一保存")
        } catch(error: Throwable) { socket?.cancel();socket=null;connected=false;throw error }
    }
    private fun disconnected() {
        connected=false
        pending.values.forEach { it.completeExceptionally(IOException("电脑连接中断，已保存的数据仍保留")) };pending.clear()
        if(mutableState.value.running)scope.launch { cleanupCapture();mutableState.value=mutableState.value.copy(running=false,voiceRequested=false,error="电脑连接中断，请恢复连接后重新开始",message="观察已停止");speech.reset() }
    }
    private suspend fun receive(m: JSONObject) {
        when(m.optString("type")) {
            "result" -> pending[m.optString("requestId")]?.complete(m)
            "speech.clear" -> { serverSerial=maxOf(serverSerial,m.optLong("serial"));speech.reset() }
            "reply" -> {
                val current=m.optLong("serial");val event=m.getString("eventId")
                if(current<serverSerial||!spoken.add(event))return
                serverSerial=current;while(spoken.size>128)spoken.remove(spoken.first())
                val words=m.getString("message");mutableState.value=mutableState.value.copy(lastSpeech=words,message=words,rememberedObjectId=m.optString("objectId").takeUnless { it.isBlank()||it=="null" })
                speech.announce(SpeechEvent("pc-$event",words,SpeechPriority.P1))
            }
            "state" -> mutableState.value=mutableState.value.copy(searchState=runCatching { SearchState.valueOf(m.optString("state","IDLE")) }.getOrDefault(SearchState.IDLE),target=m.optString("target").takeUnless { it.isBlank()||it=="null" },rememberedObjectId=m.optString("objectId").takeUnless { it.isBlank()||it=="null" },message=m.optString("message"),objectChoices=emptyList())
            "choices" -> {
                val choices=m.getJSONArray("items");mutableState.value=mutableState.value.copy(objectChoices=(0 until choices.length()).map { val o=choices.getJSONObject(it);MemoryChoice(o.getString("id"),o.getString("name"),o.getString("detail")) })
            }
            "memory.changed" -> memoryChanged()
            "detections" -> {
                val frame=sentFrames[m.optLong("clientFrameId")] ?: return
                val array=m.getJSONArray("detections");val detections=(0 until array.length()).map { val o=array.getJSONObject(it);val b=o.getJSONArray("box");Detection(0,o.getString("label"),o.getDouble("score").toFloat(),Box(b.getDouble(0).toFloat(),b.getDouble(1).toFloat(),b.getDouble(2).toFloat(),b.getDouble(3).toFloat())) }
                mutableState.value=mutableState.value.copy(frameId=frame.id,detections=detections,yoloLatencyMs=m.optDouble("inferenceMs").toLong())
                analyzed.tryEmit(AnalyzedFrame(frame,detections))
            }
            "client.request" -> scope.launch {
                val requestId=m.getString("requestId");val data=m.getJSONObject("data")
                val result=runCatching {
                    when(m.getString("operation")) {
                        "session.updated" -> {
                            val old=store.session() ?: error("Backup signed out")
                            require(data.getString("userId")==old.userId)
                            store.save(BackupSession(old.userId,data.getString("accessToken"),data.getString("refreshToken"),data.getLong("expiresAtMs")));JSONObject().put("ok",true)
                        }
                        "intent" -> {
                            val names=data.getJSONArray("names");val intent=withTimeoutOrNull(3000) { qwen.interpretUser(data.getString("raw"),data.optString("focus").takeUnless { it=="null"||it.isBlank() },(0 until names.length()).map { names.getString(it) }) }
                            intent?.let(::encodeIntent) ?: JSONObject.NULL
                        }
                        else -> error("Unknown PC request")
                    }
                }
                val reply=JSONObject().put("type","client.result").put("requestId",requestId)
                if(result.isSuccess)reply.put("result",result.getOrNull()) else reply.put("error","client_operation_failed")
                socket?.send(reply.toString())
            }
        }
    }
    suspend fun maintenance(raw: String): Boolean {
        val clean=raw.trim()
        if(sensitive(clean)) {
            val address=clean.removePrefix("连接电脑").trim();PcProfile.parse(address);stop();connection.save(address);connect();localReply("电脑已连接，原平板记忆已保留，今后的新记忆由电脑统一保存。");return true
        }
        if(MemoryBackupCoordinator.sensitive(clean)||clean in setOf("退出备份","取消备份登录")) {
            if(clean=="退出备份"&&connected)rpc("session.clear")
            return localBackup(clean)
        }
        val operation=when(clean.trimEnd('。','！','!','？','?')) { "备份记忆","备份我的记忆" -> "backup";"恢复记忆","恢复我的记忆" -> "restore";"备份状态" -> "backup.status";else -> return false }
        connect();store.session()?.let { rpc("session.refresh",JSONObject().put("session",sessionJson(cloud.session()))) }
        val r=rpc(operation)
        if(operation=="backup.status") { val v=r.getJSONObject("result");localReply(if(!v.optBoolean("loggedIn"))"备份账号尚未登录，电脑本地记忆仍保留" else if(v.optLong("lastSuccess")==0L)"备份账号已登录，电脑本次运行尚无成功上传记录" else "电脑记忆最近备份成功，已下载核对") }
        return true
    }
    private fun localReply(words: String) { mutableState.value=mutableState.value.copy(lastSpeech=words,message=words);speech.announce(SpeechEvent("pc-local-${System.nanoTime()}",words,SpeechPriority.P1)) }
    /** Host may stage one pairing address in this app's private directory via adb run-as. */
    suspend fun consumePreparedConnection(): Boolean {
        if(!com.spatialmemory.assistant.BuildConfig.DEBUG)return false
        val prepared=java.io.File(app.filesDir,"pc-pair.once")
        if(!prepared.isFile)return false
        require(prepared.length() in 1..600)
        val raw=prepared.readText(Charsets.UTF_8);PcProfile.parse(raw);connection.save(raw)
        check(prepared.delete())
        connect();localReply("电脑已连接，已有记忆已保留。尚未开启相机和麦克风。")
        return true
    }
    suspend fun connectIfConfigured() { if(connection.read()!=null)connect() }
    suspend fun resetConversation() {
        cleanupCapture()
        speech.reset()
        try {
            if(connected)rpc("conversation.reset",JSONObject().put("conversationId",conversationId()))
            boundConversationId=conversationId()
        } catch(error: Exception) {
            socket?.cancel();socket=null;connected=false
            if(error is CancellationException)throw error
        }
        mutableState.value=AssistantState(message="新会话已开始")
    }
    suspend fun submitText(text: String) {
        val turn=++utteranceSerial
        try { if(maintenance(text))return;connect();rpc("command",JSONObject().put("async",true).put("command",JSONObject().put("commandId",UUID.randomUUID().toString()).put("text",text))) }
        catch(error: CancellationException) { throw error }
        catch(error: Exception) { if(turn==utteranceSerial)localReply(if(connected)"这次没有完成，请再试一次。" else "连接中断了，请稍后再试。") }
    }
    private suspend fun command(action: String,target: String?=null,objectId: String?=null,index: Int?=null) { connect();rpc("command",JSONObject().put("async",true).put("command",JSONObject().put("commandId",UUID.randomUUID().toString()).put("action",action).put("target",target).put("objectId",objectId).apply { if(index!=null)put("index",index) })) }
    suspend fun search(target: String,objectId: String?=null)=command("find",target,objectId)
    suspend fun remember(target: String,objectId: String?=null)=command("remember",target,objectId)
    suspend fun selectObject(id: String) { val index=state.value.objectChoices.indexOfFirst { it.id==id };require(index>=0);command("select",index=index) }
    fun finishSearch() { scope.launch { runCatching { command("complete") } } }
    fun cancelSearch() { scope.launch { runCatching { command("cancel") } } }
    fun requiresCamera(text: String)=PcCameraPolicy.requiresCamera(text) ?: when(dialogue.intent(text,state.value.target)) { is DialogueIntent.StartSearch,is DialogueIntent.RememberObject,is DialogueIntent.RememberCurrentLocation,is DialogueIntent.RecordLocation,is DialogueIntent.DescribeScene -> true;else -> false }
    suspend fun start(frameSource: FrameSource,enableVoice: Boolean=true) {
        stop();connect();val mySerial=++serial
        val generation=rpc("start",JSONObject().put("source",frameSource.source.name)).getJSONObject("result").getString("generation")
        source=frameSource;sourceJob=scope.launch { frameSource.frames.collect { frame -> latest=frame;analyzed.tryEmit(AnalyzedFrame(frame,emptyList())) } }
        frameSource.start();mutableState.value=AssistantState(running=true,voiceRequested=enableVoice,source=frameSource.source,message="电脑处理已连接，正在接收画面")
        uploadJob=scope.launch {
            var lastId=-1L
            while(isActive&&mySerial==serial) {
                val frame=latest
                if(frame!=null&&frame.id!=lastId&&System.currentTimeMillis()-frame.capturedAtMs in 0..1500) {
                    try {
                        val jpeg=withContext(Dispatchers.Default) { JevReviewImages.prepare(frame.jpeg,frame.rotationDegrees,720) }
                        if(jpeg.size<=190*1024) {
                            sentFrames[frame.id]=frame.copy(jpeg=jpeg,rotationDegrees=0);while(sentFrames.size>12)sentFrames.remove(sentFrames.keys.first())
                            rpc("frame",JSONObject().put("generation",generation).put("sequence",frame.id).put("capturedAtMs",frame.capturedAtMs).put("ageMs",System.currentTimeMillis()-frame.capturedAtMs).put("jpeg",Base64.getEncoder().encodeToString(jpeg)),8000)
                            mutableState.value=mutableState.value.copy(frameId=frame.id,frameAgeMs=System.currentTimeMillis()-frame.capturedAtMs)
                            lastId=frame.id
                        }
                    } catch(error: Exception) { if(error is CancellationException)throw error;mutableState.value=mutableState.value.copy(error=error.message) }
                }
                delay(300)
            }
        }
        if(enableVoice) {
            qwen.setTaskMode(true)
            qwenJob=scope.launch { qwen.events.collect { event -> if(event is QwenEvent.Transcript&&event.role=="user"&&mySerial==serial)scope.launch { runCatching { submitText(event.text) }.onFailure { if(mySerial==serial)localReply(it.message?:"本次指令未完成") } } } }
            voiceJob=scope.launch {
                try { qwen.connect() }
                catch(error: CancellationException) { throw error }
                catch(error: Exception) { if(mySerial==serial&&mutableState.value.running)mutableState.value=mutableState.value.copy(error="千问语音暂不可用，可在对话记录输入指令") }
            }
        }
    }
    private suspend fun cleanupCapture() { serial++;utteranceSerial++;sourceJob?.cancel();uploadJob?.cancel();qwenJob?.cancel();voiceJob?.cancel();sourceJob=null;uploadJob=null;qwenJob=null;voiceJob=null;source?.stop();source=null;latest=null;sentFrames.clear();qwen.disconnect() }
    suspend fun stop() { cleanupCapture();if(connected)runCatching { rpc("stop",timeout=3000) };socket?.close(1000,"foreground_ended");socket=null;connected=false;mutableState.value=mutableState.value.copy(running=false,voiceRequested=false,target=null,searchState=SearchState.IDLE,objectChoices=emptyList());speech.reset() }
    suspend fun records(): JSONArray { connect();return rpc("records").getJSONArray("result") }
    suspend fun history(id: String): List<LocationObservationEntity> { connect();val a=rpc("history",JSONObject().put("objectId",id)).getJSONArray("result");return (0 until a.length()).map { val o=a.getJSONObject(it);LocationObservationEntity(o.getString("id"),id,o.optString("placeId").takeUnless { it=="null"||it.isBlank() },o.getString("location"),o.getString("anchor"),if(o.isNull("observedAtMs"))null else o.getLong("observedAtMs"),o.getBoolean("confirmed"),o.getLong("recordedAtMs"),o.getString("source")) } }
    suspend fun edit(item: JSONObject) { connect();rpc("edit",JSONObject().put("item",item)) }
    suspend fun delete(item: JSONObject) { connect();rpc("delete",JSONObject().put("item",item)) }
    private fun encodeIntent(intent: DialogueIntent): JSONObject=when(intent) {
        is DialogueIntent.StartSearch -> JSONObject().put("action","find").put("target",intent.target)
        is DialogueIntent.RememberObject -> JSONObject().put("action","remember").put("target",intent.target).put("newIdentity",intent.newIdentity)
        is DialogueIntent.RememberCurrentLocation -> JSONObject().put("action","remember").put("target",intent.target)
        is DialogueIntent.RecordLocation -> JSONObject().put("action","remember").put("target",intent.target).put("location",intent.location).put("newIdentity",intent.newIdentity)
        is DialogueIntent.RecallLocation -> JSONObject().put("action","history").put("target",intent.target)
        is DialogueIntent.CheckMemory -> JSONObject().put("action","check").put("target",intent.target)
        is DialogueIntent.RecallAppearance -> JSONObject().put("action","appearance").put("target",intent.target)
        is DialogueIntent.DescribeScene -> JSONObject().put("action","describe").put("question",intent.question)
        is DialogueIntent.SelectObject -> JSONObject().put("action","select").put("index",intent.index)
        is DialogueIntent.ContinueSearch -> JSONObject().put("action","continue")
        is DialogueIntent.CompleteSearch -> JSONObject().put("action","complete")
        is DialogueIntent.Cancel -> JSONObject().put("action","cancel")
        is DialogueIntent.LocationHint -> JSONObject().put("action","hint")
    }
}
