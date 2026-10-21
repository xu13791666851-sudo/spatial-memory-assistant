package com.spatialmemory.assistant.orchestrator

import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.dialogue.DialogueIntent
import com.spatialmemory.assistant.dialogue.FindDialogueEngine
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.memory.AppearanceSample
import com.spatialmemory.assistant.memory.MemoryRepository
import com.spatialmemory.assistant.memory.ObjectMemory
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

class AssistantOrchestrator(
    private val detector: YoloDetector,
    private val matcher: TargetMatcher,
    private val perception: PerceptionEngine,
    private val memory: MemoryRepository,
    private val qwen: QwenRealtimeClient,
    private val speech: SpeechCoordinator,
    private val candidateDirectory: File,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
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
    private var qwenFrameJob: Job? = null
    private var frameWatchdogJob: Job? = null
    private var sourceStateJob: Job? = null
    private var verificationTimeoutJob: Job? = null
    private var verificationJob: Job? = null
    private var routeToken = 0L
    private var gate = StableCandidateGate()
    private val sceneChangeGate = SceneChangeGate()
    private var lastQwenFrameAt = 0L
    private var activeMemory: ObjectMemory? = null
    private val learningSamples = mutableListOf<AppearanceSample>()
    private var lastLearningSampleAt = 0L
    private var rejectedBox: Box? = null
    private var pendingCandidateBox: Box? = null
    private var rejectedAt = 0L
    private var qwenRequestAt = 0L

    val state = mutableState.asStateFlow()
    val analyzedFrames = mutableAnalyzedFrames.asSharedFlow()

    suspend fun start(frameSource: FrameSource) {
        stop()
        val generation = guard.next()
        source = frameSource
        routeToken = router.switchTo(frameSource.source)
        try {
            frameSource.start()
            mutableState.value = AssistantState(
                running = true,
                source = frameSource.source,
                message = "本地识别已启动，千问连接中",
            )
            qwenConnectJob = scope.launch {
                runCatching { qwen.connect() }
                    .onSuccess {
                        if (guard.valid(generation)) mutableState.value = mutableState.value.copy(message = "本地识别与千问已启动", error = null)
                    }
                    .onFailure {
                        if (guard.valid(generation)) mutableState.value = mutableState.value.copy(error = "千问连接失败：${it.message}；本地识别继续", message = "本地识别已启动，千问暂不可用")
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
                    error = current.error?.takeIf { !it.startsWith("千问") },
                    message = if (current.target == null) "YOLO 运行中：本帧检测到 ${detections.size} 个目标" else current.message,
                )
                mutableAnalyzedFrames.tryEmit(AnalyzedFrame(frame, detections))
                when (taskEngine.task?.status) {
                    FindStatus.LEARNING -> collectLearningSample(frame, detections)
                    FindStatus.WATCHING -> analyzeSearchFrame(frame, detections)
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

    private suspend fun collectLearningSample(frame: FramePacket, detections: List<Detection>) {
        val task = taskEngine.task ?: return
        val now = System.currentTimeMillis()
        if (now - lastLearningSampleAt < 600 || learningSamples.size >= 3) return
        val sample = withContext(Dispatchers.Default) { perception.learningSample(frame, task.targetName, detections) }
        learningSamples += AppearanceSample(sample.first, sample.second, frame.capturedAtMs)
        lastLearningSampleAt = now
        mutableState.value = mutableState.value.copy(learningSamples = learningSamples.size, message = "正在记住 ${task.targetName}：已采集 ${learningSamples.size}/3 个角度")
        if (learningSamples.size == 3) {
            val remembered = memory.rememberObject(task.targetName, matcher.labelsFor(task.targetName).firstOrNull(), learningSamples.toList())
            activeMemory = remembered
            taskEngine.clear()
            val text = "已经记住${task.targetName}"
            speech.announce(SpeechEvent("${task.id}:learned", text, SpeechPriority.P0))
            mutableState.value = mutableState.value.copy(target = null, searchId = null, searchState = SearchState.IDLE, rememberedObjectId = remembered.id, message = text, lastSpeech = text)
        }
    }

    private suspend fun analyzeSearchFrame(frame: FramePacket, detections: List<Detection>) {
        val task = taskEngine.task ?: return
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
        if (qwen.state.value != RealtimeState.CONNECTED) {
            gate.reset()
            mutableState.value = mutableState.value.copy(message = "YOLO 发现疑似${task.targetName}，但千问未连接，尚未确认")
            return
        }
        if (taskEngine.candidate(stable) == null) return
        candidateDirectory.mkdirs()
        File(candidateDirectory, "${stable.id}-full.jpg").writeBytes(frame.jpeg)
        File(candidateDirectory, "${stable.id}-crop.jpg").writeBytes(stable.cropJpeg)
        val localText = "发现疑似${task.targetName}，正在请千问确认"
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
        qwenRequestAt = System.currentTimeMillis()
        val box = candidate.box
        val request = CandidateVerificationRequest(
            taskId = candidate.taskId,
            candidateId = candidate.id,
            frameId = candidate.frameId,
            target = target,
            description = description,
            label = candidate.label,
            confidence = candidate.yoloConfidence,
            normalizedBox = listOf(box.left / candidate.frameWidth, box.top / candidate.frameHeight, box.right / candidate.frameWidth, box.bottom / candidate.frameHeight),
        )
        mutableState.value = mutableState.value.copy(candidateBox = request.normalizedBox, verifiedAtMs = 0)
        armVerificationTimeout(request.taskId)
        try {
            qwen.verifyCandidate(candidate.frame, candidate.frame.copy(jpeg = candidate.cropJpeg, rotationDegrees = 0), request)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            if (taskEngine.task?.id != request.taskId) return
            verificationTimeoutJob?.cancel()
            taskEngine.verificationFailed(request.taskId)
            pendingCandidateBox = null
            gate.reset()
            mutableState.value = mutableState.value.copy(searchState = SearchState.SEARCHING, qwenVerifying = false, error = "千问确认请求失败：${error.message}", message = "千问确认失败，继续寻找")
        }
    }

    private suspend fun inspectUnsupportedTarget(frame: FramePacket, taskId: String, target: String) {
        if (qwen.state.value != RealtimeState.CONNECTED || !sceneChangeGate.offer(frame.jpeg, System.currentTimeMillis())) return
        val candidateId = UUID.randomUUID().toString()
        if (!taskEngine.semanticCandidate(candidateId, frame.id)) return
        val request = CandidateVerificationRequest(
            taskId = taskId,
            candidateId = candidateId,
            frameId = frame.id,
            target = target,
            description = activeMemory?.semanticDescription,
            label = "semantic",
            confidence = 0f,
            normalizedBox = listOf(0f, 0f, 1f, 1f),
        )
        qwenRequestAt = System.currentTimeMillis()
        mutableState.value = mutableState.value.copy(
            searchState = SearchState.VERIFYING,
            qwenVerifying = true,
            message = "YOLO 没有该类别，正在请千问检查当前画面",
        )
        armVerificationTimeout(taskId)
        try {
            qwen.inspectTarget(frame, request)
        } catch (error: Throwable) {
            verificationTimeoutJob?.cancel()
            taskEngine.verificationFailed(taskId)
            mutableState.value = mutableState.value.copy(searchState = SearchState.SEARCHING, qwenVerifying = false, error = "千问确认请求失败：${error.message}", message = "千问确认失败，继续寻找")
        }
    }

    private fun armVerificationTimeout(taskId: String) {
        verificationTimeoutJob?.cancel()
        verificationTimeoutJob = scope.launch(Dispatchers.Default) {
            delay(18_000)
            val timedOut = withContext(Dispatchers.Main.immediate) {
                if (!mutableState.value.qwenVerifying || taskEngine.task?.id != taskId) return@withContext false
                taskEngine.verificationFailed(taskId)
                pendingCandidateBox = null
                gate.reset()
                val text = "千问确认超时，请继续扫描"
                mutableState.value = mutableState.value.copy(searchState = SearchState.SEARCHING, qwenVerifying = false, message = text)
                speech.announce(SpeechEvent("$taskId:qwen-timeout:$qwenRequestAt", text, SpeechPriority.P1))
                true
            }
            if (timedOut) runCatching { qwen.interrupt() }
        }
    }

    private suspend fun collectQwen(generation: Long) {
        qwen.events.collect { event ->
            if (!guard.valid(generation)) return@collect
            when (event) {
                is QwenEvent.TargetVisible -> {
                    if (!taskEngine.isCurrent(event)) return@collect
                    verificationTimeoutJob?.cancel()
                    val currentCandidateBox = pendingCandidateBox
                    val candidateId = taskEngine.task?.announcedCandidateId
                    pendingCandidateBox = null
                    val result = taskEngine.verification(event)
                    mutableState.value = mutableState.value.copy(qwenVerifying = false, qwenLatencyMs = (System.currentTimeMillis() - qwenRequestAt).coerceAtLeast(0))
                    if (result != null) {
                        speech.announce(SpeechEvent("${result.taskId}:qwen-detail", result.text, if (result.initialDiscovery) SpeechPriority.P0 else SpeechPriority.P1))
                        mutableState.value = mutableState.value.copy(searchState = SearchState.GUIDING, verifiedAtMs = System.currentTimeMillis(), message = "已确认：${result.text}", lastSpeech = result.text)
                    } else if (taskEngine.task?.status == FindStatus.WATCHING) {
                        rejectedBox = currentCandidateBox
                        rejectedAt = System.currentTimeMillis()
                        gate.reset()
                        val message = if (currentCandidateBox == null) "千问当前未看到目标，请继续缓慢移动摄像头" else "千问未确认该候选，本地寻找继续"
                        if (currentCandidateBox != null) speech.announce(SpeechEvent("${event.taskId}:$candidateId:rejected", "千问确认不是${mutableState.value.target}，请继续扫描", SpeechPriority.P1))
                        mutableState.value = mutableState.value.copy(searchState = SearchState.SEARCHING, message = message)
                    }
                }
                is QwenEvent.Transcript -> {
                    if (event.role == "user") onUserText(event.text, sendToQwen = false)
                    else if (taskEngine.task == null) mutableState.value = mutableState.value.copy(message = event.text)
                }
                is QwenEvent.Error -> {
                    if (mutableState.value.qwenVerifying) {
                        taskEngine.task?.id?.let(taskEngine::verificationFailed)
                        gate.reset()
                    }
                    mutableState.value = mutableState.value.copy(searchState = SearchState.SEARCHING, error = "${event.message}；本地识别继续", qwenVerifying = false)
                }
            }
        }
    }

    suspend fun onUserText(text: String, sendToQwen: Boolean = true) {
        when (val intent = dialogue.intent(text, mutableState.value.target)) {
            is DialogueIntent.StartSearch -> beginSearch(intent.target)
            is DialogueIntent.RememberObject -> beginLearning(intent.target)
            DialogueIntent.CompleteSearch -> completeSearch()
            DialogueIntent.Cancel -> cancelSearch()
            DialogueIntent.ContinueSearch -> mutableState.value.target?.let { beginSearch(it) }
            is DialogueIntent.LocationHint -> mutableState.value = mutableState.value.copy(message = "已作为本轮线索，尚未确认：${intent.text}")
            null -> if (sendToQwen) qwen.sendText(text)
        }
    }

    suspend fun beginSearch(target: String) {
        verificationJob?.cancel(); verificationTimeoutJob?.cancel()
        gate = StableCandidateGate()
        sceneChangeGate.reset()
        rejectedBox = null
        candidateDirectory.listFiles()?.forEach { it.delete() }
        activeMemory = memory.findObject(target)
        val task = taskEngine.start(target, activeMemory?.id, mutableState.value.source)
        val supported = matcher.supports(activeMemory?.name ?: target)
        val message = when {
            supported && activeMemory != null -> "正在结合个人外观记忆寻找 $target"
            supported -> "正在用 YOLO 寻找 $target"
            qwen.state.value == RealtimeState.CONNECTED -> "YOLO 没有该类别，正在请千问检查当前画面"
            else -> "YOLO 没有该类别，等待千问连接后检查当前画面"
        }
        val startSpeech = "开始寻找$target，请缓慢移动摄像头"
        speech.announce(SpeechEvent("${task.id}:started", startSpeech, SpeechPriority.P2))
        mutableState.value = mutableState.value.copy(
            target = target,
            searchId = task.id,
            searchState = SearchState.SEARCHING,
            rememberedObjectId = activeMemory?.id,
            candidateBox = null, verifiedAtMs = 0,
            candidateScore = null,
            appearanceSimilarity = null,
            qwenVerifying = false,
            message = message,
            lastSpeech = startSpeech,
        )
    }

    fun beginLearning(target: String) {
        verificationJob?.cancel(); verificationTimeoutJob?.cancel()
        val task = taskEngine.startLearning(target, mutableState.value.source)
        learningSamples.clear()
        lastLearningSampleAt = 0
        val text = "请把${target}放在画面中央，缓慢转动"
        speech.announce(SpeechEvent("${task.id}:learning-start", text, SpeechPriority.P2))
        mutableState.value = mutableState.value.copy(target = target, searchId = task.id, searchState = SearchState.LEARNING, candidateBox = null, verifiedAtMs = 0, learningSamples = 0, message = text, lastSpeech = text)
    }

    fun completeSearch() {
        val task = taskEngine.complete()
        candidateDirectory.listFiles()?.forEach { it.delete() }
        task?.let { speech.announce(SpeechEvent("${it.id}:completed", "本轮寻找已完成", SpeechPriority.P1)) }
        mutableState.value = mutableState.value.copy(searchState = SearchState.COMPLETED, qwenVerifying = false, message = "本轮寻找已完成", lastSpeech = "本轮寻找已完成")
    }

    fun cancelSearch() {
        verificationJob?.cancel(); verificationTimeoutJob?.cancel()
        val task = taskEngine.cancel()
        candidateDirectory.listFiles()?.forEach { it.delete() }
        task?.let { speech.announce(SpeechEvent("${it.id}:cancelled", "已取消寻找", SpeechPriority.P1)) }
        mutableState.value = mutableState.value.copy(target = null, searchId = null, searchState = SearchState.CANCELLED, qwenVerifying = false, message = "已取消寻找", lastSpeech = "已取消寻找")
    }

    suspend fun stop() {
        guard.next()
        mutableState.value = AssistantState(message = "已停止")
        qwen.setMicrophoneEnabled(false)
        val jobs = listOf(sourceJob, processingJob, qwenJob, qwenConnectJob, qwenFrameJob, frameWatchdogJob, sourceStateJob, verificationTimeoutJob, verificationJob)
        jobs.forEach { it?.cancel() }
        // Release media before waiting for an in-flight HTTP verification.
        source?.stop(); source = null
        qwen.disconnect()
        jobs.forEach { it?.join() }
        sourceJob = null; processingJob = null; qwenJob = null; qwenConnectJob = null; qwenFrameJob = null; frameWatchdogJob = null; sourceStateJob = null; verificationTimeoutJob = null; verificationJob = null
        router.stop(); gate.reset(); taskEngine.clear(); speech.reset()
        candidateDirectory.listFiles()?.forEach { it.delete() }
        mutableState.value = AssistantState(message = "已停止")
    }
}
