package com.spatialmemory.assistant.orchestrator

import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.dialogue.DialogueIntent
import com.spatialmemory.assistant.dialogue.FindDialogueEngine
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.memory.AppearanceSample
import com.spatialmemory.assistant.memory.MemoryRepository
import com.spatialmemory.assistant.memory.ObjectMemory
import com.spatialmemory.assistant.memory.locationSourceLabel
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.speech.SpeechCoordinator
import com.spatialmemory.assistant.speech.SpeechEvent
import com.spatialmemory.assistant.speech.SpeechPriority
import com.spatialmemory.assistant.task.FindStatus
import com.spatialmemory.assistant.task.FindTaskEngine
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first

class AssistantOrchestrator(
    private val detector: FrameDetector,
    private val matcher: TargetMatcher,
    private val perception: PerceptionEngine,
    private val memory: MemoryRepository,
    private val qwen: QwenRealtimeClient,
    private val imageVerifier: ImageVerifier,
    private val speech: SpeechCoordinator,
    private val candidateDirectory: File,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    private val memoryCommand: (String) -> Boolean = { false },
) {
    private val mutableState = MutableStateFlow(AssistantState())
    private val mutableAnalyzedFrames = MutableSharedFlow<AnalyzedFrame>(extraBufferCapacity = 1)
    private val router = FrameRouter()
    private val dialogue = FindDialogueEngine()
    private val guard = GenerationGuard()
    private val taskEngine = FindTaskEngine()
    private var source: FrameSource? = null
    private var sourceJob: Job? = null
    private var processingJob: Job? = null
    private var qwenJob: Job? = null
    private var qwenConnectJob: Job? = null
    private var qwenReconnectJob: Job? = null
    private val voiceRecovery = VoiceRecoveryGate()
    private var qwenFrameJob: Job? = null
    private var frameWatchdogJob: Job? = null
    private var sourceStateJob: Job? = null
    private var verificationTimeoutJob: Job? = null
    private var verificationJob: Job? = null
    private var inputSerial=0L
    private var conversationJob: Job?=null
    private var pendingSnapshot: FramePacket?=null
    private var learningCaptureId: String?=null
    private var routeToken = 0L
    private var gate = StableCandidateGate()
    private val sceneChangeGate = SceneChangeGate()
    private var lastQwenFrameAt = 0L
    private var activeMemory: ObjectMemory? = null
    private var learningView: LearningView? = null
    private var learningSignature: IntArray? = null
    private var learningStableSince = 0L
    private var learningSaving = false
    private var learningTimeoutJob: Job? = null
    private var learningLocation: String? = null
    private var learningNeedsPosition = false
    private var rejectedBox: Box? = null
    private var pendingCandidateBox: Box? = null
    private var rejectedAt = 0L
    private var qwenRequestAt = 0L
    private var lastReviewFinishedAt = 0L
    private var learningReplacement: ObjectMemory? = null
    private var pendingChoice: DialogueIntent? = null
    private var pendingPositionId: String? = null
    private var lastVerifiedFrame: FramePacket? = null
    private var lastVerifiedResult: QwenEvent.TargetVisible? = null
    private var lastVerifiedRegion: List<Float>? = null
    private var lastVerifiedDifferenceLimit = 3f

    val state = mutableState.asStateFlow()
    val analyzedFrames = mutableAnalyzedFrames.asSharedFlow()

    suspend fun start(frameSource: FrameSource, enableVoice: Boolean = true) {
        stop()
        val generation = guard.next()
        source = frameSource
        routeToken = router.switchTo(frameSource.source)
        try {
            frameSource.start()
            mutableState.value = AssistantState(
                running = true,
                voiceRequested = enableVoice,
                source = frameSource.source,
                message = if (enableVoice) "画面已启动，语音连接中" else "画面已启动，可输入找物指令",
            )
            qwenConnectJob = if (!enableVoice) null else scope.launch {
                runCatching { qwen.connect() }
                    .onSuccess {
                        if (guard.valid(generation)) mutableState.value = mutableState.value.copy(message = if (mutableState.value.target == null) "本地识别与语音已启动" else mutableState.value.message, error = null)
                    }
                    .onFailure {
                        if (guard.valid(generation)) mutableState.value = mutableState.value.copy(error = "千问连接失败：${it.message}；图片复核和文字指令仍可使用", message = if (mutableState.value.target == null) "画面已启动，语音暂不可用" else mutableState.value.message)
                    }
            }
            sourceStateJob = scope.launch {
                frameSource.state.collect { sourceState ->
                    if (sourceState == FrameSourceState.FAILED && guard.valid(generation)) {
                        mutableState.value = mutableState.value.copy(
                            error = if (frameSource.source == CameraSource.PHONE) "手机相机帧转换失败" else "ESP32 视频流连接失败",
                            message = "视频源已停止",
                        )
                    }
                }
            }
            frameWatchdogJob = scope.launch {
                delay(5_000)
                if (guard.valid(generation) && mutableState.value.frameId == null) {
                    mutableState.value = mutableState.value.copy(
                        error = if (frameSource.source == CameraSource.PHONE) "5 秒内没有收到手机相机帧，请检查相机权限" else "5 秒内没有收到 ESP32 视频帧，请检查视频流地址和设备网络",
                        message = "视频流未到达",
                    )
                }
            }
            sourceJob = scope.launch { frameSource.frames.collect { router.offer(it, routeToken) } }
            qwenFrameJob = scope.launch {
                router.frame.collect { frame ->
                    if (frame == null || !guard.valid(generation) || qwen.state.value != RealtimeState.CONNECTED) return@collect
                    val now = System.currentTimeMillis()
                    if (now - lastQwenFrameAt >= 1_000) {
                        qwen.sendFrame(frame, "")
                        lastQwenFrameAt = now
                    }
                }
            }
            processingJob = scope.launch { processFrames(generation) }
            qwenJob = scope.launch { collectQwen(generation) }
        } catch (error: Throwable) {
            frameSource.stop()
            qwen.disconnect()
            router.stop()
            mutableState.value = AssistantState(error = error.message, message = "启动失败")
            throw error
        }
    }

    private suspend fun processFrames(generation: Long) {
        try {
            if (!guard.valid(generation)) return
            router.frame.collect { frame ->
                if (frame == null || !guard.valid(generation)) return@collect
                mutableState.value = mutableState.value.copy(frameId = frame.id, frameAgeMs = System.currentTimeMillis() - frame.capturedAtMs, message = mutableState.value.messageWhileProcessing(frame.id))
                val yoloStarted = System.currentTimeMillis()
                val detections = withContext(Dispatchers.Default) { detector.detect(frame.jpeg, frame.rotationDegrees) }
                val yoloLatency = System.currentTimeMillis() - yoloStarted
                if (!guard.valid(generation)) return@collect
                val current = mutableState.value
                mutableState.value = current.copy(
                    frameId = frame.id,
                    frameAgeMs = System.currentTimeMillis() - frame.capturedAtMs,
                    detections = detections,
                    yoloLatencyMs = yoloLatency,
                    message = if (current.target == null) "YOLO 运行中：本帧检测到 ${detections.size} 个目标" else current.message,
                )
                mutableAnalyzedFrames.tryEmit(AnalyzedFrame(frame, detections))
                when (taskEngine.task?.status) {
                    FindStatus.LEARNING -> Unit // enrollment snapshots do not wait for YOLO
                    FindStatus.WATCHING -> analyzeSearchFrame(frame, detections)
                    FindStatus.ANNOUNCED -> expireGuidanceIfChanged(frame)
                    else -> Unit
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            android.util.Log.e("AssistantOrchestrator", "Local frame processing failed", error)
            mutableState.value = mutableState.value.copy(error = error.message ?: error.javaClass.simpleName, message = "识别已停止")
        }
    }

    /** Persist the scene first; appearance and verified position are independent refinements. */
    private suspend fun captureMemory(taskId: String,target: String,replacement: ObjectMemory?,locationAlreadySaved: String?,capturePosition: Boolean,snapshot: FramePacket?,replySerial: Long,allowed: ()->Boolean) {
        var receipt: SceneReceipt?=null
        try {
            val frame=snapshot ?: withTimeout(4_000) {
                router.frame.filterNotNull().first { System.currentTimeMillis()-it.capturedAtMs in 0..2_000 && source?.state?.value==FrameSourceState.RUNNING }
            }
            if(!allowed()) return
            val scene=withContext(Dispatchers.Default) { perception.sceneJpeg(frame) }
            receipt=memory.captureScene(target,scene,frame.id,frame.source.name,frame.capturedAtMs,replacement?.id,replacement?.revision,captureId=taskId,allowed=allowed)
            learningCaptureId=receipt.capture.id
            activeMemory=memory.byId(receipt.capture.objectId)
            mutableState.value=mutableState.value.copy(rememberedObjectId=receipt.capture.objectId,qwenVerifying=true,message="当时画面已保存，正在分别分析外观和位置")
            if(replySerial==inputSerial) announce("当时画面已保存，正在分析${target}的外观"+if(capturePosition) "和位置" else "")
            val request=CandidateVerificationRequest(taskId,UUID.randomUUID().toString(),frame.id,target,replacement?.semanticDescription,"memory",0f,listOf(0f,0f,1f,1f),memoryObservation=true)
            val pair=coroutineScope {
                val words=async {
                    try { withTimeout(12_000) { qwen.describeScene(frame,target,"描述这件物品的外观和画面内位置，不能宣称保存") } }
                    catch(error: CancellationException) { if(error !is TimeoutCancellationException) throw error;null }
                    catch(error: Exception) { null }
                }
                val pixels=async {
                    try { withTimeout(15_000) { imageVerifier.verify(frame,null,request,emptyList()) } }
                    catch(error: CancellationException) { if(error !is TimeoutCancellationException) throw error;ImageReview(ImageDecision.UNCERTAIN,null,"TIMEOUT") }
                    catch(error: JevDirectException) { ImageReview(ImageDecision.UNCERTAIN,null,"HTTP_${error.httpStatus}") }
                    catch(error: Exception) { ImageReview(ImageDecision.UNCERTAIN,null,"NETWORK_ERROR") }
                }
                words.await() to pixels.await()
            }
            if(!allowed()) return
            val description=pair.first?.takeIf { it.frameId==frame.id && it.targetVisible }
            val review=pair.second;val observation=review.observation
            var kind=observation?.failureKind?.takeIf { it.isNotBlank() } ?: review.reason.takeIf { it.matches(Regex("[A-Z0-9_]{1,80}")) } ?: if(observation==null) "REVIEW_UNAVAILABLE" else ""
            var photo: AppearanceSample?=null
            if(observation?.targetVisible==true && observation.appearanceClear && observation.normalizedBox.size==4) {
                try {
                    val view=withContext(Dispatchers.Default) { perception.observedView(frame,observation.normalizedBox) }
                    photo=AppearanceSample(view.targetJpeg,view.embedding,frame.capturedAtMs)
                } catch(error: Exception) { if(error is CancellationException) throw error;kind="CROP_UNAVAILABLE" }
            }
            val place=if(capturePosition && locationAlreadySaved==null && observation?.targetVisible==true && observation.locationConfidence.isFinite() && observation.locationConfidence>=.8f && !observation.location.isNullOrBlank())
                ObservedLocation(observation.location,observation.anchor.orEmpty(),frame.capturedAtMs) else null
            android.util.Log.i("MemoryFlow","frame=${frame.id} reason=$kind visible=${observation?.visibilityConfidence} clarity=${observation?.clarityConfidence} box=${observation?.boxConfidence} photo=${photo!=null} location=${place!=null}")
            val finished=try { memory.finishCapturedScene(receipt,photo,description?.description?.takeIf { it.isNotBlank() },description?.location,place,kind,allowed) }
            catch(error: java.io.IOException) {
                // A failed target-photo write must not lose the existing scene or a verified place.
                if(photo==null) throw error
                photo=null;memory.finishCapturedScene(receipt,null,description?.description,description?.location,place,"PHOTO_WRITE_FAILED",allowed)
            }
            receipt=finished
            if(!allowed()) return
            activeMemory=memory.byId(finished.capture.objectId);taskEngine.clear();qwen.setTaskMode(false)
            val text=when {
                photo!=null && locationAlreadySaved!=null -> "已记住${target}的外观和你提供的位置：$locationAlreadySaved"
                photo!=null && place!=null -> "已记住${target}的外观和位置，刚才看到它在${place.location}"
                place!=null -> "当时画面和${target}的位置已保存：${place.location}；目标照片暂未提取出来"
                photo!=null && capturePosition -> "已保存${target}的外观和当时画面，具体位置仍待确认"
                photo!=null -> "已保存${target}的外观和当时画面，原有位置历史保留"
                locationAlreadySaved!=null -> "你提供的位置已保留，当时画面也已保存；${target}的外观仍待确认"
                else -> "当时画面已保存，但${target}的外观和位置还未确认。"+reviewFailureLabel(kind)
            }
            if(replySerial==inputSerial) announce(text)
            mutableState.value=mutableState.value.copy(target=null,searchId=null,searchState=SearchState.IDLE,qwenVerifying=false,rememberedObjectId=finished.capture.objectId,learningSamples=if(photo==null) 0 else 1,message=if(replySerial==inputSerial) text else mutableState.value.message,notice=if(replySerial==inputSerial) text else mutableState.value.notice)
        } finally {
            withContext(NonCancellable) {
                val saved=receipt?.capture ?: memory.capture(taskId)
                if(saved!=null) {
                    if(allowed()) { learningCaptureId=saved.id;mutableState.value=mutableState.value.copy(rememberedObjectId=saved.objectId) }
                    memory.markCapturePending(saved.id,if(allowed()) "ANALYSIS_INCOMPLETE" else "CANCELLED")
                }
            }
        }
    }

    private fun reviewFailureLabel(kind: String)=when {
        kind.startsWith("HTTP_") -> "图片服务本次未完成请求。"
        kind=="NETWORK_ERROR" || kind=="TIMEOUT" -> "图片分析连接未完成。"
        kind=="PROTOCOL_INVALID" -> "图片服务返回不完整，已保留画面。"
        kind=="TARGET_UNCERTAIN" -> "图片分析还不能确定目标。"
        else -> "已保留画面，可以之后再确认。"
    }

    private fun learningFailed(text: String) {
        taskEngine.clear();learningTimeoutJob?.cancel();learningView=null;learningSignature=null;qwen.setTaskMode(false)
        val message=if(learningCaptureId!=null) "当时画面已保存，外观和位置的分析暂未完成" else text
        announce(message)
        mutableState.value=mutableState.value.copy(target=null,searchId=null,searchState=SearchState.IDLE,qwenVerifying=false,learningSamples=0,message=message,lastSpeech=message)
    }

    private suspend fun analyzeSearchFrame(frame: FramePacket, detections: List<Detection>) {
        val task = taskEngine.task ?: return
        if (System.currentTimeMillis() - lastReviewFinishedAt < 2_500) return
        val target = activeMemory?.name ?: task.targetName
        if (!matcher.supports(target)) {
            inspectUnsupportedTarget(frame, task.id, task.targetName)
            return
        }
        val embeddingStarted = System.currentTimeMillis()
        val candidates = withContext(Dispatchers.Default) {
            perception.candidates(frame, task.id, target, detections, activeMemory?.embeddings.orEmpty())
        }
        val embeddingLatency = System.currentTimeMillis() - embeddingStarted
        val stable = gate.offer(candidates)
        mutableState.value = mutableState.value.copy(embeddingLatencyMs = embeddingLatency)
        if (stable == null) return
        val rejected = rejectedBox
        if (rejected != null && System.currentTimeMillis() - rejectedAt < 10_000 && rejected.iou(stable.box) >= 0.5f) return
        if (taskEngine.candidate(stable) == null) return
        candidateDirectory.mkdirs()
        File(candidateDirectory, "${stable.id}-full.jpg").writeBytes(frame.jpeg)
        File(candidateDirectory, "${stable.id}-crop.jpg").writeBytes(stable.cropJpeg)
        val localText = "发现疑似${task.targetName}，请保持画面稳定，正在独立复核图片"
        pendingCandidateBox = stable.box
        speech.announce(SpeechEvent("${task.id}:${stable.id}:candidate", localText, SpeechPriority.P2))
        mutableState.value = mutableState.value.copy(
            searchState = SearchState.VERIFYING,
            candidateScore = stable.combinedScore,
            appearanceSimilarity = stable.appearanceSimilarity,
            qwenVerifying = true,
            message = localText,
            lastSpeech = localText,
        )
        verificationJob = scope.launch { verifyCandidate(stable, task.targetName, activeMemory?.semanticDescription) }
    }

    private suspend fun verifyCandidate(candidate: ObjectCandidate, target: String, description: String?) {
        val box = candidate.box
        val request = CandidateVerificationRequest(candidate.taskId, candidate.id, candidate.frameId, target, description, candidate.label, candidate.yoloConfidence,
            listOf(box.left / candidate.frameWidth, box.top / candidate.frameHeight, box.right / candidate.frameWidth, box.bottom / candidate.frameHeight), !activeMemory?.embeddings.isNullOrEmpty())
        mutableState.value = mutableState.value.copy(candidateBox = request.normalizedBox, verifiedAtMs = 0)
        runImageReview(candidate.frame, candidate.frame.copy(jpeg = candidate.cropJpeg, rotationDegrees = 0), request, activeMemory)
    }

    private suspend fun inspectUnsupportedTarget(frame: FramePacket, taskId: String, target: String) {
        if (!sceneChangeGate.offer(frame.jpeg, System.currentTimeMillis())) return
        val request = CandidateVerificationRequest(taskId, UUID.randomUUID().toString(), frame.id, target, activeMemory?.semanticDescription, "semantic", 0f, listOf(0f, 0f, 1f, 1f), !activeMemory?.embeddings.isNullOrEmpty())
        if (!taskEngine.semanticCandidate(request.candidateId, frame.id)) return
        mutableState.value = mutableState.value.copy(searchState = SearchState.VERIFYING, qwenVerifying = true, message = "请保持画面稳定，正在独立复核当前画面")
        val selected = activeMemory
        verificationJob = scope.launch { runImageReview(frame, null, request, selected) }
    }

    private suspend fun runImageReview(frame: FramePacket, crop: FramePacket?, request: CandidateVerificationRequest, selected: ObjectMemory?) {
        val generation = guard.current()
        qwenRequestAt = System.currentTimeMillis()
        try {
            val references = selected?.let { memory.referenceImages(it.id, it.revision) }.orEmpty()
            val review = withTimeout(15_000) { imageVerifier.verify(frame, crop, request, references) }
            currentCoroutineContext().ensureActive()
            if (!guard.valid(generation) || taskEngine.task?.id != request.taskId || taskEngine.task?.status != FindStatus.CANDIDATE) return
            val latest = router.frame.value
            val region = request.normalizedBox.takeUnless { request.label == "semantic" }
            val difference = withContext(Dispatchers.Default) {
                val first = sceneChangeGate.signature(frame.jpeg, frame.rotationDegrees)
                val second = latest?.let { sceneChangeGate.signature(it.jpeg, it.rotationDegrees) }
                val candidateFirst = sceneChangeGate.signature(frame.jpeg, frame.rotationDegrees, region)
                val candidateNow = latest?.let { sceneChangeGate.signature(it.jpeg, it.rotationDegrees, region) }
                val limit = if (region == null) 3f else 12f
                if (first == null || second == null || candidateFirst == null || candidateNow == null || SceneChangeGate.meanDifference(candidateFirst, candidateNow) >= limit) Float.POSITIVE_INFINITY
                else SceneChangeGate.meanDifference(first, second)
            }
            val now = System.currentTimeMillis()
            val fresh = EvidenceFreshness.accepts(frame.capturedAtMs, now,
                source?.state?.value == FrameSourceState.RUNNING && latest != null && latest.source == frame.source && latest.rotationDegrees == frame.rotationDegrees && now - latest.capturedAtMs in 0..2_000,
                taskEngine.task?.id == request.taskId && guard.valid(generation), selected == null || memory.currentRevision(selected.id) == selected.revision, difference)
            if (!fresh) {
                reviewFailed(request.taskId, "画面或物品记录已变化，请重新扫描")
                return
            }
            val event = review.result
            if (review.decision != ImageDecision.CONFIRMED || event == null) {
                if (review.decision == ImageDecision.REJECTED) { rejectedBox = pendingCandidateBox; rejectedAt = now }
                reviewFailed(request.taskId, if (review.decision == ImageDecision.REJECTED) "图片复核未找到目标，请继续扫描" else "图片还不能确定是这件物品，请换个角度")
                return
            }
            val verified = taskEngine.verification(event) ?: return
            lastVerifiedFrame = latest ?: frame
            lastVerifiedRegion = region
            lastVerifiedDifferenceLimit = if (region == null) 3f else 12f
            lastVerifiedResult = event
            pendingCandidateBox = null
            announce(verified.text)
            mutableState.value = mutableState.value.copy(searchState = SearchState.GUIDING, qwenVerifying = false, qwenLatencyMs = now - qwenRequestAt, verifiedAtMs = now, message = "已确认：${verified.text}", lastSpeech = verified.text)
            if (selected != null && pendingPositionId == selected.id) {
                try { saveVerifiedPosition(selected, frame, event) }
                catch (error: CancellationException) { throw error }
                catch (error: Throwable) { pendingPositionId = null; announce("图片已确认，但位置没有保存成功；原历史已保留，请重试") }
            }
        } catch (error: CancellationException) {
            if (error !is TimeoutCancellationException) throw error
            if (guard.valid(generation)) reviewFailed(request.taskId, "图片复核超时，请继续扫描")
        } catch (error: Throwable) {
            if (guard.valid(generation)) reviewFailed(request.taskId, "图片复核未完成，请稍后重试：${error.message.orEmpty()}")
        } finally { lastReviewFinishedAt = System.currentTimeMillis() }
    }

    private fun reviewFailed(taskId: String, message: String) {
        if (taskEngine.task?.id != taskId || taskEngine.task?.status != FindStatus.CANDIDATE) return
        if(pendingPositionId!=null) {
            pendingPositionId=null;taskEngine.clear();pendingCandidateBox=null;gate.reset();sceneChangeGate.reset()
            mutableState.value=mutableState.value.copy(target=null,searchId=null,searchState=SearchState.IDLE,qwenVerifying=false,candidateBox=null,verifiedAtMs=0)
            announce("外观记录已保留，画面中的位置暂未确认。可以直接告诉我${activeMemory?.name.orEmpty()}放在哪里")
            return
        }
        taskEngine.verificationFailed(taskId)
        pendingCandidateBox = null
        gate.reset(); sceneChangeGate.reset()
        mutableState.value = mutableState.value.copy(searchState = SearchState.SEARCHING, qwenVerifying = false, candidateBox = null, verifiedAtMs = 0, message = message)
    }

    private suspend fun guidanceStillCurrent(frame: FramePacket): Boolean {
        val verified = lastVerifiedFrame ?: return false
        val region = lastVerifiedRegion
        val differenceLimit = lastVerifiedDifferenceLimit
        if (frame.source != verified.source || frame.rotationDegrees != verified.rotationDegrees || System.currentTimeMillis() - verified.capturedAtMs > 6_000) return false
        return withContext(Dispatchers.Default) {
            val previous = sceneChangeGate.signature(verified.jpeg, verified.rotationDegrees, region)
            val current = sceneChangeGate.signature(frame.jpeg, frame.rotationDegrees, region)
            previous != null && current != null && SceneChangeGate.meanDifference(previous, current) < differenceLimit
        }
    }

    private suspend fun expireGuidanceIfChanged(frame: FramePacket) {
        val task = taskEngine.task ?: return
        val unchanged = guidanceStillCurrent(frame)
        if (unchanged || taskEngine.task?.id != task.id || taskEngine.task?.status != FindStatus.ANNOUNCED) return
        taskEngine.verificationFailed(task.id)
        gate.reset(); speech.reset()
        mutableState.value = mutableState.value.copy(searchState = SearchState.SEARCHING, candidateBox = null, verifiedAtMs = 0, message = "刚才确认过，正在重新检查当前画面")
    }

    private suspend fun saveVerifiedPosition(item: ObjectMemory, frame: FramePacket, event: QwenEvent.TargetVisible) {
        val location = listOfNotNull(event.anchor, event.direction).filter(String::isNotBlank).distinct().joinToString("，")
        if (location.isBlank()) { pendingPositionId = null; announce("看到了物品，但位置参照不清楚，尚未记录位置"); return }
        memory.recordLocation(item.id, location, "CAMERA_VERIFIED", frame.capturedAtMs, event.anchor.orEmpty(), item.revision)
        pendingPositionId = null
        activeMemory = memory.byId(item.id)
        announce("已记录这件${item.name}的位置：$location，之前的位置历史已保留")
    }

    private suspend fun collectQwen(generation: Long) {
        qwen.events.collect { event ->
            if (!guard.valid(generation) || !mutableState.value.voiceRequested) return@collect
            when (event) {
                // Conversational claims and tool calls are not image evidence.
                is QwenEvent.TargetVisible -> Unit
                is QwenEvent.Transcript -> {
                    if (event.role == "user") onUserText(event.text, sendToQwen = false)
                    // Model prose never becomes a UI or spoken save result.
                }
                is QwenEvent.Error -> {
                    if (voiceRecovery.begin(event.code, mutableState.value.running)) {
                        recoverIdleVoice(generation)
                        return@collect
                    }
                    // Disposing the expired engine can report additional transport errors.
                    // The recovery job owns failure reporting until its attempt ends.
                    if (voiceRecovery.pending) return@collect
                    mutableState.value = mutableState.value.copy(error = "${event.message}；图片复核和文字指令仍可使用")
                }
            }
        }
    }

    private fun recoverIdleVoice(generation: Long) {
        qwenReconnectJob = scope.launch {
            if (!guard.valid(generation)) { voiceRecovery.failed(); return@launch }
            mutableState.value = mutableState.value.copy(error = "语音连接已到时，正在恢复；本地识别继续")
            try {
                qwen.disconnect()
                delay(250)
                if (!guard.valid(generation)) return@launch
                qwen.connect()
                if (!guard.valid(generation)) return@launch
                voiceRecovery.connected()
                val current = mutableState.value
                mutableState.value = current.copy(error = null,
                    message = if (current.target == null) "语音已恢复，可以继续对话" else current.message)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                voiceRecovery.failed()
                if (guard.valid(generation)) mutableState.value = mutableState.value.copy(
                    error = "语音恢复未完成，请结束后重试；本地识别继续")
            } finally {
                if (voiceRecovery.pending) voiceRecovery.failed()
            }
        }
    }

    fun requiresCamera(text: String): Boolean = when(dialogue.intent(text,mutableState.value.target ?: activeMemory?.name)) {
        is DialogueIntent.StartSearch,is DialogueIntent.RememberObject,is DialogueIntent.RememberCurrentLocation,is DialogueIntent.DescribeScene -> true
        else -> false
    }

    suspend fun onUserText(text: String,sendToQwen: Boolean=true) {
        val serial=++inputSerial;conversationJob?.cancel();speech.reset()
        val snapshot=router.frame.value?.takeIf { System.currentTimeMillis()-it.capturedAtMs in 0..2_000 && source?.state?.value==FrameSourceState.RUNNING }?.let { it.copy(jpeg=it.jpeg.copyOf()) }
        if(memoryCommand(text)) { qwen.setTaskMode(true);return }
        val focus=mutableState.value.target ?: activeMemory?.name
        val local=dialogue.intent(text,focus)
        if(local!=null) { executeIntent(local,snapshot,serial);return }
        if(focus==null && dialogue.isMemoryRequest(text) && Regex("(?:它|这个|那个)[。！!？?]*$").containsMatchIn(text)) { announce("请说明要记住哪件物品，例如记住这个杯子");return }
        conversationJob=scope.launch {
            val parsed=if(qwen.state.value==RealtimeState.CONNECTED) try { qwen.interpretUser(text,focus,memoryNameHints()) }
                catch(error: CancellationException) { if(error !is TimeoutCancellationException) throw error;null }
                catch(error: Exception) { null } else null
            if(serial!=inputSerial) return@launch
            if(parsed!=null) executeIntent(parsed,snapshot,serial)
            else announce(if(text.contains("记住") || text.contains("记得")) "请说明是哪件物品，例如记住这个杯子，或询问杯子记住了吗" else "我还没确定你的意思。可以说记住这个杯子、查杯子上次的位置、找杯子，或问桌上有什么")
        }
    }

    private suspend fun memoryNameHints()=listOfNotNull(activeMemory?.name,mutableState.value.target).distinct()

    private suspend fun executeIntent(intent: DialogueIntent,snapshot: FramePacket?,serial: Long) {
        qwen.setTaskMode(true)
        when(intent) {
            is DialogueIntent.StartSearch -> resolveObject(intent.target,intent,snapshot)
            is DialogueIntent.RememberObject -> if(intent.newIdentity) beginLearning(intent.target,capturePosition=!intent.appearanceOnly,snapshot=snapshot) else resolveObject(intent.target,intent,snapshot)
            is DialogueIntent.RecallLocation -> resolveObject(intent.target,intent,snapshot)
            is DialogueIntent.CheckMemory -> resolveObject(intent.target,intent,snapshot)
            is DialogueIntent.RecallAppearance -> resolveObject(intent.target,intent,snapshot)
            is DialogueIntent.RecordLocation -> if(intent.newIdentity) performAction(intent,null,snapshot) else resolveObject(intent.target,intent,snapshot)
            is DialogueIntent.RememberCurrentLocation -> resolveObject(intent.target,intent,snapshot)
            is DialogueIntent.SelectObject -> {
                val choice=mutableState.value.objectChoices.getOrNull(intent.index)
                if(choice==null) announce("请按列表选择具体物品，或说取消") else selectObject(choice.id)
            }
            is DialogueIntent.DescribeScene -> {
                qwen.setTaskMode(false)
                if(snapshot==null) { announce("还没有可用的当前画面，请先开启画面");return }
                conversationJob=scope.launch {
                    val result=try { qwen.describeScene(snapshot,null,intent.question) }
                        catch(error: CancellationException) { if(error !is TimeoutCancellationException) throw error;null }
                        catch(error: Exception) { null }
                    if(serial==inputSerial) announce(if(result!=null && result.frameId==snapshot.id && System.currentTimeMillis()-snapshot.capturedAtMs<=15_000) ControlledQwenProtocol.sceneReply(result) else "当前画面描述暂未完成，可以稍后再问；已存记录没有改变")
                }
            }
            DialogueIntent.CompleteSearch -> completeSearch()
            DialogueIntent.Cancel -> cancelSearch()
            DialogueIntent.ContinueSearch -> if(mutableState.value.objectChoices.isNotEmpty()) announce("请先选择具体物品") else mutableState.value.target?.let { beginSearch(it,activeMemory?.id) }
            is DialogueIntent.LocationHint -> announce("这只是本轮线索，没有写成已确认的位置：${intent.text}")
        }
        if(mutableState.value.searchState in setOf(SearchState.IDLE,SearchState.COMPLETED,SearchState.CANCELLED) && mutableState.value.objectChoices.isEmpty()) qwen.setTaskMode(false)
    }

    private suspend fun resolveObject(name: String, action: DialogueIntent,snapshot: FramePacket?=null) {
        val choices = memory.choices(name)
        val readOnly=action is DialogueIntent.CheckMemory || action is DialogueIntent.RecallLocation || action is DialogueIntent.RecallAppearance
        if(readOnly) activeMemory?.id?.takeIf { id -> choices.any { it.id==id } }?.let { performAction(action,it,snapshot);return }
        if (choices.size > 1 || (action is DialogueIntent.RememberObject && choices.singleOrNull()?.let { memory.byId(it.id)?.embeddings?.isNotEmpty() }==true)) {
            qwen.setTaskMode(true)
            verificationJob?.cancel()
            taskEngine.cancel()
            activeMemory = null
            pendingPositionId = null
            pendingChoice = action;pendingSnapshot=snapshot
            mutableState.value = mutableState.value.copy(target = name, searchId = null, searchState = SearchState.IDLE, qwenVerifying = false, objectChoices = choices, candidateBox = null, verifiedAtMs = 0)
            announce(if(action is DialogueIntent.RememberObject) "已经有${choices.size}件叫${name}的记录，更新外观请选第几件；新增请说再记住一件$name" else "有${choices.size}件叫${name}的物品，请说第一件、第二件，或在列表中选择")
            return
        }
        pendingChoice = null
        mutableState.value = mutableState.value.copy(objectChoices = emptyList())
        performAction(action, choices.singleOrNull()?.id,snapshot)
    }

    suspend fun selectObject(id: String) {
        check(mutableState.value.objectChoices.any { it.id == id }) { "请从当前列表选择" }
        val action = pendingChoice ?: return
        pendingChoice = null
        mutableState.value = mutableState.value.copy(objectChoices = emptyList())
        if (memory.byId(id) == null) { announce("这件物品已删除，请重新选择"); return }
        val snapshot=pendingSnapshot;pendingSnapshot=null
        performAction(action, id,snapshot)
    }

    private suspend fun performAction(action: DialogueIntent, id: String?,snapshot: FramePacket?=null) {
        when (action) {
            is DialogueIntent.StartSearch -> beginSearch(action.target, id)
            is DialogueIntent.RememberObject -> beginLearning(action.target,id,capturePosition=!action.appearanceOnly,snapshot=snapshot)
            is DialogueIntent.CheckMemory -> {
                if(id==null) { announce("还没有保存这件物品的记忆");return }
                val item=checkNotNull(memory.byId(id));activeMemory=item
                val latest=memory.captures(id).firstOrNull();val history=memory.history(id)
                val parts=mutableListOf<String>()
                if(latest!=null) parts.add("当时画面已保存")
                parts.add(if(item.embeddings.isNotEmpty()) "有参考外观照片" else "目标外观照片尚未保存")
                parts.add(if(latest?.verifiedLocation!=null) "本次确认的位置是${latest.verifiedLocation}" else if(history.isNotEmpty()) "只有过去的位置记录，最近一次是${history.first().location}（${locationSourceLabel(history.first().source)}）" else "位置尚未确认")
                announce("${item.name}的实际保存状态："+parts.joinToString("；"))
            }
            is DialogueIntent.RecallAppearance -> {
                if(id==null) { announce("还没有保存这件物品的外观");return }
                val item=checkNotNull(memory.byId(id));activeMemory=item
                announce(when {
                    item.embeddings.isEmpty() -> "还没有保存${item.name}的目标外观照片"+if(memory.captures(id).isNotEmpty()) "，只留存了当时画面" else ""
                    !item.semanticDescription.isNullOrBlank() -> "已存记录中的${item.name}外观：${item.semanticDescription}"
                    else -> "已保存${item.name}的参考照片，暂时没有文字外观描述"
                })
            }
            is DialogueIntent.RecallLocation -> {
                if (id == null) { announce("还没有记住这件物品，也没有位置历史"); return }
                activeMemory=memory.byId(id)
                val history = memory.history(id)
                if (history.isEmpty()) {
                    val item=checkNotNull(memory.byId(id))
                    announce(if(item.embeddings.isNotEmpty()) "已保存外观，但还没有确认的位置记录" else if(memory.captures(id).isNotEmpty()) "只保存了当时画面，物品位置仍未确认" else "目前只有物品名称，还没有位置记录")
                    return
                }
                val formatter = java.time.format.DateTimeFormatter.ofPattern("M月d日 HH:mm").withZone(java.time.ZoneId.systemDefault())
                val content = history.take(5).joinToString("；") { "${formatter.format(java.time.Instant.ofEpochMilli(it.recordedAtMs))}记录：${it.location}（${locationSourceLabel(it.source)}）" }
                announce("这是过去的位置记录，共${history.size}条：$content。这些记录不能证明物品现在仍在那里。")
            }
            is DialogueIntent.RecordLocation -> {
                learningTimeoutJob?.cancel();verificationJob?.cancel();verificationTimeoutJob?.cancel();taskEngine.clear()
                val item=if(id==null) memory.createWithLocation(action.target,matcher.labelsFor(action.target).firstOrNull(),action.location,action.newIdentity)
                    else checkNotNull(memory.byId(id)).let { memory.recordLocation(it.id,action.location,expectedRevision=it.revision);checkNotNull(memory.byId(it.id)) }
                activeMemory=item;pendingChoice=null;pendingPositionId=null
                mutableState.value=mutableState.value.copy(target=null,searchId=null,searchState=SearchState.IDLE,qwenVerifying=false,rememberedObjectId=item.id,objectChoices=emptyList(),candidateBox=null,verifiedAtMs=0)
                if(mutableState.value.running && item.embeddings.isEmpty()) beginLearning(item.name,item.id,action.location,snapshot=snapshot)
                else announce("已记住${item.name}在${action.location}。这是你提供的位置，原历史已保留"+if(item.embeddings.isEmpty()) "；外观照片可以之后补充" else "")
            }
            is DialogueIntent.RememberCurrentLocation -> beginLearning(action.target,id,capturePosition=true,snapshot=snapshot)
            else -> Unit
        }
    }

    suspend fun beginSearch(target: String, objectId: String? = null) {
        if (!mutableState.value.running) { announce("请先开启画面，再开始寻找"); return }
        if (objectId == null && memory.choices(target).size > 1) { resolveObject(target, DialogueIntent.StartSearch(target)); return }
        learningTimeoutJob?.cancel();verificationJob?.cancel(); verificationTimeoutJob?.cancel()
        speech.reset()
        gate = StableCandidateGate(); sceneChangeGate.reset()
        rejectedBox = null; pendingPositionId = null; lastVerifiedFrame = null; lastVerifiedResult = null
        candidateDirectory.listFiles()?.forEach { it.delete() }
        activeMemory = if (objectId == null) memory.findObject(target) else checkNotNull(memory.byId(objectId)) { "这件物品已删除" }
        val name = activeMemory?.name ?: target
        val task = taskEngine.start(name, activeMemory?.id, mutableState.value.source)
        qwen.setTaskMode(true)
        val text = "开始寻找$name，请缓慢移动摄像头"
        mutableState.value = mutableState.value.copy(target = name, searchId = task.id, searchState = SearchState.SEARCHING,
            rememberedObjectId = activeMemory?.id, objectChoices = emptyList(), candidateBox = null, verifiedAtMs = 0,
            candidateScore = null, appearanceSimilarity = null, qwenVerifying = false, notice = null, message = "正在寻找，图片复核独立运行", lastSpeech = text)
        announce(text)
    }

    suspend fun beginLearning(target: String, objectId: String? = null,locationAlreadySaved: String?=null,capturePosition: Boolean=false,snapshot: FramePacket?=null) {
        if (!mutableState.value.running) { announce("请先开启画面，再采集物品外观"); return }
        learningTimeoutJob?.cancel();verificationJob?.cancel(); verificationTimeoutJob?.cancel()
        speech.reset()
        learningReplacement = objectId?.let { checkNotNull(memory.byId(it)) { "这件物品已删除" } }
        val name = learningReplacement?.name ?: target
        val task = taskEngine.startLearning(name, mutableState.value.source, objectId)
        learningCaptureId=null
        learningView=null;learningSignature=null;learningStableSince=0;learningSaving=false
        learningLocation=locationAlreadySaved;learningNeedsPosition=capturePosition
        pendingPositionId = null; pendingChoice = null
        qwen.setTaskMode(true)
        val text = (if(locationAlreadySaved!=null) "已记下${name}在$locationAlreadySaved，正在顺便记外观。" else "")+if(capturePosition) "正在自动记住${name}的外观和当前画面中的位置" else "正在记住${name}的外观，请让物品在画面中可见"
        mutableState.value = mutableState.value.copy(target = name, searchId = task.id, searchState = SearchState.LEARNING, rememberedObjectId = objectId,
            objectChoices = emptyList(), candidateBox = null, verifiedAtMs = 0, qwenVerifying = false, notice = null, learningSamples = 0, message = text, lastSpeech = text)
        announce(text)
        val generation=guard.current();val replySerial=inputSerial
        verificationJob=scope.launch {
            fun allowed()=guard.valid(generation) && mutableState.value.searchId==task.id && mutableState.value.searchState==SearchState.LEARNING
            try { withTimeout(28_000) { captureMemory(task.id,name,learningReplacement,locationAlreadySaved,capturePosition,snapshot,replySerial,::allowed) } }
            catch(error: CancellationException) {
                if(error !is TimeoutCancellationException) throw error
                if(allowed()) learningFailed(if(locationAlreadySaved!=null) "你提供的位置已保留，自动取景暂未完成" else "自动取景暂未完成，这次没有保存，请稍后再试")
            }
            catch(error: Exception) {
                if(allowed()) learningFailed(if(locationAlreadySaved!=null) "你提供的位置已保留，外观暂未保存" else "自动记忆暂未完成，这次没有保存，请检查画面和网络后再试")
            }
        }
    }

    private fun announce(text: String) {
        speech.announce(SpeechEvent(UUID.randomUUID().toString(), text, SpeechPriority.P1))
        mutableState.value = mutableState.value.copy(message = text, lastSpeech = text, notice = text)
    }

    fun completeSearch() {
        ++inputSerial;conversationJob?.cancel()
        learningTimeoutJob?.cancel();verificationJob?.cancel(); verificationTimeoutJob?.cancel()
        taskEngine.complete(); pendingPositionId = null; pendingChoice = null
        speech.reset()
        mutableState.value = mutableState.value.copy(searchState = SearchState.COMPLETED, qwenVerifying = false, objectChoices = emptyList(), candidateBox = null, verifiedAtMs = 0)
        announce("本轮寻找已完成");qwen.setTaskMode(false)
    }

    fun cancelSearch() {
        ++inputSerial;conversationJob?.cancel()
        learningTimeoutJob?.cancel();verificationJob?.cancel(); verificationTimeoutJob?.cancel()
        taskEngine.cancel(); pendingPositionId = null; pendingChoice = null
        speech.reset()
        candidateDirectory.listFiles()?.forEach { it.delete() }
        mutableState.value = mutableState.value.copy(target = null, searchId = null, searchState = SearchState.CANCELLED, qwenVerifying = false, objectChoices = emptyList(), candidateBox = null, verifiedAtMs = 0)
        announce(if(learningCaptureId!=null) "已取消本轮处理，已经保存的当时画面保留" else "已取消寻找");qwen.setTaskMode(false)
    }

    suspend fun resetConversation() {
        stop()
        activeMemory = null
    }

    suspend fun stop() {
        guard.next();++inputSerial;conversationJob?.cancel();conversationJob=null;pendingSnapshot=null
        mutableState.value = AssistantState(message = "已停止")
        qwen.setMicrophoneEnabled(false)
        val jobs = listOf(sourceJob, processingJob, qwenJob, qwenConnectJob, qwenReconnectJob, qwenFrameJob, frameWatchdogJob, sourceStateJob, verificationTimeoutJob, verificationJob,learningTimeoutJob)
        jobs.forEach { it?.cancel() }
        // Release media before waiting for an in-flight HTTP verification.
        source?.stop(); source = null
        qwen.disconnect()
        jobs.forEach { it?.join() }
        sourceJob = null; processingJob = null; qwenJob = null; qwenConnectJob = null; qwenReconnectJob = null; qwenFrameJob = null; frameWatchdogJob = null; sourceStateJob = null; verificationTimeoutJob = null; verificationJob = null
        voiceRecovery.reset()
        qwen.setTaskMode(false)
        pendingChoice = null; pendingPositionId = null; learningReplacement = null
        learningTimeoutJob=null;learningView=null;learningSignature=null;learningLocation=null;learningNeedsPosition=false;learningSaving=false
        lastVerifiedFrame = null; lastVerifiedResult = null
        lastReviewFinishedAt = 0
        router.stop(); gate.reset(); taskEngine.clear(); speech.reset()
        candidateDirectory.listFiles()?.forEach { it.delete() }
        mutableState.value = AssistantState(message = "已停止")
    }
}
