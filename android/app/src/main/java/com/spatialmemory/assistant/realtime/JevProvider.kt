package com.spatialmemory.assistant.realtime

/** Fixed official routes, models and credential formats; never a user-supplied URL. */
enum class JevProvider(
    val id: String, val label: String, val requestModel: String, val endpoint: String,
    val keyPattern: Regex, val responseModels: Set<String>, val reviewMode: String,
) {
    TYPESAFE("typesafe", "TypeSafe 官方", "jev-1.14.0", "https://api.typesafe.ai/v1/systemone",
        Regex("apikey_[A-Za-z0-9_\\-]{30,200}"), setOf("jev-1.14.0"), "jev-direct"),
    OPENROUTER("openrouter", "OpenRouter", "typesafe/jev-1.14", "https://openrouter.ai/api/alpha/decisions",
        Regex("sk-or-v1-[A-Za-z0-9_-]{30,200}"), setOf("typesafe/jev-1.14", "typesafe/jev-1.14-20261014"), "jev-openrouter");

    companion object {
        fun fromId(id: String?): JevProvider? = entries.firstOrNull { it.id == id }
        fun reviewLabel(mode: String?): String = entries.firstOrNull { it.reviewMode == mode }?.let { "Jev · ${it.label}" } ?: "千问图片复核"
    }
}
