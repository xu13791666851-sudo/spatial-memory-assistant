package com.spatialmemory.assistant.inference

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SceneChangeGateTest {
    @Test fun `checks first scene then only changed scenes after interval`() {
        val gate = SceneChangeGate(minimumIntervalMs = 2_500, differenceThreshold = 18f)
        val dark = IntArray(64)
        val light = IntArray(64) { 100 }

        assertTrue(gate.offerSignature(dark, 1_000))
        assertFalse(gate.offerSignature(light, 2_000))
        assertFalse(gate.offerSignature(dark, 4_000))
        assertTrue(gate.offerSignature(light, 4_000))
    }
}
