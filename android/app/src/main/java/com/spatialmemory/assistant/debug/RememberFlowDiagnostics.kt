package com.spatialmemory.assistant.debug

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.backup.MemoryBackupArchive
import com.spatialmemory.assistant.orchestrator.*
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.speech.SpeechCoordinator
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.json.JSONObject

/** Called only by the existing DEBUG + package + private one-use permit gate.
 * All generated frames, databases and files belong to this isolated fixture. */
object RememberFlowDiagnostics {
    suspend fun run(context: Context): JSONObject = withFixture(context) { f ->
        f.start()
        f.core.onUserText("帮我记住这个蓝色水杯，它在书桌左边")
        f.awaitPhoto()
        val cup=f.repo.findObject("蓝色水杯") ?: error("One-phrase memory missing")
        check(f.db.objectMemoryDao().appearances(cup.id).size==1)
        check(f.repo.history(cup.id).single().let { it.location=="书桌左边" && it.source=="USER_STATEMENT" && !it.confirmed })
        check(f.verifier.memoryCalls==1 && f.voice.connects==0);check(f.db.objectMemoryDao().captures(cup.id).size==1)
        f.core.stop()
        f.core.onUserText("记住钥匙在抽屉里")
        val key=f.repo.findObject("钥匙") ?: error("Position-only memory missing")
        check(key.embeddings.isEmpty() && f.repo.history(key.id).single().location=="抽屉里")
        f.db.close();f.db=AppDatabase.open(context,f.dbName)
        check(f.db.objectMemoryDao().all().size==2 && f.db.objectMemoryDao().appearances(cup.id).size==1)
        val targetName="remember-roundtrip-${f.id}.db";val target=AppDatabase.open(context,targetName)
        val account=UUID.randomUUID().toString()
        try {
            MemoryBackupArchive(context,f.db,f.photos,File(f.root,"export")).export(account).use { snapshot ->
                val restored=MemoryBackupArchive(context,target,File(f.root,"restored-photos"),File(f.root,"import")).restore(snapshot.file,account)
                check(restored.restored==2 && target.objectMemoryDao().appearances(cup.id).size==1 && target.objectMemoryDao().appearances(key.id).isEmpty())
                check(target.objectMemoryDao().locations(cup.id).single().source=="USER_STATEMENT");check(target.objectMemoryDao().captures(cup.id).size==1)
            }
        } finally { target.close();context.deleteDatabase(targetName) }
        JSONObject().put("onePhraseAppearanceAndLocation",true).put("targetAndScenePhotos",true).put("positionOnlyWithoutCamera",true)
            .put("reopenPassed",true).put("backupRestoresOnePhotoAndPositionOnlyObjects",true).put("imageApiCallsDuringRemember",f.verifier.calls)
            .put("voiceConnections",f.voice.connects).put("objectsInIsolatedDatabase",2).put("productionMemoryMutated",false)
    }

    internal suspend fun <T> withFixture(context: Context,inputJpeg: ByteArray?=null,block: suspend (Fixture)->T): T = withContext(Dispatchers.Main.immediate) {
        val f=Fixture(context,inputJpeg)
        try { block(f) }
        finally { withContext(NonCancellable) { f.core.stop();f.speech.close();f.scope.cancel();f.db.close();context.deleteDatabase(f.dbName);f.root.deleteRecursively() } }
    }

