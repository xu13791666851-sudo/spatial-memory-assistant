package com.spatialmemory.assistant

import android.graphics.Bitmap
import android.graphics.Color
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.ui.PixelHomeActivity
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.realtime.*
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.io.File
import java.util.Base64
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class JevDirectTest {
    private fun memoryRequest()=request.copy(requiresPersonalMatch=false,memoryObservation=true)
    private fun memoryAnswer()=answer(.92,.73,.9).apply {
        getJSONObject("answers")
            .put("target_box",JSONObject().put("type","box").put("confidence",.73).put("box",JSONObject().put("left",.23).put("top",.01).put("right",.69).put("bottom",.64)))
            .put("supporting_surface",JSONObject().put("type","choice").put("choice","table").put("confidence",1))
            .put("surface_relation",JSONObject().put("type","choice").put("choice","on").put("confidence",1))
    }
    @Test fun memoryLooksAtTheCurrentSceneWithoutARequiredLocalCropOrHistoricalIdentityCheck() {
        val payload=JevDirectProtocol.payload(frame(),null,memoryRequest(),emptyList())
        val questions=payload.getJSONObject("questions")
        assertEquals("box",questions.getJSONObject("target_box").getString("type"))
        assertTrue(questions.has("supporting_surface"));assertTrue(questions.has("surface_relation"));assertFalse(questions.has("same_object"))
        assertEquals(0,payload.getJSONObject("state").getJSONArray("references").length())
    }
    @Test fun approvedSceneCalibratedBoxCanRecordATableWhilePersonalFindingThresholdStaysStrict() {
        val result=JevDirectProtocol.parse(memoryAnswer(),memoryRequest(),false,false)
        assertEquals(ImageDecision.CONFIRMED,result.decision);assertEquals("桌面上",result.observation!!.location)
        assertEquals(listOf(.23f,.01f,.69f,.64f),result.observation!!.normalizedBox)
        assertEquals(ImageDecision.UNCERTAIN,JevDirectProtocol.parse(answer(.92,.73,.9),request,true,true).decision)
    }
    @Test fun malformedOrLowConfidenceMemoryBoundsCannotBecomeSavedObjectReferences() {
        val cases=listOf(memoryAnswer().apply { getJSONObject("answers").getJSONObject("target_box").put("confidence",.59) },
            memoryAnswer().apply { getJSONObject("answers").getJSONObject("target_box").put("confidence","0.99") },
            memoryAnswer().apply { getJSONObject("answers").getJSONObject("target_box").getJSONObject("box").put("right",2) },
            memoryAnswer().apply { getJSONObject("answers").getJSONObject("target_box").getJSONObject("box").put("left",.8) })
        for(body in cases) { val result=JevDirectProtocol.parse(body,memoryRequest(),false,false);assertEquals(ImageDecision.CONFIRMED,result.decision);assertTrue(result.observation!!.normalizedBox.isEmpty());assertEquals("桌面上",result.observation!!.location) }
    }
    @Test fun unknownWeakOrIncoherentSurfacesNeverTurnIntoAnInventedLocation() {
        val cases=listOf(memoryAnswer().apply { getJSONObject("answers").getJSONObject("supporting_surface").put("choice","unknown") },
            memoryAnswer().apply { getJSONObject("answers").getJSONObject("supporting_surface").put("confidence",.7) },
            memoryAnswer().apply { getJSONObject("answers").getJSONObject("surface_relation").put("choice","held") },
            memoryAnswer().apply { getJSONObject("answers").getJSONObject("supporting_surface").put("choice","invented-room-name") })
        for(body in cases) { val result=JevDirectProtocol.parse(body,memoryRequest(),false,false);assertEquals(ImageDecision.CONFIRMED,result.decision);assertNull(result.observation!!.location) }
    }
    @Test fun anUncertainTargetCannotPromoteEvenACertainSurfaceIntoAVerifiedObjectPosition() {
        val body=memoryAnswer().apply { getJSONObject("answers").getJSONObject("target_visible").put("noul",.4) }
        val result=JevDirectProtocol.parse(body,memoryRequest(),false,false)
        assertFalse(result.observation!!.targetVisible);assertNull(result.observation!!.location)
        assertEquals("TARGET_UNCERTAIN",result.observation!!.failureKind)
    }
    @Test fun memoryObservationSurvivesTheActualDirectHttpTransportWithoutAnyVoiceSession()=runBlocking {
        ServerSocket(0).use { server ->
            val captured=CompletableDeferred<JSONObject>()
            val worker=launch(Dispatchers.IO) { server.accept().use { captured.complete(read(it).second);reply(it,memoryAnswer()) } }
            val result=JevDirectVerifier({key},endpoint="http://127.0.0.1:${server.localPort}").verify(frame(),null,memoryRequest())
            assertEquals("桌面上",result.observation!!.location)
            assertEquals("box",captured.await().getJSONObject("questions").getJSONObject("target_box").getString("type"));worker.join()
        }
    }
    private val key = "apikey_" + "test_only_".repeat(8)
    private val request = CandidateVerificationRequest("direct-task", "candidate", 20, "水杯", "带花纹", "cup", .9f, listOf(.1f, .1f, .5f, .8f), true)
    private fun image(color: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(40, 60, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        return try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it);it.toByteArray() } } finally { bitmap.recycle() }
    }
    private fun frame() = FramePacket(20, CameraSource.PHONE, 100, image(Color.RED))
    private fun read(socket: Socket): Pair<String, JSONObject> {
        val input = socket.getInputStream();val header = ByteArrayOutputStream()
        while (!header.toString("US-ASCII").endsWith("\r\n\r\n")) { val b = input.read();check(b >= 0);header.write(b);check(header.size() < 8192) }
        val headers = header.toString("US-ASCII")
        val size = Regex("Content-Length: ([0-9]+)", RegexOption.IGNORE_CASE).find(headers)!!.groupValues[1].toInt()
        val bytes = ByteArray(size);var count = 0
        while (count < size) { val n = input.read(bytes, count, size - count);check(n > 0);count += n }
        return headers to JSONObject(String(bytes, Charsets.UTF_8))
    }
    private fun answer(v: Any = .99, same: Any = .98, clear: Any = .97) = JSONObject().put("model", "jev-1.14.0")
        .put("answers", JSONObject().put("target_visible", JSONObject().put("type", "noul").put("noul", v))
            .put("same_object", JSONObject().put("type", "noul").put("noul", same))
            .put("detail_clear", JSONObject().put("type", "noul").put("noul", clear))
            .put("direction", JSONObject().put("type", "choice").put("choice", "center").put("confidence", .95)))
    private fun reply(socket: Socket, body: JSONObject, code: Int = 200, location: String? = null) {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply {
            write(("HTTP/1.1 $code Result\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n" + (location?.let { "Location: $it\r\n" } ?: "") + "\r\n").toByteArray(Charsets.US_ASCII));write(bytes);flush()
        }
    }
    @Test fun launcherIntentCanStartTheRealActivityButUnarmedDebugExtrasCannotImportCredentials() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val public = File(context.filesDir, "jev-import-public.json")
        val before = public.takeIf { it.exists() }?.readText()
        val intent = Intent(Intent.ACTION_MAIN).setClass(context, PixelHomeActivity::class.java).addCategory(Intent.CATEGORY_LAUNCHER)
            .putExtra("jev_command", "PREPARE").putExtra("permit", "not-a-private-permit")
        ActivityScenario.launch<PixelHomeActivity>(intent).use { scenario -> scenario.onActivity { activity ->
            assertEquals(Intent.ACTION_MAIN, activity.intent.action)
            assertEquals(before, public.takeIf { it.exists() }?.readText())
            assertNotNull(activity.findViewById<android.view.View>(com.spatialmemory.assistant.R.id.native_headline))
        } }
    }
    @Test fun directRequestCarriesRuntimeKeyAndSeparateCurrentAndReferenceImages() = runBlocking {
        ServerSocket(0).use { server ->
            val captured = CompletableDeferred<Pair<String, JSONObject>>()
            val worker = launch(Dispatchers.IO) { server.accept().use { captured.complete(read(it));reply(it, answer()) } }
            val frame = frame()
            val result = JevDirectVerifier({ key }, endpoint = "http://127.0.0.1:${server.localPort}/v1/systemone")
                .verify(frame, frame, request, listOf(image(Color.BLUE), image(Color.GREEN), image(Color.YELLOW)))
            assertEquals(ImageDecision.CONFIRMED, result.decision);assertEquals("direct-task", result.result!!.taskId)
            val (header, body) = captured.await();assertTrue(header.contains("Authorization: Bearer $key"));assertTrue(header.contains("TypeSafe-Danger-Zone-Images: true"))
            assertFalse(body.toString().contains(key));assertFalse(body.has("messages"));assertEquals("jev-1.14.0", body.getString("model"))
            val assets = body.getJSONObject("assets");assertEquals(5, assets.length());val state = body.getJSONObject("state")
            assertNotEquals(state.getString("scene"), state.getString("candidate"));assertEquals(3, state.getJSONArray("references").length())
            val firstReference = assets.getJSONObject(state.getJSONArray("references").getString(0))
            val jpeg = Base64.getDecoder().decode(firstReference.getString("data_base64"));val bitmap = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
            assertEquals(280, bitmap.width);assertEquals(280, bitmap.height);assertTrue(Color.blue(bitmap.getPixel(140, 140)) > 230);bitmap.recycle();worker.join()
        }
    }
    @Test fun missingReferencesPreventARequestBeforeReadingAnyKey() = runBlocking {
        val client = JevDirectVerifier({ error("Must not read credential") }, endpoint = "http://127.0.0.1:1")
        assertEquals(ImageDecision.UNCERTAIN, client.verify(frame(), frame(), request).decision)
    }
    @Test fun invalidOrAmbiguousProbabilitiesCannotConfirmAPersonalItem() {
        for (body in listOf(answer(.5), answer(.99, .5), answer(.99, .98, .5))) assertEquals(ImageDecision.UNCERTAIN, JevDirectProtocol.parse(body, request, true, true).decision)
        assertEquals(ImageDecision.REJECTED, JevDirectProtocol.parse(answer(.99, .01), request, true, true).decision)
        for (body in listOf(answer("0.99"), answer(.99, 2), answer().put("model", "other"))) {
            try { JevDirectProtocol.parse(body, request, true, true);fail("Invalid answer accepted") } catch (expected: Exception) { assertTrue(expected is IllegalArgumentException || expected is IllegalStateException) }
        }
    }
    @Test fun regionFailureAndRedirectAreExplicitAndNeverContainRawProviderDetails() = runBlocking {
        for (status in listOf(451, 302)) ServerSocket(0).use { server ->
            val worker = launch(Dispatchers.IO) { server.accept().use { read(it);reply(it, JSONObject().put("secret", key), status, "http://127.0.0.1:1/stolen") } }
            try { JevDirectVerifier({ key }, endpoint = "http://127.0.0.1:${server.localPort}").verify(frame(), frame(), request, listOf(image(Color.BLUE)));fail("HTTP error was accepted") }
            catch (expected: JevDirectException) { assertEquals(status, expected.httpStatus);assertFalse(expected.message.orEmpty().contains(key)) }
            worker.join()
        }
    }
    @Test fun cancellingDirectRequestClosesNetworkCall() = runBlocking {
        ServerSocket(0).use { server ->
            val entered = CompletableDeferred<Unit>();val closed = CompletableDeferred<Boolean>()
            val worker = launch(Dispatchers.IO) { server.accept().use { socket -> socket.soTimeout = 5_000;read(socket);entered.complete(Unit);closed.complete(socket.getInputStream().read() == -1) } }
            val http = OkHttpClient();val frame = frame()
            val job = launch { JevDirectVerifier({ key }, http, "http://127.0.0.1:${server.localPort}").verify(frame, frame, request, listOf(frame.jpeg)) }
            withTimeout(3_000) { entered.await() };withTimeout(2_000) { job.cancelAndJoin();assertTrue(closed.await()) }
            withTimeout(2_000) { while (http.dispatcher.runningCallsCount() != 0) delay(10) };worker.join()
        }
    }
}
