package com.spatialmemory.assistant.pc

import org.junit.Assert.assertEquals
import org.junit.Test

class PcCameraPolicyTest {
    @Test fun historyDoesNotStartCaptureWhileScreenshotFollowupsDo() {
        for (s in listOf("我的水杯在哪", "在哪里呀？告诉我。", "蓝色水杯上次在哪里", "你记住水杯了吗"))
            assertEquals(s, false, PcCameraPolicy.requiresCamera(s))
        for (s in listOf("记住这个杯子", "可以。哦，你看一下。", "现在这个桌面上有没有？", "你看一下这个桌面上有没有之前说过的蓝色水杯。", "水杯现在在哪"))
            assertEquals(s, true, PcCameraPolicy.requiresCamera(s))
    }
}
