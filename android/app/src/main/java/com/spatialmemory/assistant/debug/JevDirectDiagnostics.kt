package com.spatialmemory.assistant.debug

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.spatialmemory.assistant.BuildConfig
import com.spatialmemory.assistant.camera.CameraSource
import com.spatialmemory.assistant.camera.FramePacket
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.security.JevKeyStore
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.UnknownHostException
import java.net.SocketTimeoutException
import javax.net.ssl.SSLException
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

/** Uses a generated non-private card. Never starts a camera, microphone or Qwen. */
object JevDirectDiagnostics {
    suspend fun run(store: JevKeyStore): JSONObject {
        val provider = store.provider
        val report = JSONObject().put("path", "tablet-direct-${provider.id}").put("model", provider.requestModel)
            .put("cameraUsed", false).put("microphoneUsed", false).put("qwenSessionCreated", false)
            .put("fixture", "generated-orange-square").put("passed", false)
        val revision = store.revision() ?: return report.put("message", "请先保存 Jev 密钥").put("failureKind", "missing_key")
        store.clearVerification()
        val bitmap = Bitmap.createBitmap(360, 360, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).apply {
            drawColor(Color.WHITE)
            drawRect(70f, 70f, 290f, 290f, Paint().apply { color = Color.rgb(255, 128, 0) })
            drawRect(90f, 90f, 120f, 140f, Paint().apply { color = Color.BLACK })
        }
        val jpeg = try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it);it.toByteArray() } } finally { bitmap.recycle() }
        val results = JSONArray();report.put("results", results)
        try {
            val verifier = JevDirectVerifier(store::read, provider = provider)
            for (personal in listOf(false, true)) {
                currentCoroutineContext().ensureActive()
                val started = System.currentTimeMillis()
                val frame = FramePacket(if (personal) 2 else 1, CameraSource.PHONE, started, jpeg)
                val request = CandidateVerificationRequest("direct-connectivity", if (personal) "references" else "image", frame.id,
                    "橙色正方形 (orange square)", "A large orange square with a small black mark on its upper left, on a white background.", "semantic", 0f, listOf(0f, 0f, 1f, 1f), personal)
                val result = withTimeout(15_000) { verifier.verify(frame, frame, request, if (personal) listOf(jpeg, jpeg, jpeg) else emptyList()) }
                report.put("httpStatus", 200).put("connectionSucceeded", true)
                results.put(JSONObject().put("referenceComparison", personal).put("latencyMs", System.currentTimeMillis() - started)
                    .put("decision", result.decision.name).put("confidence", result.result?.confidence ?: JSONObject.NULL))
                if (result.decision != ImageDecision.CONFIRMED) return report.put("message", "已连接 Jev，但测试图片暂未获确认").put("failureKind", "test_uncertain")
            }
            if (revision != store.revision()) return report.put("message", "密钥已变更，请重新测试").put("failureKind", "key_changed")
            store.markVerified(revision)
            return report.put("passed", true).put("message", "Jev 平板直连和参考图复核均已通过")
        } catch (error: TimeoutCancellationException) {
            return report.put("message", "Jev 直连等待超时").put("failureKind", "timeout")
        } catch (error: CancellationException) { throw error }
        catch (error: JevDirectException) {
            return report.put("httpStatus", error.httpStatus).put("failureKind", if (error.httpStatus == 451) "region_restricted" else "http_error").put("message", error.message)
        } catch (error: Exception) {
            val kind = when (error) { is UnknownHostException -> "dns";is SocketTimeoutException -> "timeout";is SSLException -> "tls";else -> "network" }
            return report.put("failureKind", kind).put("message", "Jev 直连未完成，请检查平板网络后重试")
        }
    }

    /** Debug-only, package-scoped encrypted provisioning; no credential in intents. */
    fun handle(activity: ComponentActivity, intent: Intent?, beforeChange: suspend () -> Unit): Job? {
        if (!BuildConfig.DEBUG || activity.packageName != "com.spatialmemory.assistant.iseeyou.tablettest.debug") return null
        // Android 13 enforces exported activity intent filters. Use the normal
        // launcher action, with private-permit-gated debug extras, not an
        // undeclared custom action that the OS rejects before starting the app.
        if (intent?.action != Intent.ACTION_MAIN) return null
        val action = intent.getStringExtra("jev_command") ?: return null
        if (action !in setOf("PREPARE", "IMPORT", "CHECK", "ENABLE")) return null
        // A separate fresh permit must have been placed in this app's private
        // directory by the authorized debug host. Other apps cannot arm intents.
        val permitFile = File(activity.filesDir, "jev-debug-permit.json")
        val permitted = runCatching {
            require(permitFile.length() in 1..1024)
            val permit = JSONObject(permitFile.readText())
            val expiry = permit.getLong("expiresAt")
            permit.getString("permit") == intent.getStringExtra("permit") && expiry - System.currentTimeMillis() in 0..60_000
        }.getOrDefault(false)
        if (!permitted) return null
        permitFile.delete() // Only the host's one-use permit in our own directory.
        val provider = JevProvider.fromId(intent.getStringExtra("jev_provider") ?: "typesafe") ?: return null
        val store = JevKeyStore(activity, provider = provider)
        val nonce = intent.getStringExtra("nonce").orEmpty()
        return activity.lifecycleScope.launch {
            beforeChange()
            when (action) {
                "PREPARE" -> File(activity.filesDir, "jev-import-public.json").writeText(store.prepareImport().toString())
                "IMPORT" -> {
                    val envelope = File(activity.filesDir, "jev-key-import.json")
                    val result = JSONObject().put("nonce", nonce).put("imported", false)
                    try {
                        require(envelope.length() in 1..4096)
                        val body = JSONObject(envelope.readText());require(body.optString("nonce") == nonce)
                        store.importEncrypted(body);result.put("imported", true)
                    } catch (error: Exception) { result.put("error", "encrypted_import_rejected") }
                    finally { envelope.delete() } // Only our own encrypted one-use envelope.
                    File(activity.filesDir, "jev-import-result.json").writeText(result.toString())
                }
                "CHECK" -> {
                    if (!store.allowsDebugTest(nonce)) return@launch
                    val destination = File(activity.filesDir, "jev-direct-result.json")
                    destination.writeText(JSONObject().put("nonce", nonce).put("phase", "running").toString())
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    try { destination.writeText(run(store).put("nonce", nonce).put("phase", "complete").toString(2)) }
                    finally { activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
                }
                "ENABLE" -> if (store.allowsDebugTest(nonce) && store.isVerified())
                    activity.getSharedPreferences("iseeyou-native", Context.MODE_PRIVATE).edit().putString("vision-review", provider.reviewMode).putString("jev-settings-provider", provider.id).apply()
            }
        }
    }
}
