package com.spatialmemory.assistant.hardware

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class Esp32Connection(
    val baseUrl: String,
    val streamUrl: String = baseUrl.trimEnd('/') + "/stream",
    val deviceId: String = "",
    val token: String = "",
    val legacyCameraWebServer: Boolean = false,
)

class Esp32Api(
    val connection: Esp32Connection,
    private val http: OkHttpClient = OkHttpClient(),
) : DeviceControl {
    private val mutableStatus = MutableStateFlow(HardwareStatus(false, false, "尚未连接"))
    override val status = mutableStatus.asStateFlow()

    override suspend fun refresh(): HardwareStatus = withContext(Dispatchers.IO) {
        execute(Request.Builder().url(url(if (connection.legacyCameraWebServer) "/status" else "/api/status")).get()).use { response ->
            if (!response.isSuccessful) throw IOException("ESP32 状态请求失败：HTTP ${response.code}")
            if (connection.legacyCameraWebServer) return@use HardwareStatus(true, mutableStatus.value.cameraRunning, "兼容 Arduino CameraWebServer").also { mutableStatus.value = it }
            val value = JSONObject(response.body?.string() ?: throw IOException("ESP32 状态为空"))
            val actualId = value.getString("deviceId")
            if (connection.deviceId.isNotBlank() && actualId != connection.deviceId) {
                throw IOException("设备身份不匹配：期望 ${connection.deviceId}，实际 $actualId")
            }
            HardwareStatus(
                connected = value.optJSONObject("wifi")?.optBoolean("connected") == true,
                cameraRunning = value.optJSONObject("camera")?.optString("state") == "streaming",
                detail = "$actualId / ${value.optString("firmwareVersion", "未知固件")}",
            ).also { mutableStatus.value = it }
        }
    }

    override suspend fun startCamera() = command("/api/camera/start", true)
    override suspend fun stopCamera() = command("/api/camera/stop", false)

    fun streamRequest(): Request = authorized(Request.Builder().url(connection.streamUrl)).get().build()

    private suspend fun command(path: String, running: Boolean) = withContext(Dispatchers.IO) {
        if (connection.legacyCameraWebServer) {
            mutableStatus.value = HardwareStatus(true, running, if (running) "兼容模式：视频流工作中" else "兼容模式：连接已关闭")
            return@withContext
        }
        val body = ByteArray(0).toRequestBody("application/json".toMediaType())
        execute(Request.Builder().url(url(path)).post(body)).use { response ->
            if (!response.isSuccessful) throw IOException("ESP32 控制失败：HTTP ${response.code}")
            mutableStatus.value = mutableStatus.value.copy(connected = true, cameraRunning = running, detail = if (running) "摄像头工作中" else "摄像头待机")
        }
    }

    private fun execute(builder: Request.Builder) = http.newCall(authorized(builder).build()).execute()
    private fun authorized(builder: Request.Builder) = builder.apply {
        if (connection.token.isNotBlank()) header("X-Device-Token", connection.token)
    }
    private fun url(path: String) = connection.baseUrl.trimEnd('/') + path
}
