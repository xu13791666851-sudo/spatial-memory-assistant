package com.spatialmemory.assistant.inference

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TargetAliasAssetTest {
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
