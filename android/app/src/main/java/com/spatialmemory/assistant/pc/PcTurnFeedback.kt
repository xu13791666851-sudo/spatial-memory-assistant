package com.spatialmemory.assistant.pc

/** Per-command feedback gate; a late acknowledgement must never follow a result. */
internal class PcTurnFeedback {
    companion object {
        fun ignores(text: String): Boolean = Regex("^(?:嗯+|啊+|哦+|好的?|好吧|谢谢|我操|卧槽|唉|呃+|知道了)$")
            .matches(text.trim().trimEnd('。', '！', '？', '!', '?').trim())
    }
    private var commandId: String? = null
    private var answered = false
    fun begin(id: String) { commandId = id; answered = false }
    fun accepts(id: String): Boolean = id.isBlank() || id == "null" || commandId == null || id == commandId
    fun shouldSpeak(kind: String): Boolean {
        if (kind == "ack") return !answered
        answered = true
        return true
    }
}
