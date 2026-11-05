package com.spatialmemory.assistant

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.inference.*
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.orchestrator.*
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.speech.SpeechCoordinator
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Test

class IndependentReviewTest {
    @Test fun voiceFailureDuringImageReviewDoesNotCancelTheImageResult() = runBlocking {
        withFixture { fixture ->
            fixture.start()
            fixture.core.beginSearch("测试票据")
            val request = withTimeout(3_000) { fixture.entered.await() }
            fixture.voice.errors.emit(QwenEvent.Error("injected voice outage"))
            delay(100)
            assertTrue(fixture.core.state.value.qwenVerifying)
            assertEquals(SearchState.VERIFYING, fixture.core.state.value.searchState)
            delay(7_100) // Measured provider latency was ~7 s; a stable scene must still work.
            fixture.answer.complete(ImageReview(ImageDecision.CONFIRMED, positive(request)))
            withTimeout(3_000) { fixture.core.state.first { it.searchState == SearchState.GUIDING } }
            assertEquals(RealtimeState.FAILED, fixture.voice.state.value)
            assertTrue(fixture.core.state.value.message.contains("已确认"))
        }
    }

    @Test fun cancellingAReviewPreventsLateConfirmationAndNewSourceStopsItsRequest() = runBlocking {
        withFixture { fixture ->
            fixture.start()
            fixture.core.beginSearch("测试票据")
            val request = withTimeout(3_000) { fixture.entered.await() }
            fixture.core.cancelSearch()
            fixture.answer.complete(ImageReview(ImageDecision.CONFIRMED, positive(request)))
            delay(200)
            assertEquals(SearchState.CANCELLED, fixture.core.state.value.searchState)
            assertEquals(0L, fixture.core.state.value.verifiedAtMs)
            fixture.core.stop()
            assertFalse(fixture.core.state.value.running)
        }
    }

    @Test fun historyAndDuplicateSelectionWorkWithoutStartingCameraOrVoice() = runBlocking {
        withFixture { fixture ->
            val samples = List(3) { AppearanceSample(fixture.jpeg, floatArrayOf(.2f, .5f), 100) }
            val first = fixture.repo.rememberObject("水杯", "cup", samples)
            val second = fixture.repo.rememberObject("水杯", "cup", samples)
            fixture.repo.recordLocation(first.id, "书桌")
            fixture.repo.recordLocation(second.id, "厨房")
            fixture.core.onUserText("查询水杯的位置历史")
            assertEquals(2, fixture.core.state.value.objectChoices.size)
            fixture.core.onUserText("第二件")
            assertTrue(fixture.core.state.value.lastSpeech!!.contains("厨房"))
            assertFalse(fixture.core.state.value.lastSpeech!!.contains("书桌"))
            assertFalse(fixture.core.state.value.running)
            assertEquals(0, fixture.voice.connects)
            assertEquals(0, fixture.source.starts)
            fixture.core.onUserText("记住，水杯放在床头")
            assertEquals(2, fixture.core.state.value.objectChoices.size)
            fixture.core.selectObject(first.id)
            assertEquals("床头", fixture.repo.history(first.id).first().location)
            assertEquals(listOf("厨房"), fixture.repo.history(second.id).map { it.location })
            assertEquals(0, fixture.source.starts)
        }
    }

    @Test fun failedVideoSourceCannotPublishAPositiveReview() = runBlocking {
        withFixture { fixture ->
            fixture.start()
            fixture.core.beginSearch("测试票据")
            val request = withTimeout(3_000) { fixture.entered.await() }
            fixture.source.state.value = FrameSourceState.FAILED
            fixture.answer.complete(ImageReview(ImageDecision.CONFIRMED, positive(request)))
            withTimeout(3_000) { fixture.core.state.first { !it.qwenVerifying } }
            assertEquals(0L, fixture.core.state.value.verifiedAtMs)
            assertEquals(SearchState.SEARCHING, fixture.core.state.value.searchState)
        }
    }

