package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.conversation.ConversationStore
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class ConversationStoreTest {
    private val context=ApplicationProvider.getApplicationContext<Context>()
    private val name="conversation-test-${UUID.randomUUID()}.db"
    private val preferences=context.getSharedPreferences(name,Context.MODE_PRIVATE)
    private var time=2_000_000_000_000L
    private var store=ConversationStore(context,name,preferences) { time }

    @After fun cleanup() {
        store.close()
        context.deleteDatabase(name)
        preferences.edit().clear().commit()
    }

    @Test fun oldUndatedChatMovesToHistoryExactlyOnceAndCurrentStartsEmpty() {
        val old=JSONArray().put(JSONObject().put("role","user").put("text","记住杯子"))
            .put(JSONObject().put("role","assistant").put("text","当时画面已保存"))
        preferences.edit().putString("native-chat",old.toString()).commit()
        val current=store.initialize()
        assertTrue(store.messages(current).isEmpty())
        val history=store.sessions().single()
        assertTrue(history.legacy)
        assertEquals(listOf("记住杯子","当时画面已保存"),store.messages(history.id).map { it.text })
        assertFalse(preferences.contains("native-chat"))
        store.close()
        store=ConversationStore(context,name,preferences) { time }
        assertEquals(current,store.initialize())
        assertEquals(2,store.sessions().single().messageCount)
    }

    @Test fun newSessionStartsEmptyWhileOldHistoryRemainsReadOnly() {
        val first=store.initialize()
        store.append("user","帮我找杯子")
        time+=1000
        val second=store.newSession()
        assertNotEquals(first,second)
        assertTrue(store.messages().isEmpty())
        assertEquals("帮我找杯子",store.messages(first).single().text)
        assertEquals(second,store.initialize())
        store.append("user","桌上有什么")
        assertEquals("桌上有什么",store.messages(second).single().text)
        assertEquals("帮我找杯子",store.messages(first).single().text)
    }

    @Test fun retentionExpiresAtThirtyDaysAndChangesExpiredCurrentIdentity() {
        val first=store.initialize()
        store.append("user","旧对话")
        time+=ConversationStore.RETENTION_MS-1
        assertEquals(1,store.messages(first).size)
        time++
        assertNotEquals(first,store.initialize())
        assertTrue(store.messages(first).isEmpty())
        assertTrue(store.sessions().isEmpty())
    }

    @Test fun retentionRemovesOldMessagesInsideAStillActiveSession() {
        val first=store.initialize()
        store.append("user","第一天的消息")
        time+=ConversationStore.RETENTION_MS-1000
        store.append("user","最近的消息")
        time+=1000
        assertEquals(first,store.initialize())
        assertEquals(listOf("最近的消息"),store.messages(first).map { it.text })
    }

    @Test fun aFailedLegacyParseDoesNotEraseTheOriginalList() {
        preferences.edit().putString("native-chat","broken-json").commit()
        try {store.initialize();fail("Invalid legacy data accepted")}catch(expected: org.json.JSONException) {}
        assertEquals("broken-json",preferences.getString("native-chat",null))
    }
}
