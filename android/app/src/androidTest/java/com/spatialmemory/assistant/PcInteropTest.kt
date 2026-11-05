package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.spatialmemory.assistant.backup.MemoryBackupArchive
import com.spatialmemory.assistant.memory.*
import com.spatialmemory.assistant.pc.PcProfile
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Local generated/test data only. Never opens a camera/microphone or main database. */
class PcInteropTest {
    private val context=ApplicationProvider.getApplicationContext<Context>()
    private fun profile()=PcProfile.parse(requireNotNull(InstrumentationRegistry.getArguments().getString("pc_pair")))
    @Test fun pinnedCertificateAcceptsOnlyPairedPc() {
        val profile=profile()
        profile.http().newCall(Request.Builder().url(profile.origin+"/health").build()).execute().use { assertTrue(it.isSuccessful) }
        val wrong=profile.copy(fingerprint=if(profile.fingerprint.first()=='0')"1"+profile.fingerprint.drop(1) else "0"+profile.fingerprint.drop(1))
        try { wrong.http().newCall(Request.Builder().url(wrong.origin+"/health").build()).execute().close();fail("Wrong certificate accepted") } catch(expected: Exception) { assertTrue(expected is java.io.IOException) }
    }
    @Test fun androidArchiveImportsOnPcAndPcArchiveRestoresInIndependentAndroidDatabase()=runBlocking {
        val profile=profile();val http=profile.http();val account="a05db5a0-0862-4aef-b040-44e2496e5354"
        val suffix=UUID.randomUUID().toString();val sourceName="pc-interop-source-$suffix.db";val targetName="pc-interop-target-$suffix.db"
        val source=AppDatabase.open(context,sourceName);val target=AppDatabase.open(context,targetName)
        val root=File(context.cacheDir,"pc-interop-$suffix").apply { check(mkdirs()) }
        val sourcePhotos=File(root,"source");val targetPhotos=File(root,"target");val pending=java.util.concurrent.ConcurrentHashMap<String,CompletableDeferred<JSONObject>>()
        val opened=CompletableDeferred<Unit>()
        val ws=http.newWebSocket(Request.Builder().url(profile.origin+"/v1/session").header("Authorization","Bearer "+profile.token).build(),object: WebSocketListener() {
            override fun onOpen(webSocket: WebSocket,response: Response) { opened.complete(Unit) }
            override fun onMessage(webSocket: WebSocket,text: String) { val m=JSONObject(text);if(m.optString("type")=="result")pending[m.optString("requestId")]?.complete(m) }
            override fun onFailure(webSocket: WebSocket,t: Throwable,response: Response?) { opened.completeExceptionally(t);pending.values.forEach { it.completeExceptionally(t) } }
        })
        suspend fun rpc(type: String,body: JSONObject=JSONObject()): JSONObject {
            val requestId=UUID.randomUUID().toString();val result=CompletableDeferred<JSONObject>();pending[requestId]=result
            try { check(ws.send(body.put("type",type).put("requestId",requestId).toString()));val response=withTimeout(20_000) { result.await() };check(!response.has("error")) { response.optString("error") };return response }
            finally { pending.remove(requestId) }
        }
        try {
            withTimeout(10_000) { opened.await() }
            val session=JSONObject().put("userId",account).put("accessToken","fake-token-for-isolated-local-check-only").put("refreshToken","fake-refresh-for-isolated-local-check-only").put("expiresAtMs",System.currentTimeMillis()+3600_000)
            rpc("hello",JSONObject().put("session",session))
            val bytes=InstrumentationRegistry.getInstrumentation().context.assets.open("bus.jpg").use { it.readBytes() }
            val repository=MemoryRepository(context,source.memoryDao(),source.objectMemoryDao(),sourcePhotos)
            val now=System.currentTimeMillis();val receipt=repository.captureScene("安卓互通样本",bytes,7,"PHONE",now)
            repository.finishCapturedScene(receipt,null,"公共测试图",null,ObservedLocation("桌面上","测试用参照",now),"BOX_UNCERTAIN")
            val src=MemoryBackupArchive(context,source,sourcePhotos,File(root,"tmp-a"));val dst=MemoryBackupArchive(context,target,targetPhotos,File(root,"tmp-b"))
            src.export(account).use { snapshot ->
                withContext(Dispatchers.IO) { http.newCall(Request.Builder().url(profile.origin+"/v1/import").header("Authorization","Bearer "+profile.token).post(snapshot.file.asRequestBody("application/zip".toMediaType())).build()).execute().use { assertEquals(it.peekBody(1000).string(),200,it.code) } }
            }
            val records=rpc("records").getJSONArray("result");assertTrue((0 until records.length()).any { records.getJSONObject(it).getString("id")==receipt.capture.objectId })
            val downloaded=File(root,"pc.zip")
            withContext(Dispatchers.IO) { http.newCall(Request.Builder().url(profile.origin+"/v1/export").header("Authorization","Bearer "+profile.token).build()).execute().use { assertEquals(200,it.code);downloaded.writeBytes(requireNotNull(it.body).bytes()) } }
            val restored=dst.restore(downloaded,account);assertTrue(restored.restored>=1)
            val copy=target.objectMemoryDao().captures(receipt.capture.objectId).single()
            assertEquals(CaptureStatus.LOCATION_ONLY,copy.status);assertEquals("桌面上",copy.verifiedLocation)
            assertArrayEquals(bytes,File(copy.imagePath).readBytes());assertTrue(target.objectMemoryDao().locations(receipt.capture.objectId).single().confirmed)
        } finally {
            ws.close(1000,"test_complete");source.close();target.close()
            // Only test-owned UUID names created in this test are retired.
            context.deleteDatabase(sourceName);context.deleteDatabase(targetName);root.deleteRecursively()
        }
    }
}
