package com.spatialmemory.assistant.api

import com.spatialmemory.assistant.camera.FrameSource
import com.spatialmemory.assistant.orchestrator.AssistantOrchestrator
import com.spatialmemory.assistant.orchestrator.AssistantState
import kotlinx.coroutines.flow.StateFlow

class AssistantController(private val orchestrator: AssistantOrchestrator, private val pc: com.spatialmemory.assistant.pc.PcAssistantSession? = null) {
    val state: StateFlow<AssistantState> = pc?.state ?: orchestrator.state
    val analyzedFrames = pc?.analyzedFrames ?: orchestrator.analyzedFrames
    suspend fun start(source: FrameSource, enableVoice: Boolean = true) = if (pc != null) pc.start(source, enableVoice) else orchestrator.start(source, enableVoice)
    suspend fun stop() = if (pc != null) pc.stop() else orchestrator.stop()
    suspend fun resetConversation() = if (pc != null) pc.resetConversation() else orchestrator.resetConversation()
    suspend fun submitText(text: String) = if (pc != null) pc.submitText(text) else orchestrator.onUserText(text)
    suspend fun search(target: String, objectId: String? = null) = if (pc != null) pc.search(target, objectId) else orchestrator.beginSearch(target, objectId)
    suspend fun remember(target: String, objectId: String? = null) = if (pc != null) pc.remember(target, objectId) else orchestrator.beginLearning(target, objectId)
    suspend fun selectObject(id: String) = if (pc != null) pc.selectObject(id) else orchestrator.selectObject(id)
    fun requiresCamera(text: String) = if (pc != null) pc.requiresCamera(text) else orchestrator.requiresCamera(text)
    fun finishSearch() = if (pc != null) pc.finishSearch() else orchestrator.completeSearch()
    fun cancelSearch() = if (pc != null) pc.cancelSearch() else orchestrator.cancelSearch()
}
