package com.spatialmemory.assistant.dialogue

sealed interface DialogueIntent {
    data class StartSearch(val target: String) : DialogueIntent
    data class RememberObject(val target: String,val newIdentity: Boolean=false,val appearanceOnly: Boolean=false) : DialogueIntent
    data object ContinueSearch : DialogueIntent
    data object CompleteSearch : DialogueIntent
    data object Cancel : DialogueIntent
    data class LocationHint(val text: String) : DialogueIntent
    data class RecallLocation(val target: String) : DialogueIntent
    data class RecordLocation(val target: String, val location: String,val newIdentity: Boolean=false) : DialogueIntent
    data class SelectObject(val index: Int) : DialogueIntent
    data class RememberCurrentLocation(val target: String) : DialogueIntent
    data class CheckMemory(val target: String) : DialogueIntent
    data class RecallAppearance(val target: String) : DialogueIntent
    data class DescribeScene(val question: String) : DialogueIntent
}

class FindDialogueEngine {
    fun intent(text: String, currentTarget: String? = null): DialogueIntent? {
        val value = clean(text)
        if (Regex("^(拿到了|找到了|已经拿到|结束寻找)$").matches(value)) return DialogueIntent.CompleteSearch
        if (Regex("^(不用找了|别找了|停止找物|取消|关闭摄像头)$").matches(value)) return DialogueIntent.Cancel
        fun target(raw: String)=resolvePronoun(cleanMemoryTarget(raw),currentTarget)
        Regex("^(?:你)?(?:还)?(?:记住|记得)(?:了)?(.{0,40}?)(?:了)?(?:吗|没有)$").matchEntire(value)?.takeUnless { Regex("哪里|哪儿|在哪|放哪").containsMatchIn(it.groupValues[1]) }?.let {
            return (if(it.groupValues[1].isBlank()) currentTarget else target(it.groupValues[1]))?.let { name -> DialogueIntent.CheckMemory(name) }
        }
        Regex("^(?:你(?:记住)?[，,])?(?:你)?(?:还)?(?:记住|记得|知道)(.{1,40}?)(?:是)?(?:放在|放|在)?(?:哪里|哪儿|哪)(?:了|吗|了吗)?$").matchEntire(value)?.let {
            val name=target(it.groupValues[1].removeSuffix("是")) ?: return null
            return if(value.contains("现在")) DialogueIntent.StartSearch(name.removeSuffix("现在")) else DialogueIntent.RecallLocation(name)
        }
        Regex("^(?:我)?(?:之前|上次|以前)(?:的)?(.{1,40}?)(?:是)?(?:放在|放|在)?(?:哪里|哪儿|哪)(?:了|吗|了吗)?$").matchEntire(value)?.let {
            return target(it.groupValues[1].removeSuffix("是"))?.let { name -> DialogueIntent.RecallLocation(name) }
        }
        Regex("^(?:你知道|你记得|告诉我)?(.{1,40}?)(?:的外观是什么|的外观|的样子是什么|长什么样|是什么样子)(?:吗)?$").matchEntire(value)?.takeUnless { isMemoryRequest(value) }?.let {
            return target(it.groupValues[1])?.let { name -> DialogueIntent.RecallAppearance(name) }
        }
        if(Regex("(?:桌子?上(?:面)?|面前|眼前|周围|当前画面|画面里|这里).*(?:有什么|有哪些|看到了什么)").containsMatchIn(value) || value in setOf("这是什么","这是什么东西","描述一下眼前的画面","看看周围")) return DialogueIntent.DescribeScene(text)
        Regex("^(?:请|帮我)?(?:把)?(.{1,40}?)(?:也)?(?:记下来|存一下|记一下)$").matchEntire(value)?.let {
            return target(it.groupValues[1])?.let { name -> DialogueIntent.RememberObject(name) }
        }
        Regex("^(.{1,40}?)(?:也)?记住$").matchEntire(value)?.let {
            return target(it.groupValues[1])?.let { name -> DialogueIntent.RememberObject(name) }
        }
        Regex("^第?([一二三四五六七八九十0-9]+)(?:件|个|只)?$").matchEntire(value)?.let {
            val number = it.groupValues[1].toIntOrNull() ?: listOf("一", "二", "三", "四", "五", "六", "七", "八", "九", "十").indexOf(it.groupValues[1]).let { n -> if (n >= 0) n + 1 else null }
            if (number != null) return DialogueIntent.SelectObject(number - 1)
        }
        Regex("^(?:查询|查看|查)?(.{1,40}?)(?:的位置历史|位置历史|的历史位置|上次放哪了|上次在哪里|上次在哪儿|上次在哪|以前放在哪里)$").matchEntire(value)?.let {
            return DialogueIntent.RecallLocation(resolvePronoun(it.groupValues[1].trim(), currentTarget) ?: return null)
        }
        val newIdentity=Regex("(?:再(?:帮我)?(?:记住|记录)(?:一[件个只])|另(?:一)?[件个只]|新增|新的一件)").containsMatchIn(value)
        val record = value.replace(Regex("^(?:(?:请|帮我|再|重新|再次))+"), "")
        val pair=Regex("^(?:记住|记录)[，,\\s]*(.{1,40}?)(?:的外观和位置|的样子和位置|外观和位置|的外观|的样子)?(?:[，,]\\s*(?:它|这[个件只])?|它)(?:现在)?(?:的位置是|的位置在|放在|在)(.{1,600})$").matchEntire(record)
            ?: Regex("^(?:记住|记录)[，,\\s]*(.{1,40}?)(?:现在)?(?:的位置是|的位置在|放在|在)(.{1,600})$").matchEntire(record)
        pair?.let {
            val target = resolvePronoun(cleanMemoryTarget(it.groupValues[1]), currentTarget)
            val location = it.groupValues[2].trim()
            // Tentative clues are not location statements.
            if (!target.isNullOrBlank() && !Regex("可能|应该|好像|也许|大概|不确定|是不是").containsMatchIn(record)) return DialogueIntent.RecordLocation(target, location,newIdentity)
            return DialogueIntent.LocationHint(value)
        }
        if (Regex("^(这样(?:呢|可以吗)?|这里(?:呢|没有|也没有)|没(?:有)?(?:看见|看到|找到)|已经对准了?|再看(?:一)?下|继续找|现在呢)$").matches(value)) {
            return currentTarget?.let { DialogueIntent.ContinueSearch }
        }
        Regex("^(?:(?:请|帮我))*(?:记住|记录)(.{1,40}?)(?:的外观和位置|的样子和位置|外观和位置)$").matchEntire(value)?.let {
            return DialogueIntent.RememberCurrentLocation(resolvePronoun(cleanMemoryTarget(it.groupValues[1]),currentTarget) ?: return null)
        }
        Regex("^(?:(?:请|帮我))*(?:记住|记录)(.{1,40}?)(?:现在|当前)?的位置$").matchEntire(value)?.let {
            return DialogueIntent.RememberCurrentLocation(resolvePronoun(it.groupValues[1].trim(), currentTarget) ?: return null)
        }
        extractRememberTarget(value)?.let { target -> resolvePronoun(target,currentTarget)?.let { return DialogueIntent.RememberObject(it,newIdentity,Regex("(?:外观|样子)$").containsMatchIn(value)) } }
        extractTarget(value, currentTarget)?.let { return DialogueIntent.StartSearch(it) }
        if (currentTarget != null && Regex("^(?:我)?(?:最后|刚才|可能|应该|好像|记得|在|放在).+").matches(value)) {
            return DialogueIntent.LocationHint(value)
        }
        return null
    }

