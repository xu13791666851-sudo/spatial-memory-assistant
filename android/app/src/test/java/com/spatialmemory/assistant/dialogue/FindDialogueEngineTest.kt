package com.spatialmemory.assistant.dialogue

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FindDialogueEngineTest {
    private val engine = FindDialogueEngine()
    @Test fun `actual tablet status questions do not become save commands`() {
        assertEquals(DialogueIntent.CheckMemory("杯子"),engine.intent("你记住杯子了吗"))
        assertEquals(DialogueIntent.CheckMemory("水杯"),engine.intent("你还记得它吗","水杯"))
    }
    @Test fun `actual tablet recall questions read stored history rather than ordinary chat`() {
        assertEquals(DialogueIntent.RecallLocation("杯子"),engine.intent("你记住，你记住那个杯子在哪里吗？"))
        assertEquals(DialogueIntent.RecallLocation("水杯"),engine.intent("你知道我之前水杯是放在哪里吗？"))
    }
    @Test fun `conversational prefixes never become part of an object identity`() {
        assertEquals(DialogueIntent.StartSearch("水杯"),engine.intent("那我的水杯在哪里？"))
        assertEquals(DialogueIntent.StartSearch("水杯"),engine.intent("我的水杯现在在哪里？"))
    }
    @Test fun `saved appearance and current scene are distinct operations`() {
        assertEquals(DialogueIntent.RecallAppearance("杯子"),engine.intent("之前杯子的外观是什么？"))
        assertEquals(DialogueIntent.DescribeScene("面前的桌子上有什么？"),engine.intent("面前的桌子上有什么？"))
    }
    @Test fun `natural remember variants keep the selected pronoun focus`() {
        assertEquals(DialogueIntent.RememberObject("水杯"),engine.intent("把它记下来","水杯"))
        assertEquals(DialogueIntent.RememberObject("水杯"),engine.intent("这个也记住","水杯"))
    }
    @Test fun `plain remember requests automatic capture while explicit appearance remains appearance only`() {
        assertEquals(DialogueIntent.RememberObject("杯子"),engine.intent("记住这个杯子"))
        assertEquals(DialogueIntent.RememberObject("杯子",appearanceOnly=true),engine.intent("记住这个杯子的外观"))
        assertEquals(DialogueIntent.DescribeScene("桌子上面有什么"),engine.intent("桌子上面有什么"))
    }

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
        assertEquals(DialogueIntent.RememberObject("杯子",appearanceOnly=true), engine.intent("记住我的杯子的样子"))
    }
    @Test fun `retries and memory position requests keep the concrete object name`() {
        assertEquals(DialogueIntent.StartSearch("绿色水杯"), engine.intent("重新帮我找绿色水杯"))
        assertEquals(DialogueIntent.RememberCurrentLocation("绿色水杯"), engine.intent("帮我记住绿色水杯的位置"))
        assertEquals(DialogueIntent.StartSearch("绿色水杯"), engine.intent("再帮我找它", "绿色水杯"))
    }

    @Test fun `history is separate from current camera search`() {
        assertEquals(DialogueIntent.RecallLocation("水杯"), engine.intent("查询水杯的位置历史"))
        assertEquals(DialogueIntent.RecallLocation("水杯"), engine.intent("水杯上次在哪里？"))
        assertEquals(DialogueIntent.StartSearch("水杯"), engine.intent("水杯现在在哪里？"))
    }

    @Test fun `only explicit definite statements write positions`() {
        assertEquals(DialogueIntent.RecordLocation("水杯", "厨房桌上"), engine.intent("记住，水杯现在放在厨房桌上。"))
        assertEquals(DialogueIntent.LocationHint("记住水杯可能在厨房"), engine.intent("记住水杯可能在厨房"))
        assertEquals(DialogueIntent.LocationHint("可能在厨房"), engine.intent("可能在厨房", "水杯"))
        assertEquals(DialogueIntent.RememberObject("水杯"), engine.intent("记住水杯"))
    }

    @Test fun `same name choices use explicit list positions`() {
        assertEquals(DialogueIntent.SelectObject(1), engine.intent("第二件"))
        assertEquals(DialogueIntent.SelectObject(0), engine.intent("第1件"))
        assertEquals(DialogueIntent.Cancel, engine.intent("取消"))
    }

    @Test fun `one sentence keeps the concrete name and the stated place together`() {
        assertEquals(DialogueIntent.RecordLocation("蓝色水杯","书桌左边"),engine.intent("帮我记住这个蓝色水杯，它在书桌左边。"))
        assertEquals(DialogueIntent.RecordLocation("蓝色水杯","书桌左边"),engine.intent("帮我记住这个蓝色水杯它在书桌左边"))
        assertEquals(DialogueIntent.RecordLocation("水杯","厨房桌上"),engine.intent("记住这个水杯的外观和位置，它放在厨房桌上"))
        assertEquals(DialogueIntent.RecordLocation("水杯","书桌"),engine.intent("记住这个水杯在书桌"))
        assertEquals(DialogueIntent.RememberCurrentLocation("水杯"),engine.intent("记住水杯的外观和位置"))
    }
    @Test fun `a deliberately new object is separate from updating an existing identity`() {
        assertEquals(DialogueIntent.RememberObject("水杯",true),engine.intent("再记住一件水杯"))
        assertEquals(DialogueIntent.RecordLocation("水杯","厨房",true),engine.intent("再记住一个水杯，它在厨房"))
    }
    @Test fun `uncertain combined statements stay hints instead of persisted facts`() {
        assertEquals(DialogueIntent.LocationHint("记住水杯，它可能在厨房"),engine.intent("记住水杯，它可能在厨房"))
        assertEquals(DialogueIntent.RecordLocation("水杯","床头"),engine.intent("记住它在床头","水杯"))
        assertNull(engine.intent("记住它"))
    }
    @Test fun `appearance wording and compound polite prefixes do not become part of the name`() {
        assertEquals(DialogueIntent.RememberObject("水杯",appearanceOnly=true),engine.intent("请帮我记住这个水杯的外观"))
        assertEquals(DialogueIntent.RecordLocation("蓝色水杯","书架上"),engine.intent("请帮我记住蓝色水杯的外观和位置，它在书架上"))
    }
}
