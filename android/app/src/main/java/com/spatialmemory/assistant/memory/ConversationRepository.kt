package com.spatialmemory.assistant.memory

import java.util.UUID

class ConversationRepository(private val dao: ConversationDao) {
    suspend fun append(role: String, text: String) {
        require(role in setOf("user", "assistant") && text.isNotBlank())
        dao.add(ConversationMessageEntity(UUID.randomUUID().toString(), role, text.trim(), System.currentTimeMillis()))
    }
    suspend fun all() = dao.all()
    suspend fun clear() = dao.clear()
}
