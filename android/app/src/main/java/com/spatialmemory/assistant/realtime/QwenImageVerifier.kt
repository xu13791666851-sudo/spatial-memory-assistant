package com.spatialmemory.assistant.realtime

import com.spatialmemory.assistant.camera.FramePacket
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

class QwenImageVerifier(
    private val apiKey: String,
    private val gateway: String? = null,
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build(),
) : ImageVerifier {
    override suspend fun verify(fullFrame: FramePacket, cropFrame: FramePacket?, request: CandidateVerificationRequest, references: List<ByteArray>): ImageReview = withContext(Dispatchers.IO) {
        if (request.requiresPersonalMatch && references.isEmpty()) return@withContext ImageReview(ImageDecision.UNCERTAIN, null, "缺少这件物品的参考照片")
        require(apiKey.isNotBlank() || gateway != null) { "本机构建未配置 QWEN_API_KEY" }
        val content = JSONArray().put(image(ReviewImages.upright(fullFrame.jpeg, fullFrame.rotationDegrees)))
        if (references.isNotEmpty()) content.put(image(ReviewImages.comparison(cropFrame?.jpeg, references.take(3))))
        else cropFrame?.let { content.put(image(ReviewImages.upright(it.jpeg, it.rotationDegrees))) }
        currentCoroutineContext().ensureActive()
        content.put(JSONObject().put("type", "text").put("text", prompt(request, cropFrame != null, references.size)))
        val body = JSONObject()
            .put("model", "qwen3.8-omni-flash")
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
            .put("modalities", JSONArray().put("text"))
            .put("stream", false)
            .put("enable_thinking", false)
            .put("max_tokens", 120)
            .toString()
        val call = http.newCall(Request.Builder()
            .url(gateway?.trimEnd('/')?.plus("/api/android/image") ?: "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions")
            .apply { if (gateway == null) header("Authorization", "Bearer $apiKey") }
            .post(body.toRequestBody("application/json".toMediaType()))
            .build())
        val json = JSONObject(call.awaitText())
        val answer = json.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content")
        val parsed = VerificationTextParser.parse(answer, request)
            ?: return@withContext ImageReview(ImageDecision.UNCERTAIN, null, "复核结果不完整")
        val uncertain = parsed.confidence < 0.8f || Regex("uncertain|ambiguous|不确定|无法|模糊|多个", RegexOption.IGNORE_CASE).containsMatchIn(parsed.objectState.orEmpty())
        val decision = when {
            uncertain -> ImageDecision.UNCERTAIN
            parsed.visible && parsed.sameObject -> ImageDecision.CONFIRMED
            else -> ImageDecision.REJECTED
        }
        ImageReview(decision, parsed)
    }

    private fun image(jpeg: ByteArray) = JSONObject()
        .put("type", "image_url")
        .put("image_url", JSONObject().put("url", "data:image/jpeg;base64,${Base64.getEncoder().encodeToString(jpeg)}"))

    private fun prompt(request: CandidateVerificationRequest, hasCrop: Boolean, referenceCount: Int) = buildString {
        append("目标是“${request.target}”。")
        append("图1是当前完整画面。")
        if (referenceCount > 0) {
            append("图2是对比拼图，左上CURRENT CANDIDATE是当前候选，其他格REFERENCE是参考照片；参考照片不是当前画面。")
            if (!hasCrop) append("当前没有候选裁剪，只能在图1中寻找对应物体。")
            if (request.learning) append("正在检查新采集样本：候选和每张参考必须清晰呈现目标且属于同一个实物，背景、遮挡或无法证明同一件时返回state=uncertain。")
            else append("必须对照参考图的颜色、形状和具体细节确认同一个实物，仅同类或颜色相似不算；看不清、候选多个或细节不足时返回state=uncertain。")
        } else if (hasCrop) append("图2是当前候选裁剪。")
        append("必须仅根据物体外观判断，不得把YOLO类别当作事实。")
        if (hasCrop) append("只确认候选裁剪中的物体，不得用完整画面里别的同类物品替代。")
        append("候选类别=${request.label}，置信度=${request.confidence}，框=${request.normalizedBox}，记忆描述=${request.description.orEmpty()}。")
        append("direction只能说画面左侧、中央、右侧，不推测距离。只输出一行 TARGET_CHECK|visible=true或false|sameObject=true或false|direction=位置|anchor=参照物|state=状态或uncertain|confidence=0到1，并将各值替换为实际判断。")
    }
}

private suspend fun Call.awaitText(): String = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) { if (continuation.isActive) continuation.resumeWith(Result.failure(error)) }
        override fun onResponse(call: Call, response: Response) {
            val result = runCatching { response.use {
                if (!it.isSuccessful) throw IOException("图片复核失败：HTTP ${it.code}")
                it.body?.string() ?: throw IOException("图片复核返回空响应")
            } }
            if (continuation.isActive) continuation.resumeWith(result)
        }
    })
}
