package com.spatialmemory.assistant.pc

/** Camera startup mirrors the PC's distinction between history and current observation. */
object PcCameraPolicy {
    fun requiresCamera(text: String): Boolean? {
        val s = text.trim().trimEnd('。', '！', '!', '？', '?')
        if (Regex("记住|记录|保存|记一下|记下来").containsMatchIn(s) &&
            !Regex("吗|没有|哪里|哪儿|在哪").containsMatchIn(s)) return true
        if (Regex("有没有|是否还在|还在不在").containsMatchIn(s)) return true
        if (Regex("现在").containsMatchIn(s) && Regex("哪里|哪儿|在哪|找|看").containsMatchIn(s)) return true
        if (Regex("上次|之前|以前|历史|外观|样子|记住.*吗|记得.*吗").containsMatchIn(s)) return false
        if (Regex("哪里|哪儿|在哪|放哪").containsMatchIn(s)) return false
        if (Regex("看一下|再看|看看|看一看|继续找|帮我找|寻找|有什么|有哪些|有啥").containsMatchIn(s)) return true
        return null
    }
}
