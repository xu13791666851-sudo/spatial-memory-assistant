package com.spatialmemory.assistant.realtime

import org.json.JSONObject

object QwenToolExecutor {
    fun parseTargetVisible(arguments: String): QwenEvent.TargetVisible {
        val json = JSONObject(arguments)
        val taskId = json.getString("taskId")
        val candidateId = json.getString("candidateId")
        val frameId = json.getLong("frameId")
        val visible = json.getBoolean("visible")
        val sameObject = json.optBoolean("sameObject", visible)
        val direction = json.optString("direction").takeIf { it.isNotBlank() }
        val anchor = json.optString("anchor").takeIf { it.isNotBlank() }
        val state = json.optString("state").takeIf { it.isNotBlank() }
        val confidence = json.optDouble("confidence", 0.0).toFloat().coerceIn(0f, 1f)
        return QwenEvent.TargetVisible(taskId, candidateId, frameId, visible, sameObject, direction, anchor, state, confidence)
    }
}
