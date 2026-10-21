package com.spatialmemory.assistant.dialogue

data class ConversationContext(
    val searchId: String? = null,
    val target: String? = null,
    val locationHint: String? = null,
    val active: Boolean = false,
)
