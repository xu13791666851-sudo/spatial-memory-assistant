package com.spatialmemory.assistant

import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test

class AssetSmokeTest {
    @Test fun modelAndLabelsArePackaged() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val labels = context.assets.open("yolo_labels.json").bufferedReader().use { JSONArray(it.readText()) }
        assertEquals(141, labels.length())
        assertEquals("KEY", labels.getString(16))
        context.assets.open("exp.tflite").use { assert(it.available() > 30_000_000) }
    }
}
