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
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in network check; uses only the non-private bus fixture, never a live camera. */
class StandaloneGatewayTest {
    @Test fun realGatewayAcceptsReferenceComparisonWithoutRealtimeConnection() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("externalVision") == "true")
        val instrument = InstrumentationRegistry.getInstrumentation()
        val context = ApplicationProvider.getApplicationContext<Context>()
        val jpeg = instrument.context.assets.open("bus.jpg").use { it.readBytes() }
        val frame = FramePacket(1, CameraSource.PHONE, System.currentTimeMillis(), jpeg)
        val request = CandidateVerificationRequest("gateway-smoke", "bus-fixture", 1, "公交车", "参考照片中的同一辆公交车", "bus", 0f, listOf(0f, 0f, 1f, 1f), true)
        val started = System.currentTimeMillis()
        // Optional override is confined to this test; URL, SNI and certificate checks
        // retain the real service hostname. The production client uses system DNS.
        val address = InstrumentationRegistry.getArguments().getString("gatewayIpv4")
        val http = OkHttpClient.Builder().callTimeout(15, java.util.concurrent.TimeUnit.SECONDS).apply {
            if (address != null) dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    if (hostname == "i-see-you-android-core-test.pages.dev") listOf(InetAddress.getByAddress(hostname, address.split('.').map { it.toInt().toByte() }.toByteArray()))
                    else Dns.SYSTEM.lookup(hostname)
            })
        }.build()
        val result = QwenImageVerifier("", BuildConfig.GATEWAY_URL, http).verify(frame, frame, request, listOf(jpeg, jpeg, jpeg))
        val report = JSONObject().put("fixture", "bus.jpg").put("realtimeSessionCreated", false)
            .put("latencyMs", System.currentTimeMillis() - started).put("decision", result.decision.name)
            .put("confidence", result.result?.confidence).put("reason", result.reason).put("testDnsOverrideUsed", address != null)
        File(context.filesDir, "standalone-gateway-smoke.json").writeText(report.toString(2))
        assertEquals(report.toString(), ImageDecision.CONFIRMED, result.decision)
        assertEquals("gateway-smoke", result.result!!.taskId)
    }
}
