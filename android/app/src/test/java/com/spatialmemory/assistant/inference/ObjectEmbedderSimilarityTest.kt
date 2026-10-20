package com.spatialmemory.assistant.inference

import org.junit.Assert.assertEquals
import org.junit.Test

class ObjectEmbedderSimilarityTest {
    private val embedder = object : ObjectEmbedder {
        override fun embed(jpeg: ByteArray, box: Box?, rotationDegrees: Int) = floatArrayOf()
        override fun crop(jpeg: ByteArray, box: Box?, rotationDegrees: Int) = byteArrayOf()
    }

    @Test fun `cosine similarity distinguishes aligned and opposite vectors`() {
        assertEquals(1f, embedder.similarity(floatArrayOf(1f, 0f), floatArrayOf(2f, 0f)), .0001f)
        assertEquals(0f, embedder.similarity(floatArrayOf(1f, 0f), floatArrayOf(0f, 1f)), .0001f)
    }
}
