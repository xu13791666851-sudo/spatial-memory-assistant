package com.spatialmemory.assistant.memory

import android.content.Context
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

data class AppearanceSample(val jpeg: ByteArray, val embedding: FloatArray, val capturedAtMs: Long)
data class ObjectMemory(val id: String, val name: String, val yoloLabel: String?, val semanticDescription: String?, val embeddings: List<FloatArray>)

class MemoryRepository(private val context: Context, private val legacyDao: MemoryDao, private val objectDao: ObjectMemoryDao) {
    suspend fun rememberConfirmed(name: String, location: String, anchor: String, observedAtMs: Long) {
        require(name.isNotBlank() && location.isNotBlank() && anchor.isNotBlank())
        legacyDao.save(ItemMemoryEntity(UUID.randomUUID().toString(), name.trim(), normalize(name), location.trim(), anchor.trim(), "USER_REQUESTED_VISUAL", observedAtMs, System.currentTimeMillis(), true))
    }

    suspend fun rememberObject(name: String, yoloLabel: String?, samples: List<AppearanceSample>): ObjectMemory {
        require(name.isNotBlank() && samples.size >= 3)
        findObject(name)?.let { deleteObject(it.id) }
        val now = System.currentTimeMillis()
        val objectId = UUID.randomUUID().toString()
        val directory = File(context.filesDir, "object-memory/$objectId").apply { mkdirs() }
        val appearances = samples.mapIndexed { index, sample ->
            val id = UUID.randomUUID().toString()
            val file = File(directory, "$id.jpg").apply { writeBytes(sample.jpeg) }
            ObjectAppearanceEntity(id, objectId, sample.embedding.toBlob(), file.absolutePath, index, sample.capturedAtMs)
        }
        objectDao.saveObject(RememberedObjectEntity(objectId, name.trim(), normalize(name), "[]", yoloLabel, null, now, now))
        objectDao.saveAppearances(appearances)
        return ObjectMemory(objectId, name.trim(), yoloLabel, null, samples.map { it.embedding })
    }

    suspend fun findObject(name: String): ObjectMemory? {
        val item = objectDao.findObject(normalize(name)) ?: return null
        return ObjectMemory(item.id, item.name, item.yoloLabel, item.semanticDescription, objectDao.appearances(item.id).map { it.embeddingBlob.toFloatArray() })
    }

    suspend fun deleteObject(objectId: String) {
        objectDao.appearances(objectId).forEach { File(it.referenceImagePath).delete() }
        File(context.filesDir, "object-memory/$objectId").deleteRecursively()
        objectDao.deleteObject(objectId)
    }

    suspend fun find(name: String) = legacyDao.find(normalize(name))
    suspend fun clear() = legacyDao.clear()
    private fun normalize(value: String) = value.trim().replace(Regex("^(这个|那个|一个|一只|我的)"), "").lowercase()
}

private fun FloatArray.toBlob(): ByteArray = ByteBuffer.allocate(size * 4).order(ByteOrder.LITTLE_ENDIAN).apply { asFloatBuffer().put(this@toBlob) }.array()
private fun ByteArray.toFloatArray(): FloatArray = FloatArray(size / 4).also { ByteBuffer.wrap(this).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(it) }
