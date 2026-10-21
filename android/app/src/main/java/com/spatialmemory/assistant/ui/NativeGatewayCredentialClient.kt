package com.spatialmemory.assistant.ui

import com.spatialmemory.assistant.realtime.AoqCredential
import com.spatialmemory.assistant.realtime.parseDirectCredential
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal class NativeGatewayCredentialClient(private val base: String) {
    suspend fun get(): AoqCredential = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(base + "/api/android/credential")
            .post("{}".toRequestBody("application/json".toMediaType())).build()
        OkHttpClient().newCall(request).execute().use { response ->
            check(response.isSuccessful) { "千问临时连接未完成" }
            parseDirectCredential(checkNotNull(response.body).string())
        }
    }
}
