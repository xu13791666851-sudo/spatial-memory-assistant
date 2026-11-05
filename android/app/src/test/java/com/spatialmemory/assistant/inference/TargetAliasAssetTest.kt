package com.spatialmemory.assistant.inference

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TargetAliasAssetTest {
    @Test fun `descriptive names retain the longest supported object noun`() {
        val keys=setOf("水杯","杯子","电脑","笔记本电脑","钥匙")
        assertEquals("水杯",resolveTargetAlias("这个蓝色水杯",keys))
        assertEquals("笔记本电脑",resolveTargetAlias("银色笔记本电脑",keys))
        assertEquals("钥匙",resolveTargetAlias("钥匙",keys))
    }
    @Test fun `another category and multiple objects cannot silently become a supported noun`() {
        val keys=setOf("水杯","瓶子","电视")
        org.junit.Assert.assertNull(resolveTargetAlias("电视柜",keys))
        org.junit.Assert.assertNull(resolveTargetAlias("水杯和瓶子",keys))
    }
    @Test fun `mouse phrases normalize to configured mouse label`() {
        val aliases = File("src/main/assets/target_aliases.json").readText()

        assertEquals("鼠标", normalizeTarget("帮我找我的鼠标。"))
        assertTrue(Regex("\\\"鼠标\\\"\\s*:\\s*\\[[^]]*\\\"mouse\\\"").containsMatchIn(aliases))
    }

    @Test fun `every configured alias exists in model labels`() {
        val labels = quotedValues(File("src/main/assets/yolo_labels.json").readText()).toSet()
        val aliases = Regex(":\\s*\\[([^]]*)]").findAll(File("src/main/assets/target_aliases.json").readText())
            .flatMap { quotedValues(it.groupValues[1]) }
            .toSet()

        assertTrue("Unknown aliases: ${aliases - labels}", labels.containsAll(aliases))
    }

    private fun quotedValues(text: String) = Regex("\\\"([^\\\"]+)\\\"").findAll(text).map { it.groupValues[1] }
}
