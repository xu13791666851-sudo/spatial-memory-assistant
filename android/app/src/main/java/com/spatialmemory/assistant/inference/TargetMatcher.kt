package com.spatialmemory.assistant.inference

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class TargetMatcher(context: Context) {
    private val aliases = context.assets.open("target_aliases.json").bufferedReader().use { reader ->
        val json = JSONObject(reader.readText())
        json.keys().asSequence().associateWith { key ->
            val values = json.getJSONArray(key)
            List(values.length()) { values.getString(it).lowercase() }.toSet()
        }
    }
    private val modelLabels = context.assets.open("yolo_labels.json").bufferedReader().use { reader ->
        val json = JSONArray(reader.readText())
        List(json.length()) { json.getString(it).lowercase() }.toSet()
    }

    init {
        require(aliases.values.flatten().all(modelLabels::contains)) { "target_aliases.json 包含 YOLO 模型不存在的类别" }
    }

    fun labelsFor(target: String): Set<String> = aliases[normalizeTarget(target)].orEmpty()
    fun supports(target: String) = labelsFor(target).isNotEmpty()
    fun matches(target: String, label: String) = label.lowercase() in labelsFor(target)
}

internal fun normalizeTarget(value: String) = value.trim().lowercase()
    .replace(Regex("^(请)?(帮我)?(找|寻找|看看)?"), "")
    .replace(Regex("^(我的|这个|那个|一个|一只|一台|一本)"), "")
    .replace(Regex("[，。！？!?,\\s]+$"), "")
