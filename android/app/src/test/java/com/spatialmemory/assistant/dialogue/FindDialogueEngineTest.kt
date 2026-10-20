package com.spatialmemory.assistant.dialogue

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FindDialogueEngineTest {
    private val engine = FindDialogueEngine()

    @Test fun `extracts explicit search target`() {
        assertEquals(DialogueIntent.StartSearch("钥匙"), engine.intent("帮我找钥匙"))
        assertEquals(DialogueIntent.StartSearch("手机"), engine.intent("手机在哪"))
    }

    @Test fun `pronoun requires current target`() {
        assertNull(engine.intent("它在哪"))
        assertEquals(DialogueIntent.StartSearch("钥匙"), engine.intent("它在哪", "钥匙"))
    }

    @Test fun `only explicit completion ends search`() {
        assertEquals(DialogueIntent.ContinueSearch, engine.intent("这里没有", "钥匙"))
        assertEquals(DialogueIntent.CompleteSearch, engine.intent("拿到了", "钥匙"))
    }

    @Test fun `extracts remembered object`() {
        assertEquals(DialogueIntent.RememberObject("杯子"), engine.intent("记住我的杯子的样子"))
    }
    @Test fun `retries and memory position requests keep the concrete object name`() {
        assertEquals(DialogueIntent.StartSearch("绿色水杯"), engine.intent("重新帮我找绿色水杯"))
        assertEquals(DialogueIntent.RememberObject("绿色水杯"), engine.intent("帮我记住绿色水杯的位置"))
        assertEquals(DialogueIntent.StartSearch("绿色水杯"), engine.intent("再帮我找它", "绿色水杯"))
    }
}
