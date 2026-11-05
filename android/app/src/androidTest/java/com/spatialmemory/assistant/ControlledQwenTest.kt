package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.alibaba.aoq.clientsdk.AoqClientEngine
import com.spatialmemory.assistant.dialogue.DialogueIntent
import com.spatialmemory.assistant.realtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ControlledQwenTest {
    private val context=ApplicationProvider.getApplicationContext<Context>()
    private fun intent(kind: String,target: String="杯子")=JSONObject().put("intent",kind).put("target",target).put("use_current",false).put("new_identity",false).put("literal_location","").put("confidence",.95)
    @Test fun rawAutomaticSaveClaimsNeverBecomeApplicationTranscriptEventsButUserSpeechStillDoes()=runBlocking {
        val client=AoqQwenRealtimeClient(context,{ error("No network should be used") })
        val events=mutableListOf<QwenEvent>();val collect=launch(start=CoroutineStart.UNDISPATCHED) { client.events.collect { events.add(it) } }
        val method=client.javaClass.getDeclaredMethod("handleEvent",JSONObject::class.java).apply { isAccessible=true }
        method.invoke(client,JSONObject().put("type","response.text.done").put("text","记住了，杯子在黄色桌上"))
        method.invoke(client,JSONObject().put("type","response.audio_transcript.done").put("transcript","已经保存成功"))
        method.invoke(client,JSONObject().put("type","response.done").put("response",JSONObject().put("output",JSONArray().put(JSONObject().put("type","message").put("content",JSONArray().put(JSONObject().put("text","我记住了")))))))
        method.invoke(client,JSONObject().put("type","conversation.item.input_audio_transcription.completed").put("transcript","记住这个杯子"))
        delay(50);collect.cancelAndJoin()
        assertEquals(listOf(QwenEvent.Transcript("user","记住这个杯子")),events)
    }
    @Test fun connectionRetainsCompatibleTracksButRemoteAudioIsExternalAndCannotReachTheSpeaker() {
        val config=AoqCredential("test-token","test-session","fingerprint",emptyList(),"workspace",123).toConnectConfig()
        assertEquals(2,config.subscribeTracks.size)
        assertTrue(config.subscribeTracks.any { it.trackType==AoqClientEngine.AoqTrackType.AoqTrackTypeData })
        assertTrue(controlledPlaybackConfig().isExternal)
    }
    @Test fun modelStatusAndHistoryOperationsCannotTurnIntoRememberCommands() {
        assertEquals(DialogueIntent.CheckMemory("杯子"),ControlledQwenProtocol.intent(intent("memory_status"),"你记住杯子了吗",null))
        assertEquals(DialogueIntent.RecallLocation("杯子"),ControlledQwenProtocol.intent(intent("recall_location"),"杯子上次放哪里",null))
        assertEquals(DialogueIntent.RecallAppearance("杯子"),ControlledQwenProtocol.intent(intent("recall_appearance"),"杯子以前什么样",null))
    }
    @Test fun semanticPronounsRequireARealFocusAndUncertainInterpretationsAreNotExecuted() {
        val args=intent("remember","").put("use_current",true)
        assertNull(ControlledQwenProtocol.intent(args,"把这个也存一下",null))
        assertEquals(DialogueIntent.RememberObject("水杯"),ControlledQwenProtocol.intent(args,"把这个也存一下","水杯"))
        assertNull(ControlledQwenProtocol.intent(args.put("confidence",.4),"把这个存一下","水杯"))
        assertNull(ControlledQwenProtocol.intent(intent("remember").put("confidence","0.99"),"保存杯子",null))
    }
    @Test fun modelCannotInventAUserStatedPlaceOrPromoteATentativeClue() {
        val args=intent("record_location").put("literal_location","厨房")
        assertNull(ControlledQwenProtocol.intent(args,"帮我记住杯子",null))
        assertNull(ControlledQwenProtocol.intent(args,"杯子可能在厨房",null))
        assertEquals(DialogueIntent.RecordLocation("杯子","厨房"),ControlledQwenProtocol.intent(args,"记住杯子在厨房",null))
    }
    @Test fun sceneResultsRemainObservationSlotsAndCannotBeBoundToAnotherFrame() {
        val args=JSONObject().put("frame_id",42).put("target_visible",true).put("description","蓝色杯身").put("location","桌面上").put("anchor","桌面")
            .put("items",JSONArray().put(JSONObject().put("name","杯子").put("description","蓝色").put("location","画面中央")))
        val parsed=ControlledQwenProtocol.scene(args,42)
        assertEquals("蓝色杯身",parsed.description);assertTrue(ControlledQwenProtocol.sceneReply(parsed).startsWith("当前画面看到"))
        try { ControlledQwenProtocol.scene(args,43);fail("Wrong frame must fail") } catch(expected: IllegalArgumentException) { assertNotNull(expected) }
    }
}
