package com.spatialmemory.assistant.dialogue

sealed interface DialogueIntent {
    data class StartSearch(val target: String) : DialogueIntent
    data class RememberObject(val target: String) : DialogueIntent
    data object ContinueSearch : DialogueIntent
    data object CompleteSearch : DialogueIntent
    data object Cancel : DialogueIntent
    data class LocationHint(val text: String) : DialogueIntent
}

class FindDialogueEngine {
    fun intent(text: String, currentTarget: String? = null): DialogueIntent? {
        val value = clean(text)
        if (Regex("^(拿到了|找到了|已经拿到|结束寻找)$").matches(value)) return DialogueIntent.CompleteSearch
        if (Regex("^(不用找了|别找了|停止找物|取消|关闭摄像头)$").matches(value)) return DialogueIntent.Cancel
        if (Regex("^(这样(?:呢|可以吗)?|这里(?:呢|没有|也没有)|没(?:有)?(?:看见|看到|找到)|已经对准了?|再看(?:一)?下|继续找|现在呢)$").matches(value)) {
            return currentTarget?.let { DialogueIntent.ContinueSearch }
        }
        extractRememberTarget(value)?.let { return DialogueIntent.RememberObject(it) }
        extractTarget(value, currentTarget)?.let { return DialogueIntent.StartSearch(it) }
        if (currentTarget != null && Regex("^(?:我)?(?:最后|刚才|可能|应该|好像|记得|在|放在).+").matches(value)) {
            return DialogueIntent.LocationHint(value)
        }
        return null
    }

    fun extractTarget(text: String, focus: String? = null): String? {
        val value = clean(text).replace(Regex("^(?:(?:请|帮我|重新|再次|再))+"), "")
        val match = Regex("^(?:找(?:一下)?|寻找|看看)(.{1,40})$").matchEntire(value)
            ?: Regex("^(.{1,40}?)(?:现在)?(?:在哪里|在哪儿|在哪|放哪了)$").matchEntire(value)
            ?: return null
        val name = match.groupValues[1].replace(Regex("^(?:我)?(?:刚才|之前|上次|以前)(?:让你|请你|帮我)?(?:记住|记录)(?:的)?"), "")
            .trim().replace(Regex("[，。！？!?,]+$"), "")
        if (name in setOf("周围", "环境", "眼前", "画面", "这里", "什么", "东西")) return null
        return if (name in setOf("它", "这个", "那个")) focus else name.takeIf { it.isNotBlank() }
    }

    private fun extractRememberTarget(text: String): String? {
        val value = clean(text).replace(Regex("^(?:(?:请|帮我|重新|再次|再))+"), "")
        return Regex("^(?:记住|记录)(?:我(?:的)?|这个|那个)?(.{1,40}?)(?:的样子|的外观|外观|的位置)?$")
            .matchEntire(value)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotBlank() }
    }

    private fun clean(text: String) = text.trim()
        .replace(Regex("^(?:你好)?(?:小忆|小意|小易)[，,\\s]*"), "")
        .replace(Regex("[。！？!?]+$"), "")
}
