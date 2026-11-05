package com.spatialmemory.assistant

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.realtime.*
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.Base64
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class JevTransportTest {
    private val request = CandidateVerificationRequest("jev-task", "candidate", 42, "水杯", "蓝色，有独特花纹", "cup", .9f, listOf(.1f, .1f, .5f, .8f), true)
    private fun image(color: Int, width: Int = 40, height: Int = 60): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        return try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it); it.toByteArray() } } finally { bitmap.recycle() }
    }
    private fun read(socket: Socket): JSONObject {
        val input = socket.getInputStream(); val header = ByteArrayOutputStream()
        while (!header.toString("US-ASCII").endsWith("\r\n\r\n")) { val value = input.read(); check(value >= 0); header.write(value); check(header.size() < 8192) }
        val size = Regex("Content-Length: ([0-9]+)", RegexOption.IGNORE_CASE).find(header.toString("US-ASCII"))!!.groupValues[1].toInt()
        val bytes = ByteArray(size); var count = 0
        while (count < size) { val n = input.read(bytes, count, size - count); check(n > 0); count += n }
        return JSONObject(String(bytes, Charsets.UTF_8))
    }
    private fun reply(socket: Socket, answer: JSONObject) {
        val bytes = answer.toString().toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII)); write(bytes); flush() }
    }
    private fun answer() = JSONObject().put("provider", "jev").put("model", "jev-1.14.0").put("taskId", request.taskId)
        .put("candidateId", request.candidateId).put("frameId", request.frameId).put("decision", "CONFIRMED")
        .put("visible", true).put("sameObject", true).put("confidence", .95).put("direction", "画面左侧")

    @Test fun currentImagesAndReferencesRemainSeparateAndSmallImagesArePadded() = runBlocking {
        ServerSocket(0).use { server ->
            val captured = CompletableDeferred<JSONObject>()
            val worker = launch(Dispatchers.IO) { server.accept().use { captured.complete(read(it)); reply(it, answer()) } }
            val frame = FramePacket(42, CameraSource.PHONE, System.currentTimeMillis(), image(Color.RED), 90)
            val result = JevImageVerifier("http://127.0.0.1:${server.localPort}").verify(frame, frame.copy(rotationDegrees = 0), request, listOf(image(Color.BLUE), image(Color.GREEN)))
            assertEquals(ImageDecision.CONFIRMED, result.decision)
            val body = captured.await(); assertFalse(body.has("apiKey")); assertFalse(body.has("questions")); assertFalse(body.has("model"))
            fun checkImage(encoded: String, color: Int) {
                val bytes = Base64.getDecoder().decode(encoded);val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                assertTrue(bitmap.width in 280..1568);assertTrue(bitmap.height in 280..1568)
                val pixel = bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)
                assertTrue(kotlin.math.abs(Color.red(pixel) - Color.red(color)) < 15)
                assertTrue(kotlin.math.abs(Color.blue(pixel) - Color.blue(color)) < 15)
                assertTrue(kotlin.math.abs(Color.green(pixel) - Color.green(color)) < 15);bitmap.recycle()
            }
            checkImage(body.getString("scene"), Color.RED);checkImage(body.getString("candidate"), Color.RED)
            checkImage(body.getJSONArray("references").getString(0), Color.BLUE);checkImage(body.getJSONArray("references").getString(1), Color.GREEN)
            worker.join()
        }
    }

    @Test fun rotatedPixelsAreUprightAndLargeImagesAreDownscaledWithinProviderLimits() = runBlocking {
        ServerSocket(0).use { server ->
            val captured = CompletableDeferred<JSONObject>()
            val worker = launch(Dispatchers.IO) { server.accept().use { captured.complete(read(it));reply(it, answer()) } }
            val frame = FramePacket(42, CameraSource.PHONE, 100, image(Color.BLUE, 2000, 1000), 90)
            JevImageVerifier("http://127.0.0.1:${server.localPort}").verify(frame, null, request.copy(requiresPersonalMatch = false))
            val bytes = Base64.getDecoder().decode(captured.await().getString("scene"));val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            assertEquals(480, bitmap.width);assertEquals(960, bitmap.height);bitmap.recycle();worker.join()
        }
    }

    @Test fun missingPersonalReferenceStopsBeforeNetworkUse() = runBlocking {
        val frame = FramePacket(42, CameraSource.PHONE, 100, image(Color.BLUE))
        assertEquals(ImageDecision.UNCERTAIN, JevImageVerifier("http://127.0.0.1:1").verify(frame, frame, request).decision)
    }

    @Test fun wrongTaskLowConfidenceOrContradictoryAnswersCannotConfirm() = runBlocking {
        val frame = FramePacket(42, CameraSource.PHONE, 100, image(Color.BLUE))
        for (patch in listOf("taskId" to "other", "candidateId" to "other", "frameId" to 1, "confidence" to .2, "confidence" to "0.99", "visible" to false, "sameObject" to false, "model" to "other")) {
            ServerSocket(0).use { server ->
                val worker = launch(Dispatchers.IO) { server.accept().use { read(it);reply(it, answer().put(patch.first, patch.second)) } }
                assertEquals(patch.toString(), ImageDecision.UNCERTAIN, JevImageVerifier("http://127.0.0.1:${server.localPort}").verify(frame, frame, request, listOf(frame.jpeg)).decision)
                worker.join()
            }
        }
    }

    @Test fun uncertainResultStaysUncertain() = runBlocking {
        ServerSocket(0).use { server ->
            val worker = launch(Dispatchers.IO) { server.accept().use { read(it);reply(it, answer().put("decision", "UNCERTAIN").put("visible", false).put("sameObject", false).put("confidence", .5)) } }
            val frame = FramePacket(42, CameraSource.PHONE, 100, image(Color.BLUE))
            assertEquals(ImageDecision.UNCERTAIN, JevImageVerifier("http://127.0.0.1:${server.localPort}").verify(frame, frame, request, listOf(frame.jpeg)).decision)
            worker.join()
        }
    }

    @Test fun cancellingJevReviewClosesTheHttpCall() = runBlocking {
        ServerSocket(0).use { server ->
            val entered = CompletableDeferred<Unit>(); val closed = CompletableDeferred<Boolean>()
            val worker = launch(Dispatchers.IO) { server.accept().use { socket -> socket.soTimeout = 5_000;read(socket);entered.complete(Unit);closed.complete(socket.getInputStream().read() == -1) } }
            val frame = FramePacket(42, CameraSource.PHONE, 100, image(Color.BLUE));val http = OkHttpClient()
            val job = launch { JevImageVerifier("http://127.0.0.1:${server.localPort}", http).verify(frame, frame, request, listOf(frame.jpeg)) }
            withTimeout(3_000) { entered.await() };withTimeout(2_000) { job.cancelAndJoin();assertTrue(closed.await()) }
            withTimeout(2_000) { while (http.dispatcher.runningCallsCount() != 0) delay(10) };worker.join()
        }
    }
}
