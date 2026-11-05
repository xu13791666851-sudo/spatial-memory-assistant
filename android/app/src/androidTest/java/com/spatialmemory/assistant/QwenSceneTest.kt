package com.spatialmemory.assistant

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.camera.*
import com.spatialmemory.assistant.realtime.*
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.Base64
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class QwenSceneTest {
    private fun observation(id: Long,description: String="蓝色杯身")=JSONObject().put("f",id).put("v",true).put("d",description).put("l","桌面上").put("a","桌子").put("i",JSONArray().put("杯子")).toString()
    private fun jpeg(color: Int): ByteArray {
        val bitmap=Bitmap.createBitmap(640,480,Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        return try { ByteArrayOutputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG,85,it);it.toByteArray() } } finally { bitmap.recycle() }
    }
    @Test fun fixedImageIdentityAndQuestionTravelTogetherWithUprightPixels(): Unit = runBlocking {
        ServerSocket(0).use { server ->
            val captured=CompletableDeferred<JSONObject>()
            val worker=launch(Dispatchers.IO) { server.accept().use { socket -> captured.complete(read(socket));reply(socket,observation(81)) } }
            val frame=FramePacket(81,CameraSource.PHONE,100,jpeg(Color.BLUE),90)
            val result=QwenSceneDescriber("http://127.0.0.1:${server.localPort}").describe(frame,"杯子","杯子在哪里")
            assertEquals(81L,result.frameId);assertEquals("蓝色杯身",result.description);assertEquals("桌面上",result.location)
            val content=captured.await().getJSONArray("messages").getJSONObject(0).getJSONArray("content")
            assertEquals(2,content.length())
            val bytes=Base64.getDecoder().decode(content.getJSONObject(0).getJSONObject("image_url").getString("url").substringAfter(','))
            val bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.size)
            assertEquals(480,bitmap.width);assertEquals(640,bitmap.height);assertTrue(Color.blue(bitmap.getPixel(240,320))>230);bitmap.recycle()
            val prompt=content.getJSONObject(1).getString("text")
            assertTrue(prompt.contains("\"frame_id\":81") && prompt.contains("杯子在哪里"));worker.join()
        }
    }
    @Test fun twoSnapshotsRemainIndependentWhileVoiceIsDisconnected(): Unit = runBlocking {
        ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) { repeat(2) { index -> server.accept().use { socket -> read(socket);reply(socket,observation(90L+index,if(index==0) "蓝杯" else "红杯")) } } }
            val scene=QwenSceneDescriber("http://127.0.0.1:${server.localPort}")
            val context=ApplicationProvider.getApplicationContext<Context>()
            val client=AoqQwenRealtimeClient(context,{ error("Voice connection must not be created") },captureAudio=false,sceneDescriber=scene::describe)
            assertEquals("蓝杯",client.describeScene(FramePacket(90,CameraSource.PHONE,100,jpeg(Color.BLUE)),"杯子","什么颜色")!!.description)
            assertEquals("红杯",client.describeScene(FramePacket(91,CameraSource.PHONE,101,jpeg(Color.RED)),"杯子","现在是什么颜色")!!.description)
            assertEquals(RealtimeState.DISCONNECTED,client.state.value);worker.join()
        }
    }
    @Test fun cancellationClosesOnlyThePendingImageRequest(): Unit = runBlocking {
        ServerSocket(0).use { server ->
            val entered=CompletableDeferred<Unit>();val closed=CompletableDeferred<Boolean>()
            val worker=launch(Dispatchers.IO) { server.accept().use { socket -> socket.soTimeout=5000;read(socket);entered.complete(Unit);closed.complete(socket.getInputStream().read()==-1) } }
            val http=OkHttpClient();val client=QwenSceneDescriber("http://127.0.0.1:${server.localPort}",http)
            val job=launch { client.describe(FramePacket(1,CameraSource.PHONE,100,jpeg(Color.BLUE)),"杯子","描述") }
            withTimeout(3000) { entered.await() }
            withTimeout(2000) { job.cancelAndJoin();assertTrue(closed.await()) };worker.join()
        }
    }
    @Test fun wrongFrameTruncationAndCoercedVisibilityAreRejected() {
        fun rejected(text: String) { try { QwenSceneDescriber.decode(text,42);fail("Invalid observations must be rejected") } catch(expected: Exception) { assertNotNull(expected) } }
        rejected(observation(43));rejected(observation(42).dropLast(1))
        rejected(JSONObject(observation(42)).put("v","true").toString())
        rejected(JSONObject(observation(42)).put("f","42").toString())
        rejected(JSONObject(observation(42)).put("i",JSONArray().put("一").put("二").put("三").put("四")).toString())
        val exact=9_007_199_254_740_993L
        assertEquals(exact,QwenSceneDescriber.decode(observation(exact),exact).frameId)
    }
    @Test fun observationSlotsCannotCarryInventedSaveReceipts() {
        for(text in listOf(observation(42,"已经保存成功"),JSONObject(observation(42)).put("i",JSONArray().put("记住了")).toString())) {
            try { QwenSceneDescriber.decode(text,42);fail("Save claims must not enter observation slots") } catch(expected: IllegalArgumentException) { assertNotNull(expected) }
        }
        val parsed=QwenSceneDescriber.decode("```json\r\n"+observation(42)+"\r\n```",42)
        assertEquals("当前画面看到：杯子",ControlledQwenProtocol.sceneReply(parsed))
    }
    @Test fun providerFailureCannotBecomeADescriptionOrExposeItsResponse(): Unit = runBlocking {
        ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) { server.accept().use { socket -> read(socket);val body="provider-private-text".toByteArray();socket.getOutputStream().write("HTTP/1.1 503 Unavailable\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray()+body);socket.getOutputStream().flush() } }
            try { QwenSceneDescriber("http://127.0.0.1:${server.localPort}").describe(FramePacket(1,CameraSource.PHONE,100,jpeg(Color.BLUE)),null,"看到了什么");fail("Must fail") }
            catch(expected: IllegalStateException) { assertFalse(expected.message.orEmpty().contains("provider-private-text"));assertTrue(expected.message.orEmpty().contains("503")) };worker.join()
        }
    }
    private fun read(socket: Socket): JSONObject {
        val input=socket.getInputStream();val header=ByteArrayOutputStream()
        while(!header.toString("US-ASCII").endsWith("\r\n\r\n")) { val byte=input.read();check(byte>=0);header.write(byte);check(header.size()<8192) }
        val size=Regex("Content-Length: ([0-9]+)",RegexOption.IGNORE_CASE).find(header.toString("US-ASCII"))!!.groupValues[1].toInt()
        val bytes=ByteArray(size);var offset=0
        while(offset<size) { val count=input.read(bytes,offset,size-offset);check(count>0);offset+=count }
        return JSONObject(String(bytes,Charsets.UTF_8))
    }
    private fun reply(socket: Socket,text: String) {
        val bytes=JSONObject().put("choices",JSONArray().put(JSONObject().put("message",JSONObject().put("content",text)))).toString().toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray()+bytes);flush() }
    }
}