    @Test fun typedModeIgnoresLateVoiceMessagesAndNeverRestartsTheMicrophone() = runBlocking {
        withFixture { fixture ->
            fixture.core.start(fixture.source, enableVoice = false)
            fixture.voice.errors.emit(QwenEvent.Error("late old session", "response_idle_timeout"))
            fixture.voice.errors.emit(QwenEvent.Transcript("user", "帮我找错误目标"))
            delay(400)
            assertFalse(fixture.core.state.value.voiceRequested)
            assertNull(fixture.core.state.value.target)
            assertEquals(0, fixture.voice.connects)
            assertEquals(RealtimeState.DISCONNECTED, fixture.voice.state.value)
        }
    }

    private fun positive(request: CandidateVerificationRequest) = QwenEvent.TargetVisible(request.taskId, request.candidateId, request.frameId, true, true, "画面中央", "桌边", "清晰", .95f)

    private suspend fun withFixture(test: suspend CoroutineScope.(Fixture) -> Unit) = coroutineScope {
        val fixture = withContext(Dispatchers.Main) { Fixture() }
        try { withContext(Dispatchers.Main) { test(fixture) } }
        finally { withContext(NonCancellable + Dispatchers.Main) { fixture.core.stop(); fixture.speech.close(); fixture.scope.cancel() }; fixture.db.close(); fixture.cleanup() }
    }

    private class Fixture {
        val context = ApplicationProvider.getApplicationContext<Context>()
        private val id = UUID.randomUUID().toString()
        private val dbName = "review-safety-$id.db"
        private val photos = File(context.filesDir, "review-safety-$id")
        private val candidates = File(context.cacheDir, "review-safety-$id")
        val db = AppDatabase.open(context, dbName)
        val repo = MemoryRepository(context, db.memoryDao(), db.objectMemoryDao(), photos)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val jpeg = ByteArrayOutputStream().use { output ->
            val image = Bitmap.createBitmap(40, 40, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
            image.compress(Bitmap.CompressFormat.JPEG, 85, output); image.recycle(); output.toByteArray()
        }
        val voice = FailedVoice()
        val source = TestSource(scope, jpeg)
        val entered = CompletableDeferred<CandidateVerificationRequest>()
        val answer = CompletableDeferred<ImageReview>()
        val speech = SpeechCoordinator(context) { }.apply { setEnabled(false) }
        val core = AssistantOrchestrator(
            object : FrameDetector { override fun detect(jpeg: ByteArray, rotationDegrees: Int, threshold: Float) = emptyList<Detection>() },
            TargetMatcher(context), PerceptionEngine(TargetMatcher(context), HistogramObjectEmbedder()), repo, voice,
            object : ImageVerifier { override suspend fun verify(fullFrame: FramePacket, cropFrame: FramePacket?, request: CandidateVerificationRequest, references: List<ByteArray>): ImageReview {
                entered.complete(request)
                return answer.await()
            } }, speech, candidates, scope,
        )
        suspend fun start() { core.start(source) }
        fun cleanup() { check(dbName.startsWith("review-safety-")); context.deleteDatabase(dbName); photos.deleteRecursively(); candidates.deleteRecursively() }
    }

    private class FailedVoice : QwenRealtimeClient {
        override val state = MutableStateFlow(RealtimeState.DISCONNECTED)
        val errors = MutableSharedFlow<QwenEvent>(extraBufferCapacity = 8)
        override val events = errors.asSharedFlow()
        var connects = 0
        override suspend fun connect() { connects++; state.value = RealtimeState.FAILED; throw java.io.IOException("injected voice failure") }
        override suspend fun sendFrame(frame: FramePacket, prompt: String) = Unit
        override suspend fun sendText(text: String) = Unit
        override fun setMicrophoneEnabled(enabled: Boolean) = Unit
        override suspend fun interrupt() = Unit
        override suspend fun disconnect() { state.value = RealtimeState.DISCONNECTED }
    }

    private class TestSource(private val scope: CoroutineScope, private val jpeg: ByteArray) : FrameSource {
        override val source = CameraSource.PHONE
        override val state = MutableStateFlow(FrameSourceState.IDLE)
        override val frames = MutableSharedFlow<FramePacket>(replay = 1)
        private var job: Job? = null
        var starts = 0
        override suspend fun start() { starts++; state.value = FrameSourceState.RUNNING; job = scope.launch { var id = 0L; while (isActive) { frames.emit(FramePacket(++id, source, System.currentTimeMillis(), jpeg)); delay(100) } } }
        override suspend fun stop() { job?.cancelAndJoin(); state.value = FrameSourceState.STOPPED }
    }
}
