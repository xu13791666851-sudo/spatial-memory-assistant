package com.spatialmemory.assistant

import android.content.Context
import android.view.inspector.WindowInspector
import android.widget.Button
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.spatialmemory.assistant.conversation.ConversationStore
import com.spatialmemory.assistant.ui.PixelHomeActivity
import org.junit.Assert.*
import org.junit.Test

class ConversationUiTest {
    @Test fun longChatWrapsInsideTheDialogAndInputRemainsVisible() {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val store=ConversationStore(context)
        val text="这是一条检查换行的长消息，小风扇在键盘右侧，外观是蓝色圆形。".repeat(12)
        store.append("assistant",text)
        fun find(view: View): TextView? {
            if(view is TextView && view.text.toString()==text)return view
            if(view is ViewGroup)for(index in 0 until view.childCount)find(view.getChildAt(index))?.let {return it}
            return null
        }
        try {
            ActivityScenario.launch(PixelHomeActivity::class.java).use { scenario ->
                scenario.onActivity { it.findViewById<Button>(R.id.native_records).performClick() }
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                scenario.onActivity {
                    val root=WindowInspector.getGlobalWindowViews().first { it.findViewById<ScrollView>(R.id.native_records_scroller)!=null }
                    val scroller=root.findViewById<ScrollView>(R.id.native_records_scroller)
                    val message=checkNotNull(find(root));val viewport=Rect();scroller.getGlobalVisibleRect(viewport)
                    val position=IntArray(2);message.getLocationOnScreen(position)
                    assertTrue("Message overflows the left edge",position[0]>=viewport.left)
                    assertTrue("Message overflows the right edge",position[0]+message.width<=viewport.right)
                    assertTrue("Long message must wrap",message.layout.lineCount>1)
                    for(id in listOf(R.id.native_records_input,R.id.native_records_send)) {
                        val view=root.findViewById<View>(id);val visible=Rect()
                        assertTrue("Records footer is hidden",view.getGlobalVisibleRect(visible))
                        assertEquals(view.height,visible.height());assertEquals(view.width,visible.width())
                    }
                }
            }
        } finally { store.close() }
    }
    @Test fun recordsNewSessionButtonArchivesCurrentChatAndOpensAnEmptyConversation() {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val store=ConversationStore(context)
        val previous=store.initialize()
        store.append("user","会话入口检查")
        try {
            ActivityScenario.launch(PixelHomeActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.findViewById<Button>(R.id.native_records).performClick()
                    val button=WindowInspector.getGlobalWindowViews()
                        .firstNotNullOfOrNull { it.findViewById<Button>(R.id.native_new_conversation) }
                    assertNotNull("New conversation entry is missing",button)
                    button!!.performClick()
                }
                val deadline=System.currentTimeMillis()+15_000
                while(store.initialize()==previous && System.currentTimeMillis()<deadline)Thread.sleep(100)
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                assertNotEquals(previous,store.initialize())
                assertTrue(store.messages().isEmpty())
                assertTrue(store.messages(previous).any { it.text=="会话入口检查" })
            }
        } finally { store.close() }
    }
}
