package com.spatialmemory.assistant.realtime

import com.spatialmemory.assistant.camera.FramePacket
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject

/** Sends stills to our gateway. No provider key and no realtime/voice connection. */
class JevImageVerifier(
    private val gateway: String,
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build(),
) : ImageVerifier {
    override suspend fun verify(fullFrame: FramePacket, cropFrame: FramePacket?, request: CandidateVerificationRequest, references: List<ByteArray>): ImageReview = withContext(Dispatchers.IO) {
        if (request.requiresPersonalMatch && references.isEmpty()) return@withContext ImageReview(ImageDecision.UNCERTAIN, null, "缺少这件物品的参考照片")
        require(references.size <= 3)
        fun encoded(bytes: ByteArray, rotation: Int, longest: Int = 768) = Base64.getEncoder().encodeToString(JevReviewImages.prepare(bytes, rotation, longest))
        val body = JSONObject().put("taskId", request.taskId).put("candidateId", request.candidateId).put("frameId", request.frameId)
            .put("target", request.target).put("description", request.description ?: JSONObject.NULL)
            .put("learning", request.learning).put("requiresPersonalMatch", request.requiresPersonalMatch)
            .put("box", JSONArray(request.normalizedBox)).put("scene", encoded(fullFrame.jpeg, fullFrame.rotationDegrees, 960))
            .put("candidate", cropFrame?.let { encoded(it.jpeg, it.rotationDegrees) } ?: JSONObject.NULL)
            .put("references", JSONArray(references.map { encoded(it, 0) })).toString()
        currentCoroutineContext().ensureActive()
        val call = http.newCall(Request.Builder().url(gateway.trimEnd('/') + "/api/android/review")
            .post(body.toRequestBody("application/json".toMediaType())).build())
        val answer = JSONObject(call.awaitReview())
        if (answer.optString("provider") != "jev" || answer.optString("model") != "jev-1.14.0" ||
            answer.optString("taskId") != request.taskId || answer.optString("candidateId") != request.candidateId ||
            answer.optLong("frameId", -1) != request.frameId) return@withContext ImageReview(ImageDecision.UNCERTAIN, null, "图片结果与当前任务不一致")
        val decision = runCatching { ImageDecision.valueOf(answer.getString("decision")) }.getOrNull()
            ?: return@withContext ImageReview(ImageDecision.UNCERTAIN, null, "图片结果不完整")
        val confidence = (answer.opt("confidence") as? Number)?.toFloat()
        val visible = answer.opt("visible") as? Boolean
        val same = answer.opt("sameObject") as? Boolean
        if (confidence == null || !confidence.isFinite() || confidence !in 0f..1f || visible == null || same == null ||
            (decision == ImageDecision.CONFIRMED && (!visible || !same || confidence < .8f)))
            return@withContext ImageReview(ImageDecision.UNCERTAIN, null, "图片结果不能确定")
        val direction = answer.optString("direction").takeIf { it in setOf("画面左侧", "画面中央", "画面右侧") }
        val result = QwenEvent.TargetVisible(request.taskId, request.candidateId, request.frameId,
            decision == ImageDecision.CONFIRMED, decision == ImageDecision.CONFIRMED, direction, null,
            if (decision == ImageDecision.UNCERTAIN) "uncertain" else if (decision == ImageDecision.CONFIRMED) "清晰" else "未匹配", confidence)
        ImageReview(decision, result)
    }
}

private suspend fun Call.awaitReview(): String = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) { if (continuation.isActive) continuation.resumeWith(Result.failure(error)) }
        override fun onResponse(call: Call, response: Response) {
            val result = runCatching { response.use {
                if (!it.isSuccessful) throw IOException("图片复核未完成：HTTP ${it.code}")
                val body = it.body ?: throw IOException("图片复核返回空响应")
                body.source().request(16_385)
                if (body.source().buffer.size > 16_384) throw IOException("图片复核返回过大")
                body.string()
            } }
            if (continuation.isActive) continuation.resumeWith(result)
        }
    })
}
