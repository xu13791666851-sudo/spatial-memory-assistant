package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.realtime.*
import java.io.File
import java.net.InetAddress
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Dns
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in real Jev calls with a public fixture, no microphone, camera or Qwen session. */
class StandaloneJevTest {
    @Test fun realJevReviewsReferencesAndDoesNotConfirmAnAbsentTarget() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("externalJev") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = ApplicationProvider.getApplicationContext<Context>()
        val jpeg = instrumentation.context.assets.open("bus.jpg").use { it.readBytes() }
        val address = InstrumentationRegistry.getArguments().getString("gatewayIpv4")
        val http = OkHttpClient.Builder().callTimeout(15, java.util.concurrent.TimeUnit.SECONDS).apply {
            if (address != null) dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    if (hostname == "i-see-you-android-core-test.pages.dev") listOf(InetAddress.getByAddress(hostname, address.split('.').map { it.toInt().toByte() }.toByteArray())) else Dns.SYSTEM.lookup(hostname)
            })
        }.build()
        val reports = JSONArray()
        suspend fun check(target: String, personal: Boolean): ImageReview {
            val started = System.currentTimeMillis()
            val frame = FramePacket(101, CameraSource.PHONE, started, jpeg)
            val request = CandidateVerificationRequest("jev-live", "fixture", 101, target, if (personal) "参考照片中的同一辆公交车" else null, "semantic", 0f, listOf(0f, 0f, 1f, 1f), personal)
            val result = JevImageVerifier(BuildConfig.GATEWAY_URL, http).verify(frame, null, request, if (personal) listOf(jpeg, jpeg, jpeg) else emptyList())
            reports.put(JSONObject().put("target", target).put("personal", personal).put("latencyMs", System.currentTimeMillis() - started).put("decision", result.decision.name).put("confidence", result.result?.confidence).put("reason", result.reason))
            File(context.filesDir, "standalone-jev-smoke.json").writeText(JSONObject().put("model", "jev-1.14.0").put("fixture", "bus.jpg").put("qwenSessionCreated", false).put("testDnsOverrideUsed", address != null).put("results", reports).toString(2))
            return result
        }
        assertEquals(ImageDecision.CONFIRMED, check("公交车", true).decision)
        assertNotEquals(ImageDecision.CONFIRMED, check("蓝色陶瓷水杯", false).decision)
    }
}
