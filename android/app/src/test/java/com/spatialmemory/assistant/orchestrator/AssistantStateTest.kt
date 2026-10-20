package com.spatialmemory.assistant.orchestrator

import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantStateTest {
    @Test fun `video progress never overwrites confirmed guidance`() {
        val state = AssistantState(searchState = SearchState.GUIDING, message = "鼠标在画面中央，靠近鼠标垫上沿")
        assertEquals(state.message, state.messageWhileProcessing(711))
    }
}
