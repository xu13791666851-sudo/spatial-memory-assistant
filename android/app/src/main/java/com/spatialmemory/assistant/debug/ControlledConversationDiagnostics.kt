package com.spatialmemory.assistant.debug

import android.content.Context
import com.spatialmemory.assistant.BuildConfig
import com.spatialmemory.assistant.dialogue.DialogueIntent
import com.spatialmemory.assistant.memory.normalizeObjectName
import com.spatialmemory.assistant.realtime.*
import com.spatialmemory.assistant.ui.NativeGatewayCredentialClient
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import org.json.JSONObject

/** Real model, synthetic text only. No microphone, camera, images or production memory. */
object ControlledConversationDiagnostics {
    suspend fun realQwen(context: Context): JSONObject = coroutineScope {
        val credentials=NativeGatewayCredentialClient(BuildConfig.GATEWAY_URL)
        val client=AoqQwenRealtimeClient(context,credentials::get,captureAudio=false)
        var rawAssistantEvents=0
        val collector=launch { client.events.collect { if(it is QwenEvent.Transcript && it.role=="assistant") rawAssistantEvents++ } }
        try {
            withTimeout(45_000) { client.connect() }
            val remember=client.interpretUser("请帮我把这个也存起来","水杯",listOf("水杯"))
            check(remember is DialogueIntent.RememberObject && normalizeObjectName(remember.target)=="杯子") { "记忆意图未通过" }
            val history=client.interpretUser("你还记得它上次放哪了吗","水杯",listOf("水杯"))
            check(history is DialogueIntent.RecallLocation && normalizeObjectName(history.target)=="杯子") { "历史查询意图未通过" }
            val status=client.interpretUser("你记住它了吗","水杯",listOf("水杯"))
            check(status is DialogueIntent.CheckMemory && normalizeObjectName(status.target)=="杯子") { "保存状态意图未通过" }
            val scene=client.interpretUser("桌上现在有哪些东西","水杯",listOf("水杯"))
            check(scene is DialogueIntent.DescribeScene) { "场景问题意图未通过" }
            check(rawAssistantEvents==0)
            JSONObject().put("actualQwenUsed",true).put("syntheticTextOnly",true).put("intentCasesPassed",4)
                .put("pronounResolutionPassed",true).put("uncontrolledAssistantTranscriptsExposed",rawAssistantEvents)
                .put("remoteAudioRendered",false).put("externalAudioOnly",true).put("microphoneUsed",false).put("cameraUsed",false).put("imagesSent",false).put("productionMemoryMutated",false)
        } finally { withContext(NonCancellable) { client.disconnect();collector.cancelAndJoin() } }
    }
}
