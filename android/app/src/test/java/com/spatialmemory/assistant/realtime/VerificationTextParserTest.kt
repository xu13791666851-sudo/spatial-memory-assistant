package com.spatialmemory.assistant.realtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VerificationTextParserTest {
    private val request = CandidateVerificationRequest("task", "candidate", 42L, "鼠标", null, "mouse", 0.9f, emptyList())

    @Test fun `parses marked fallback result with current request identity`() {
        val result = VerificationTextParser.parse(
            "```\nTARGET_CHECK|visible=true|sameObject=true|direction=右前方|anchor=桌上|state=完整|confidence=0.91\n```",
            request,
        )!!
        assertEquals("task", result.taskId)
        assertEquals("candidate", result.candidateId)
        assertEquals(42L, result.frameId)
        assertTrue(result.visible)
        assertTrue(result.sameObject)
        assertEquals(0.91f, result.confidence)
        assertEquals("右前方", result.direction)
    }

    @Test fun `parses rejection and ignores ordinary assistant text`() {
        val result = VerificationTextParser.parse("TARGET_CHECK|visible=false|sameObject=false|confidence=0.2", request)!!
        assertFalse(result.visible)
        assertFalse(result.sameObject)
        assertNull(VerificationTextParser.parse("当前画面看不清", request))
    }
}
