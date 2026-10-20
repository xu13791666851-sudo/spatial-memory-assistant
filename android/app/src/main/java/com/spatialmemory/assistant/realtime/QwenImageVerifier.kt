package com.spatialmemory.assistant.realtime

import com.spatialmemory.assistant.camera.FramePacket
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

class QwenImageVerifier(
    private val apiKey: String,
    private val gateway: String? = null,
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build(),
) {
    suspend fun verify(fullFrame: FramePacket, cropFrame: FramePacket?, request: CandidateVerificationRequest): QwenEvent.TargetVisible = withContext(Dispatchers.IO) {
        require(apiKey.isNotBlank() || gateway != null) { "本机构建未配置 QWEN_API_KEY" }
        val content = JSONArray().put(image(fullFrame.jpeg))
        cropFrame?.let { content.put(image(it.jpeg)) }
        content.put(JSONObject().put("type", "text").put("text", prompt(request, cropFrame != null)))
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
        call.execute().use { response ->
            if (!response.isSuccessful) throw IOException("千问图片确认失败：HTTP ${response.code}")
            val json = JSONObject(response.body?.string() ?: throw IOException("千问图片确认返回空响应"))
            val answer = json.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content")
            VerificationTextParser.parse(answer, request) ?: throw IOException("千问图片确认返回格式无法解析")
        }
    }

    private fun image(jpeg: ByteArray) = JSONObject()
        .put("type", "image_url")
        .put("image_url", JSONObject().put("url", "data:image/jpeg;base64,${Base64.getEncoder().encodeToString(jpeg)}"))

    private fun prompt(request: CandidateVerificationRequest, hasCrop: Boolean) = buildString {
        append("目标是“${request.target}”。")
        append(if (hasCrop) "图1是完整画面，图2是YOLO候选裁剪。" else "请检查完整画面。")
        append("必须仅根据物体外观判断，不得把YOLO类别当作事实。")
        append("候选类别=${request.label}，置信度=${request.confidence}，框=${request.normalizedBox}，记忆描述=${request.description.orEmpty()}。")
        append("只输出一行 TARGET_CHECK|visible=true或false|sameObject=true或false|direction=位置|anchor=参照物|state=状态|confidence=0到1，并将各值替换为实际判断。")
    }
}
