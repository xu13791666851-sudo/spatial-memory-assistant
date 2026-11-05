package com.spatialmemory.assistant

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.inference.SceneChangeGate
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.Base64
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ImageTransportTest {
    private val request = CandidateVerificationRequest("test-task", "test-candidate", 1, "水杯", null, "cup", .9f, listOf(0f, 0f, 1f, 1f), true)

    @Test fun savedPhotosAndCurrentCandidateAreSentWithoutAnyVoiceSession() = runBlocking {
        ServerSocket(0).use { server ->
            val captured = CompletableDeferred<JSONObject>()
            val worker = launch(Dispatchers.IO) { server.accept().use { socket ->
                captured.complete(readRequest(socket))
                respond(socket, "TARGET_CHECK|visible=true|sameObject=true|direction=画面中央|anchor=桌边|state=清晰|confidence=0.95")
            } }
            val red = image(Color.RED); val blue = image(Color.BLUE); val green = image(Color.GREEN)
            val frame = FramePacket(1, CameraSource.PHONE, System.currentTimeMillis(), red)
            val result = QwenImageVerifier("", "http://127.0.0.1:${server.localPort}").verify(frame, frame, request, listOf(blue, green))
            assertEquals(ImageDecision.CONFIRMED, result.decision)
            val content = captured.await().getJSONArray("messages").getJSONObject(0).getJSONArray("content")
            assertEquals(3, content.length()) // full image, comparison sheet, instructions
            val encoded = content.getJSONObject(1).getJSONObject("image_url").getString("url").substringAfter(',')
            val bytes = Base64.getDecoder().decode(encoded)
            val sheet = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            assertEquals(768, sheet.width); assertEquals(824, sheet.height)
            assertTrue(Color.red(sheet.getPixel(192, 220)) > 230)
            assertTrue(Color.blue(sheet.getPixel(576, 220)) > 230)
            assertTrue(Color.green(sheet.getPixel(192, 632)) > 230)
            sheet.recycle()
            assertTrue(content.getJSONObject(2).getString("text").contains("参考照片不是当前画面"))
            worker.join()
        }
    }

    @Test fun cancellingImageReviewClosesTheUnderlyingHttpRequest() = runBlocking {
        ServerSocket(0).use { server ->
            val entered = CompletableDeferred<Unit>()
            val closed = CompletableDeferred<Boolean>()
            val worker = launch(Dispatchers.IO) { server.accept().use { socket ->
                socket.soTimeout = 5_000
                readRequest(socket); entered.complete(Unit)
                closed.complete(socket.getInputStream().read() == -1)
            } }
            val http = OkHttpClient()
            val frame = FramePacket(1, CameraSource.PHONE, System.currentTimeMillis(), image(Color.BLUE))
            val job = launch { QwenImageVerifier("", "http://127.0.0.1:${server.localPort}", http).verify(frame, frame, request.copy(requiresPersonalMatch = false)) }
            withTimeout(3_000) { entered.await() }
            withTimeout(2_000) { job.cancelAndJoin(); assertTrue(closed.await()) }
            withTimeout(2_000) { while (http.dispatcher.runningCallsCount() != 0) delay(10) }
            worker.join()
        }
    }

    @Test fun missingPersonalReferencesNeverBecomeAGenericPositiveResult() = runBlocking {
        val frame = FramePacket(1, CameraSource.PHONE, 100, image(Color.BLUE))
        val result = QwenImageVerifier("", "http://127.0.0.1:1").verify(frame, frame, request)
        assertEquals(ImageDecision.UNCERTAIN, result.decision)
    }

    @Test fun aSmallCandidateChangeCannotHideInsideAnUnchangedBackground() {
        fun picture(color: Int): ByteArray {
            val bitmap = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GRAY) }
            android.graphics.Canvas(bitmap).drawRect(112f, 112f, 144f, 144f, android.graphics.Paint().apply { this.color = color })
            return try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it); it.toByteArray() } } finally { bitmap.recycle() }
        }
        val first = picture(Color.RED); val second = picture(Color.BLUE)
        val gate = SceneChangeGate()
        val region = listOf(112f / 256, 112f / 256, 144f / 256, 144f / 256)
        assertTrue(SceneChangeGate.meanDifference(gate.signature(first)!!, gate.signature(second)!!) < 18f)
        assertTrue(SceneChangeGate.meanDifference(gate.signature(first, region = region)!!, gate.signature(second, region = region)!!) > 12f)
    }

    @Test fun lowConfidenceImageAnswerDoesNotBecomeConfirmed() = runBlocking {
        ServerSocket(0).use { server ->
            val worker = launch(Dispatchers.IO) { server.accept().use { socket -> readRequest(socket); respond(socket, "TARGET_CHECK|visible=true|sameObject=true|state=清晰|confidence=0.4") } }
            val frame = FramePacket(1, CameraSource.PHONE, 100, image(Color.BLUE))
            assertEquals(ImageDecision.UNCERTAIN, QwenImageVerifier("", "http://127.0.0.1:${server.localPort}").verify(frame, frame, request.copy(requiresPersonalMatch = false)).decision)
            worker.join()
        }
    }

    private fun image(color: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(40, 40, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        return try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it); it.toByteArray() } } finally { bitmap.recycle() }
    }

    private fun readRequest(socket: Socket): JSONObject {
        val input = socket.getInputStream()
        val header = ByteArrayOutputStream()
        while (!header.toString("US-ASCII").endsWith("\r\n\r\n")) {
            val value = input.read(); check(value >= 0); header.write(value); check(header.size() < 8192)
        }
        val size = Regex("Content-Length: ([0-9]+)", RegexOption.IGNORE_CASE).find(header.toString("US-ASCII"))!!.groupValues[1].toInt()
        val bytes = ByteArray(size)
        var count = 0
        while (count < size) { val read = input.read(bytes, count, size - count); check(read > 0); count += read }
        return JSONObject(String(bytes, Charsets.UTF_8))
    }

    private fun respond(socket: Socket, answer: String) {
        val bytes = JSONObject().put("choices", org.json.JSONArray().put(JSONObject().put("message", JSONObject().put("content", answer)))).toString().toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII)); write(bytes); flush() }
    }
}
