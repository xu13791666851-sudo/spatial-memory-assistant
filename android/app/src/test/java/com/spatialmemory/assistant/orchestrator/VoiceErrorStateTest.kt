package com.spatialmemory.assistant.orchestrator

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceErrorStateTest {
    @Test fun voiceFailureNeverCreatesAnEmptySearchOrInterruptsLearning() {
        assertEquals(SearchState.IDLE, AssistantState().searchStateAfterVoiceError())
        assertEquals(SearchState.LEARNING, AssistantState(target = "水杯", searchState = SearchState.LEARNING).searchStateAfterVoiceError())
        assertEquals(SearchState.SEARCHING, AssistantState(target = "水杯", searchState = SearchState.VERIFYING).searchStateAfterVoiceError())
    }
}
