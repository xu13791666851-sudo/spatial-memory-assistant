package com.spatialmemory.assistant.api

import com.spatialmemory.assistant.camera.FrameSource
import com.spatialmemory.assistant.orchestrator.AssistantOrchestrator
import com.spatialmemory.assistant.orchestrator.AssistantState
import kotlinx.coroutines.flow.StateFlow

class AssistantController(private val orchestrator: AssistantOrchestrator) {
    val state: StateFlow<AssistantState> = orchestrator.state
    val analyzedFrames = orchestrator.analyzedFrames
    suspend fun start(source: FrameSource) = orchestrator.start(source)
    suspend fun stop() = orchestrator.stop()
    suspend fun submitText(text: String) = orchestrator.onUserText(text)
    suspend fun search(target: String) = orchestrator.beginSearch(target)
    fun remember(target: String) = orchestrator.beginLearning(target)
    fun finishSearch() = orchestrator.completeSearch()
    fun cancelSearch() = orchestrator.cancelSearch()
}
