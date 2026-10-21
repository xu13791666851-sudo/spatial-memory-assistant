package com.spatialmemory.assistant.inference

import com.spatialmemory.assistant.camera.CameraSource
import com.spatialmemory.assistant.camera.FramePacket
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class StableCandidateGateTest {
    private val box = Box(10f, 10f, 100f, 100f)

    @Test fun `requires two consecutive matching hits`() {
        val gate = StableCandidateGate()
        assertNull(gate.offer(listOf(candidate(.91f, box))))
        assertNull(gate.offer(emptyList()))
        assertNull(gate.offer(listOf(candidate(.88f, Box(12f, 11f, 101f, 99f)))))
        assertNotNull(gate.offer(listOf(candidate(.89f, Box(13f, 12f, 102f, 100f)))))
    }

    @Test fun `rejects high confidence candidates at unrelated positions`() {
        val gate = StableCandidateGate()
        assertNull(gate.offer(listOf(candidate(.95f, box))))
        assertNull(gate.offer(listOf(candidate(.96f, Box(300f, 300f, 380f, 380f)))))
    }

    @Test fun `accepts two stable hits from fifty percent`() {
        val gate = StableCandidateGate()
        assertNull(gate.offer(listOf(candidate(.50f, box))))
        assertNotNull(gate.offer(listOf(candidate(.52f, Box(12f, 11f, 101f, 99f)))))
    }

    @Test fun `rejects low fused appearance score`() {
        val gate = StableCandidateGate()
        assertNull(gate.offer(listOf(candidate(.90f, box, combined = .49f))))
        assertNull(gate.offer(listOf(candidate(.90f, box, combined = .49f))))
    }

    @Test fun `tracks same object when another box has higher score`() {
        val gate = StableCandidateGate()
        val other = Box(300f, 300f, 380f, 380f)
        assertNull(gate.offer(listOf(candidate(.94f, box), candidate(.85f, other))))
        assertNotNull(gate.offer(listOf(candidate(.90f, Box(12f, 11f, 101f, 99f)), candidate(.96f, other))))
    }

    private fun candidate(score: Float, box: Box, combined: Float = score) = ObjectCandidate(
        id = "candidate-$score-${box.left}", taskId = "task", frameId = 1, label = "mouse",
        yoloConfidence = score, appearanceSimilarity = null, combinedScore = combined, box = box,
        frame = FramePacket(1, CameraSource.PHONE, 1, byteArrayOf()), cropJpeg = byteArrayOf(), frameWidth = 640, frameHeight = 480,
    )
}
