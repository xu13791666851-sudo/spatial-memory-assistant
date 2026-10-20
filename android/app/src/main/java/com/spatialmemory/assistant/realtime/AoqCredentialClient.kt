package com.spatialmemory.assistant.realtime

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class AoqRelayEndpoint(val endpoint: String, val port: Int, val routeIndex: Int)
data class AoqCredential(
    val token: String,
    val sid: String,
    val certFingerprint: String,
    val relayEndpoints: List<AoqRelayEndpoint>,
    val workspaceIdHash: String,
    val expiresAtEpochSeconds: Long,
)

class AoqCredentialClient(
    private val baseUrl: String,
    private val http: OkHttpClient = OkHttpClient(),
) {
    suspend fun createSession(accessCode: CharArray): String = withContext(Dispatchers.IO) {
        try {
            val body = JSONObject().put("accessCode", String(accessCode)).toString()
            val json = post("/api/mobile/session", body)
            JSONObject(json).getString("token")
        } finally {
            accessCode.fill('\u0000')
        }
    }

    suspend fun getAoqCredential(sessionToken: String): AoqCredential = withContext(Dispatchers.IO) {
        val json = post("/api/aoq/token", "{}", sessionToken)
        JSONObject(json).let { value ->
            val relays = value.getJSONArray("relayEndpoints")
            AoqCredential(
                token = value.getString("token"),
                sid = value.getString("sid"),
                certFingerprint = value.getString("certFingerprint"),
                relayEndpoints = List(relays.length()) { index -> relays.getJSONObject(index).let {
                    AoqRelayEndpoint(it.getString("endpoint"), it.getInt("port"), it.getInt("routeIndex"))
                } },
                workspaceIdHash = value.optString("workspaceIdHash"),
                expiresAtEpochSeconds = value.getLong("expiresAt"),
            )
        }
    }

    private fun post(path: String, body: String, bearer: String? = null): String {
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .post(body.toRequestBody("application/json".toMediaType()))
            .apply { bearer?.let { header("Authorization", "Bearer $it") } }
            .build()
        return http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("服务请求失败：HTTP ${response.code}")
            response.body?.string() ?: throw IOException("服务返回空响应")
        }
    }
}

class DirectAoqCredentialClient(
    private val apiKey: String,
    private val http: OkHttpClient = OkHttpClient(),
) {
    suspend fun getAoqCredential(): AoqCredential = withContext(Dispatchers.IO) {
        require(apiKey.isNotBlank()) { "本机构建未配置 QWEN_API_KEY" }
        val request = Request.Builder()
            .url("https://maas.qianwenaiapi.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime")
            .header("Authorization", "Bearer $apiKey")
            .header("x-dashscope-rtc-transport", "moq")
            .post("{}".toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("千问临时凭证请求失败：HTTP ${response.code}")
            parseDirectCredential(response.body?.string() ?: throw IOException("千问临时凭证为空"))
        }
    }
}

internal fun parseDirectCredential(json: String): AoqCredential = JSONObject(json).let { value ->
    val relays = value.getJSONArray("clientRelayEndpoints")
    AoqCredential(
        token = value.getString("aoqTokenForClient"),
        sid = value.getString("sid"),
        certFingerprint = value.getString("clientRelayCertFingerprint"),
        relayEndpoints = List(relays.length()) { index -> relays.getJSONObject(index).let {
            AoqRelayEndpoint(it.getString("endpoint"), it.getInt("port"), it.optInt("route_index", index))
        } },
        workspaceIdHash = value.optJSONObject("extraInfo")?.optString("workspaceIdHash").orEmpty(),
        expiresAtEpochSeconds = System.currentTimeMillis() / 1000 + value.optLong("sidExpiresInSecs", 7200),
    )
}
