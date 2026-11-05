package com.spatialmemory.assistant.realtime

import org.junit.Assert.*
import org.junit.Test

class EvidenceFreshnessTest {
    private fun accepts(age: Long = 500, source: Boolean = true, task: Boolean = true, revision: Boolean = true, difference: Float = 2f) = EvidenceFreshness.accepts(10_000, 10_000 + age, source, task, revision, difference)
    @Test fun currentFrameCanBeUsed() { assertTrue(accepts()) }
    @Test fun oldOrFutureFramesCannotBeUsed() { assertFalse(accepts(12_001)); assertFalse(accepts(-1)) }
    @Test fun measuredSevenSecondReviewCanCompleteWhileItsSceneRemainsCurrent() { assertTrue(accepts(7_029)) }
    @Test fun switchingSourceCancellingAndEditingInvalidateResults() { assertFalse(accepts(source = false)); assertFalse(accepts(task = false)); assertFalse(accepts(revision = false)) }
    @Test fun movementOrInvalidSignatureCannotConfirmCurrentVisibility() { assertFalse(accepts(difference = 18f)); assertFalse(accepts(difference = Float.NaN)) }
}