    internal class Fixture(val context: Context,inputJpeg: ByteArray?=null) {
        val id=UUID.randomUUID().toString();val dbName="remember-flow-$id.db"
        val root=File(context.filesDir,"remember-flow-$id").apply { check(mkdirs()) };val photos=File(root,"photos")
        var db=AppDatabase.open(context,dbName)
        val repo=MemoryRepository(context,db.memoryDao(),db.objectMemoryDao(),photos)
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
        val jpeg=inputJpeg ?: ByteArrayOutputStream().use { output ->
            val image=Bitmap.createBitmap(180,180,Bitmap.Config.ARGB_8888)
            val canvas=Canvas(image);canvas.drawColor(Color.WHITE)
            val paint=Paint().apply { color=Color.BLUE };canvas.drawRect(35f,25f,145f,165f,paint)
            paint.color=Color.BLACK;canvas.drawRect(70f,60f,105f,95f,paint)
            image.compress(Bitmap.CompressFormat.JPEG,90,output);image.recycle();output.toByteArray()
        }
        val source=Source(scope,jpeg);val voice=Voice();val detector=Detector();val verifier=Verifier()
        val speech=SpeechCoordinator(context) {}.apply { setEnabled(false) }
        val core=AssistantOrchestrator(detector,TargetMatcher(context),PerceptionEngine(TargetMatcher(context),HistogramObjectEmbedder()),repo,voice,verifier,speech,File(root,"candidates"),scope)
        suspend fun start() { core.start(source,enableVoice=false) }
        suspend fun awaitPhoto(timeout: Long=6_000) { withTimeout(timeout) { core.state.first { it.searchState==SearchState.IDLE && it.learningSamples==1 && it.rememberedObjectId!=null } } }
    }
    internal class Detector: FrameDetector {
        @Volatile var visible=true
        @Volatile var ambiguous=false
        @Volatile var delayMs=0L
        override fun detect(jpeg: ByteArray,rotationDegrees: Int,threshold: Float): List<Detection> {
            if(delayMs>0) Thread.sleep(delayMs)
            return if(!visible) emptyList() else if(ambiguous)
                listOf(Detection(41,"cup",.96f,Box(20f,25f,85f,160f)),Detection(41,"cup",.96f,Box(95f,25f,160f,160f)))
                else listOf(Detection(41,"cup",.96f,Box(35f,25f,145f,165f)))
        }
    }
    internal class Verifier: ImageVerifier {
        var calls=0;var memoryCalls=0;var findCalls=0
        var memoryDecision=ImageDecision.CONFIRMED
        var memoryLocation: String?="桌面上"
        var memoryBox=listOf(.2f,.1f,.8f,.95f)
        var memoryFailure: Exception?=null
        var memoryDelayMs=0L
        var delegate: ImageVerifier?=null
        var lastRequest: CandidateVerificationRequest?=null
        var lastFindRequest: CandidateVerificationRequest?=null
        var lastMemoryFrame: FramePacket?=null
        var memoryFrameAge=Long.MAX_VALUE
        override suspend fun verify(fullFrame: FramePacket,cropFrame: FramePacket?,request: CandidateVerificationRequest,references: List<ByteArray>): ImageReview {
            calls++;lastRequest=request
            if(request.memoryObservation) {
                memoryCalls++;lastMemoryFrame=fullFrame;memoryFrameAge=System.currentTimeMillis()-fullFrame.capturedAtMs
                delegate?.let { return it.verify(fullFrame,cropFrame,request,references) }
                if(memoryDelayMs>0) delay(memoryDelayMs)
                memoryFailure?.let { throw it }
                if(memoryDecision!=ImageDecision.CONFIRMED) return ImageReview(memoryDecision,null,"isolated unclear object")
                return ImageReview(ImageDecision.CONFIRMED,QwenEvent.TargetVisible(request.taskId,request.candidateId,request.frameId,true,true,"画面中央",memoryLocation,"已观察",.9f),"",
                    MemoryObservation(memoryBox,memoryLocation,if(memoryLocation==null) null else "桌面",if(memoryLocation==null) 0f else .95f))
            }
            findCalls++;lastFindRequest=request
            return ImageReview(ImageDecision.UNCERTAIN,null,"isolated fixture unavailable")
        }
    }
    internal class Voice: QwenRealtimeClient {
        override val state=MutableStateFlow(RealtimeState.DISCONNECTED)
        override val events=MutableSharedFlow<QwenEvent>(extraBufferCapacity=8)
        var connects=0;var connectSuccessfully=false;var taskActive=false
        val texts=mutableListOf<String>()
        val sceneQuestions=mutableListOf<String>()
        var interpreted: com.spatialmemory.assistant.dialogue.DialogueIntent?=null
        var interpretationCalls=0
        var descriptionDelayMs=0L
        override suspend fun interpretUser(text: String,currentTarget: String?,knownNames: List<String>): com.spatialmemory.assistant.dialogue.DialogueIntent? { interpretationCalls++;return interpreted }
        override suspend fun describeScene(frame: FramePacket,target: String?,question: String): SceneDescription {
            sceneQuestions.add(question);if(descriptionDelayMs>0) delay(descriptionDelayMs)
            return SceneDescription(frame.id,true,"蓝色杯身带深色图案","桌面上","桌面",listOf(SceneItem("杯子","蓝色杯身","桌面上")))
        }
        override fun setTaskMode(active: Boolean) { taskActive=active }
        override suspend fun connect() { connects++;if(connectSuccessfully) state.value=RealtimeState.CONNECTED else throw java.io.IOException("isolated voice unavailable") }
        override suspend fun sendFrame(frame: FramePacket,prompt: String)=Unit
        override suspend fun sendText(text: String) { texts.add(text) }
        override fun setMicrophoneEnabled(enabled: Boolean)=Unit
        override suspend fun interrupt()=Unit
        override suspend fun disconnect()=Unit
    }
    internal class Source(private val scope: CoroutineScope,private var jpeg: ByteArray): FrameSource {
        override val source=CameraSource.PHONE
        override val state=MutableStateFlow(FrameSourceState.IDLE)
        override val frames=MutableSharedFlow<FramePacket>(replay=1)
        private var job: Job?=null;var starts=0
        fun changeScene(bytes: ByteArray) { jpeg=bytes }
        override suspend fun start() {
            starts++;state.value=FrameSourceState.RUNNING
            job=scope.launch { var id=0L;while(isActive) { frames.emit(FramePacket(++id,source,System.currentTimeMillis(),jpeg));delay(100) } }
        }
        override suspend fun stop() { job?.cancelAndJoin();state.value=FrameSourceState.STOPPED }
    }
}