    fun isMemoryRequest(text: String)=Regex("^(?:(?:请|帮我|再|重新|再次))*(?:记住|记录)").containsMatchIn(clean(text))

    fun extractTarget(text: String, focus: String? = null): String? {
        val value = clean(text).replace(Regex("^(?:(?:请|帮我|重新|再次|再))+"), "")
        val match = Regex("^(?:找(?:一下)?|寻找|看看)(.{1,40})$").matchEntire(value)
            ?: Regex("^(.{1,40}?)(?:现在)?(?:在哪里|在哪儿|在哪|放哪了)$").matchEntire(value)
            ?: return null
        val name = match.groupValues[1].replace(Regex("^(?:我)?(?:刚才|之前|上次|以前)(?:让你|请你|帮我)?(?:记住|记录)(?:的)?"), "")
            .trim().replace(Regex("[，。！？!?,]+$"), "")
        if (name in setOf("周围", "环境", "眼前", "画面", "这里", "什么", "东西")) return null
        return resolvePronoun(cleanMemoryTarget(name),focus)
    }

    private fun extractRememberTarget(text: String): String? {
        val value = clean(text).replace(Regex("^(?:(?:请|帮我|重新|再次|再))+"), "")
        return Regex("^(?:记住|记录)([^，,。]{1,60}?)(?:的样子|的外观|外观|的位置)?$")
            .matchEntire(value)?.groupValues?.get(1)?.let(::cleanMemoryTarget)?.takeIf { it.length in 1..40 }
    }

    private fun cleanMemoryTarget(value: String): String {
        if(value.trim() in setOf("它","这个","那个")) return value.trim()
        return value.trim()
        .replace(Regex("(?:的外观和位置|的样子和位置|外观和位置|的外观|的样子|的位置)$"),"")
        .replace(Regex("^(?:(?:那|这)?我的|我(?:之前|上次)?|之前|上次|以前|这个|那个|这件|那件|这只|那只|一件|一个|一只|另一件|另一个|另一只|新的一件)+"),"")
        .removeSuffix("是").trim()
    }

    private fun resolvePronoun(value: String, focus: String?) = if (value in setOf("它", "这个", "那个","这件","那件")) focus else value.takeIf { it.isNotBlank() }

    private fun clean(text: String) = text.trim()
        .replace(Regex("^(?:你好)?(?:小忆|小意|小易)[，,\\s]*"), "")
        .replace(Regex("[。！？!?]+$"), "")
}
