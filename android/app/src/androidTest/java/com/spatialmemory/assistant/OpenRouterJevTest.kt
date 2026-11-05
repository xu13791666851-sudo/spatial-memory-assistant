package com.spatialmemory.assistant

import android.graphics.Bitmap
import android.graphics.Color
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.realtime.*
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OpenRouterJevTest {
    private val key = "sk-or-v1-" + "a".repeat(64)
    private val request = CandidateVerificationRequest("or-task", "candidate", 7, "水杯", "带花纹", "cup", .9f, listOf(.1f, .1f, .8f, .9f), true)
    private fun frame(): FramePacket {
        val bitmap = Bitmap.createBitmap(300, 300, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.BLUE) }
        val jpeg = try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it);it.toByteArray() } } finally { bitmap.recycle() }
        return FramePacket(7, CameraSource.PHONE, 100, jpeg)
    }
    private fun read(socket: Socket): Pair<String, JSONObject> {
        val input = socket.getInputStream();val header = ByteArrayOutputStream()
        while (!header.toString("US-ASCII").endsWith("\r\n\r\n")) { val b = input.read();check(b >= 0);header.write(b);check(header.size() < 8192) }
        val headers = header.toString("US-ASCII")
        val size = Regex("Content-Length: ([0-9]+)", RegexOption.IGNORE_CASE).find(headers)!!.groupValues[1].toInt()
        val bytes = ByteArray(size);var count = 0
        while (count < size) { val n = input.read(bytes, count, size-count);check(n > 0);count += n }
        return headers to JSONObject(String(bytes, Charsets.UTF_8))
    }
    private fun answer(model: String = "typesafe/jev-1.14-20261014", same: Double = .99) = JSONObject().put("model", model)
        .put("answers", JSONObject().put("target_visible", JSONObject().put("type", "noul").put("noul", .99))
            .put("detail_clear", JSONObject().put("type", "noul").put("noul", .99))
            .put("same_object", JSONObject().put("type", "noul").put("noul", same)))
    private fun reply(socket: Socket, body: JSONObject, status: Int = 200) {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply { write("HTTP/1.1 $status Result\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray());write(bytes);flush() }
    }
    @Test fun openRouterCarriesItsOwnKeyAndImageAssetsAndAcceptsTheObservedDatedModel() = runBlocking {
        ServerSocket(0).use { server ->
            val captured = CompletableDeferred<Pair<String, JSONObject>>()
            val worker = launch(Dispatchers.IO) { server.accept().use { captured.complete(read(it));reply(it, answer()) } }
            val frame = frame()
            val result = JevDirectVerifier({ key }, endpoint = "http://127.0.0.1:${server.localPort}/api/alpha/decisions", provider = JevProvider.OPENROUTER)
                .verify(frame, frame, request, listOf(frame.jpeg, frame.jpeg, frame.jpeg))
            assertEquals(ImageDecision.CONFIRMED, result.decision);assertEquals("or-task", result.result!!.taskId)
            val (header, body) = captured.await()
            assertTrue(header.startsWith("POST /api/alpha/decisions "));assertTrue(header.contains("Authorization: Bearer $key"))
            assertFalse(header.contains("TypeSafe-Danger-Zone"));assertFalse(body.toString().contains(key))
            assertEquals("typesafe/jev-1.14", body.getString("model"));assertEquals(5, body.getJSONObject("assets").length())
            assertNotEquals(body.getJSONObject("state").getString("scene"), body.getJSONObject("state").getString("candidate"))
            assertEquals(3, body.getJSONObject("state").getJSONArray("references").length());worker.join()
        }
    }
    @Test fun aTypeSafeCredentialCannotBeSentToOpenRouter() = runBlocking {
        val frame = frame()
        try { JevDirectVerifier({ "apikey_" + "fake_".repeat(15) }, endpoint = "http://127.0.0.1:1", provider = JevProvider.OPENROUTER)
            .verify(frame, frame, request, listOf(frame.jpeg));fail("Wrong provider credential accepted") }
        catch (expected: JevDirectException) { assertEquals(0, expected.httpStatus) }
    }
    @Test fun unrelatedModelOrUncertainPersonalIdentityCannotConfirm() {
        for (model in listOf("jev-1.14.0", "typesafe/jev-1.13", "typesafe/jev-1.14-evil")) {
            try { JevDirectProtocol.parse(answer(model), request, true, true, JevProvider.OPENROUTER.responseModels);fail("Unrelated model accepted") }
            catch (expected: IllegalArgumentException) { assertNotNull(expected.message) }
        }
        assertEquals(ImageDecision.UNCERTAIN, JevDirectProtocol.parse(answer(same = .5), request, true, true, JevProvider.OPENROUTER.responseModels).decision)
        assertEquals(ImageDecision.REJECTED, JevDirectProtocol.parse(answer(same = .01), request, true, true, JevProvider.OPENROUTER.responseModels).decision)
    }
    @Test fun openRouterCreditErrorsAreExplicitAndDoNotExposeTheProviderBody() = runBlocking {
        ServerSocket(0).use { server ->
            val worker = launch(Dispatchers.IO) { server.accept().use { read(it);reply(it, JSONObject().put("credential", key), 402) } }
            val frame = frame()
            try { JevDirectVerifier({ key }, endpoint = "http://127.0.0.1:${server.localPort}", provider = JevProvider.OPENROUTER)
                .verify(frame, frame, request, listOf(frame.jpeg));fail("Credit error accepted") }
            catch (expected: JevDirectException) { assertEquals(402, expected.httpStatus);assertTrue(expected.message!!.contains("OpenRouter"));assertFalse(expected.message!!.contains(key)) }
            worker.join()
        }
    }
}
