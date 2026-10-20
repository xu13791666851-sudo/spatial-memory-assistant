package com.spatialmemory.assistant.task

import com.spatialmemory.assistant.camera.CameraSource
import com.spatialmemory.assistant.camera.FramePacket
import com.spatialmemory.assistant.inference.Box
import com.spatialmemory.assistant.inference.ObjectCandidate
import com.spatialmemory.assistant.realtime.QwenEvent
import org.junit.Assert.*
import org.junit.Test

class FindTaskEngineTest {
    @Test fun `announces once and rejects stale cloud results`() {
        val engine = FindTaskEngine()
        val task = engine.start("鼠标", null, CameraSource.PHONE)
        val first = candidate(task.id, "one", 10, Box(400f, 10f, 500f, 100f))
        assertNotNull(engine.candidate(first))
        assertEquals(FindStatus.CANDIDATE, engine.task?.status)
        assertFalse(engine.task?.targetAnnounced == true)
        assertNull(engine.verification(result("old", "one", 10, true)))
        assertNull(engine.verification(result(task.id, "one", 9, true)))
        assertTrue(engine.verification(result(task.id, "one", 10, true))?.initialDiscovery == true)
        assertTrue(engine.task?.targetAnnounced == true)
    }

    @Test fun `negative verification resumes watching without marking target found`() {
        val engine = FindTaskEngine()
        val task = engine.start("鼠标", null, CameraSource.PHONE)
        assertNotNull(engine.candidate(candidate(task.id, "one", 10, Box(10f, 10f, 100f, 100f))))
        assertNull(engine.verification(result(task.id, "one", 10, false)))
        assertEquals(FindStatus.WATCHING, engine.task?.status)
        assertFalse(engine.task?.targetAnnounced == true)
        assertNotNull(engine.candidate(candidate(task.id, "two", 11, Box(10f, 10f, 100f, 100f))))
    }

    @Test fun `direction uses horizontal thirds`() {
        assertEquals("左前方", FindTaskEngine.direction(.1f))
        assertEquals("正前方", FindTaskEngine.direction(1f / 3f))
        assertEquals("右前方", FindTaskEngine.direction(.9f))
    }

    @Test fun `cloud failure releases task back to local watching`() {
        val engine = FindTaskEngine()
        val task = engine.start("鼠标", null, CameraSource.PHONE)
        engine.candidate(candidate(task.id, "one", 10, Box(10f, 10f, 100f, 100f)))
        engine.verificationFailed(task.id)
        assertEquals(FindStatus.WATCHING, engine.task?.status)
    }

    @Test fun `semantic fallback can find an unremembered target`() {
        val engine = FindTaskEngine()
        val task = engine.start("钱包", null, CameraSource.PHONE)
        assertTrue(engine.semanticCandidate("qwen-one", 10))

        val verified = engine.verification(result(task.id, "qwen-one", 10, true))

        assertEquals("看到了钱包，正前方，桌上", verified?.text)
        assertTrue(verified?.initialDiscovery == true)
        assertEquals(FindStatus.ANNOUNCED, engine.task?.status)
    }

    private fun candidate(task: String, id: String, frame: Long, box: Box) = ObjectCandidate(
        id, task, frame, "mouse", .9f, null, .9f, box,
        FramePacket(frame, CameraSource.PHONE, frame, byteArrayOf()), byteArrayOf(), 640, 480,
    )
    private fun result(task: String, candidate: String, frame: Long, visible: Boolean) = QwenEvent.TargetVisible(
        task, candidate, frame, visible, visible, "正前方", "桌上", null, .9f,
    )
}
