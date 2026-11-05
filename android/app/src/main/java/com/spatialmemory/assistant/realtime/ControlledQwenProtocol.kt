package com.spatialmemory.assistant.realtime

import com.spatialmemory.assistant.dialogue.DialogueIntent
import org.json.JSONObject

data class SceneItem(val name: String,val description: String,val location: String)
data class SceneDescription(val frameId: Long,val targetVisible: Boolean,val description: String,val location: String?,val anchor: String?,val items: List<SceneItem>)

/** Model output is an input to the core, never a save receipt or spoken answer. */
internal object ControlledQwenProtocol {
    private fun JSONObject.bounded(name: String,max: Int)=optString(name).trim().also { require(it.length<=max) }
    fun intent(args: JSONObject,utterance: String,focus: String?): DialogueIntent? {
        val confidence=(args.opt("confidence") as? Number)?.toDouble() ?: return null
        if(!confidence.isFinite() || confidence<.8 || confidence>1) return null
        val raw=args.bounded("target",40)
        val target=if(args.optBoolean("use_current") || raw in setOf("它","这个","那个")) focus else raw.takeIf { it.isNotBlank() }
        val fresh=args.optBoolean("new_identity")
        return when(args.bounded("intent",40)) {
            "remember" -> target?.let { DialogueIntent.RememberObject(it,fresh) }
            "recall_location" -> target?.let { DialogueIntent.RecallLocation(it) }
            "memory_status" -> target?.let { DialogueIntent.CheckMemory(it) }
            "recall_appearance" -> target?.let { DialogueIntent.RecallAppearance(it) }
            "find_now" -> target?.let { DialogueIntent.StartSearch(it) }
            "describe_scene" -> DialogueIntent.DescribeScene(utterance)
            "cancel" -> DialogueIntent.Cancel
            "complete" -> DialogueIntent.CompleteSearch
            "record_location" -> {
                val place=args.bounded("literal_location",600)
                if(target!=null && place.isNotBlank() && utterance.contains(place) && !Regex("可能|也许|不确定|好像").containsMatchIn(utterance)) DialogueIntent.RecordLocation(target,place,fresh) else null
            }
            else -> null
        }
    }
    fun scene(args: JSONObject,expectedFrame: Long): SceneDescription {
        require(args.getLong("frame_id")==expectedFrame)
        val items=args.optJSONArray("items");require((items?.length() ?: 0)<=12)
        val entries=(0 until (items?.length() ?: 0)).map { i ->
            val item=items!!.getJSONObject(i);SceneItem(item.bounded("name",40),item.bounded("description",200),item.bounded("location",200))
        }.filter { it.name.isNotBlank() }
        return SceneDescription(expectedFrame,args.optBoolean("target_visible"),args.bounded("description",2000),args.bounded("location",600).takeIf { it.isNotBlank() },args.bounded("anchor",200).takeIf { it.isNotBlank() },entries)
    }
    fun sceneReply(scene: SceneDescription): String = if(scene.items.isEmpty()) "当前画面还没有看清具体物品，可以缓慢调整镜头" else
        "当前画面看到："+scene.items.take(6).joinToString("；") { item -> listOf(item.name,item.description,item.location).filter { it.isNotBlank() }.distinct().joinToString("，") }
}
