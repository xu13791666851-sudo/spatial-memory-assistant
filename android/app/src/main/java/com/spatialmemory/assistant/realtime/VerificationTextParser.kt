package com.spatialmemory.assistant.realtime

internal object VerificationTextParser {
    private const val MARKER = "TARGET_CHECK|"

    fun parse(text: String, request: CandidateVerificationRequest): QwenEvent.TargetVisible? {
        val start = text.indexOf(MARKER)
        if (start < 0) return null
        val values = text.substring(start).lineSequence().first().split('|').drop(1).mapNotNull { field ->
            val separator = field.indexOf('=')
            if (separator <= 0) null else field.substring(0, separator).trim() to field.substring(separator + 1).trim().trim('`', '"', '\'', '。')
        }.toMap()
        val visible = values["visible"]?.toBooleanStrictOrNull() ?: return null
        val sameObject = values["sameObject"]?.toBooleanStrictOrNull() ?: visible
        val confidence = values["confidence"]?.toFloatOrNull()?.coerceIn(0f, 1f) ?: 0f
        fun optional(name: String) = values[name]?.takeIf { it.isNotBlank() && it != "null" && it != "无" }
        return QwenEvent.TargetVisible(
            taskId = request.taskId,
            candidateId = request.candidateId,
            frameId = request.frameId,
            visible = visible,
            sameObject = sameObject,
            direction = optional("direction"),
            anchor = optional("anchor"),
            objectState = optional("state"),
            confidence = confidence,
        )
    }
}
