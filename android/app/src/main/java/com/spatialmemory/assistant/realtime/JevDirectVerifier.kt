package com.spatialmemory.assistant.realtime

import com.spatialmemory.assistant.camera.FramePacket
import com.spatialmemory.assistant.BuildConfig
import java.io.IOException
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
import org.json.JSONObject

class JevDirectException(val httpStatus: Int, message: String) : IOException(message)

/** Tablet -> selected official endpoint. Credentials are supplied at runtime only. */
class JevDirectVerifier(
    private val keyProvider: () -> String?,
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build(),
    private val endpoint: String? = null,
    private val provider: JevProvider = JevProvider.TYPESAFE,
) : ImageVerifier {
    override suspend fun verify(fullFrame: FramePacket, cropFrame: FramePacket?, request: CandidateVerificationRequest, references: List<ByteArray>): ImageReview = withContext(Dispatchers.IO) {
        if (request.requiresPersonalMatch && references.isEmpty()) return@withContext ImageReview(ImageDecision.UNCERTAIN, null, "缺少这件物品的参考照片")
        val key = keyProvider()?.takeIf { it.matches(provider.keyPattern) } ?: throw JevDirectException(0, "请先配置 ${provider.label} 密钥")
        val body = JevDirectProtocol.payload(fullFrame, cropFrame, request, references, provider.requestModel).toString()
        currentCoroutineContext().ensureActive()
        val builder = Request.Builder().url(endpoint ?: provider.endpoint).header("Authorization", "Bearer $key")
            .header("Accept", "application/json").header("User-Agent", "I-SEE-YOU/${BuildConfig.VERSION_NAME}")
        if (provider == JevProvider.TYPESAFE) builder.header("TypeSafe-Danger-Zone-Images", "true")
        val call = http.newCall(builder.post(body.toRequestBody("application/json".toMediaType())).build())
        val raw = call.directResponse(provider)
        currentCoroutineContext().ensureActive()
        try { JevDirectProtocol.parse(JSONObject(raw), request, cropFrame != null, references.isNotEmpty(), provider.responseModels) }
        catch (error: Exception) { ImageReview(ImageDecision.UNCERTAIN, null, "PROTOCOL_INVALID") }
    }
}

private suspend fun Call.directResponse(provider: JevProvider): String = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) { if (continuation.isActive) continuation.resumeWith(Result.failure(error)) }
        override fun onResponse(call: Call, response: Response) {
            val result = runCatching { response.use {
                if (!it.isSuccessful) throw JevDirectException(it.code, when (it.code) {
                    401 -> "${provider.label} 密钥未通过验证"
                    402 -> "${provider.label} 账号额度不足"
                    403 -> "${provider.label} 暂未允许这次调用"
                    451 -> "${provider.label} 本次调用受到地区限制"
                    429 -> "Jev 请求较频繁，请稍后重试"
                    in 300..399 -> "Jev 地址发生跳转，本次未发送密钥到其他地址"
                    else -> "Jev 直连暂未完成（HTTP ${it.code}）"
                })
                val body = it.body ?: throw IOException("Jev 返回空响应")
                body.source().request(65_537)
                if (body.source().buffer.size > 65_536) throw IOException("Jev 返回内容过大")
                body.string()
            } }
            if (continuation.isActive) continuation.resumeWith(result)
        }
    })
}
