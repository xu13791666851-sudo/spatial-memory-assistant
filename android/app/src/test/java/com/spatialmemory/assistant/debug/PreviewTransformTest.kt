package com.spatialmemory.assistant.debug

import org.junit.Assert.assertEquals
import org.junit.Test

class PreviewTransformTest {
    @Test fun letterboxesLandscapeImageVertically() {
        assertEquals(PreviewTransform(0.5f, 0f, 50f), fitCenterTransform(200, 200, 400, 200))
    }

    @Test fun pillarboxesPortraitImageHorizontally() {
        assertEquals(PreviewTransform(0.5f, 50f, 0f), fitCenterTransform(200, 200, 200, 400))
    }
}
