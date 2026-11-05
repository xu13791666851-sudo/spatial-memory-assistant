package com.spatialmemory.assistant.realtime

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred

/** Only a result for an explicitly requested operation can leave the model adapter. */
internal class StructuredRequestInbox {
    data class Ticket(val id: String,val tool: String,val frameId: Long?,val result: CompletableDeferred<String>)
    private val pending=ConcurrentHashMap<String,Ticket>()
    fun begin(tool: String,frameId: Long?=null): Ticket = Ticket(UUID.randomUUID().toString(),tool,frameId,CompletableDeferred()).also { pending[it.id]=it }
    fun contains(id: String)=pending.containsKey(id)
    fun complete(id: String,tool: String,frameId: Long?,arguments: String): Boolean {
        val ticket=pending[id] ?: return false
        if(ticket.tool!=tool || ticket.frameId!=frameId) return false
        if(!pending.remove(id,ticket)) return false
        return ticket.result.complete(arguments)
    }
    fun remove(id: String) { pending.remove(id)?.result?.cancel() }
    fun reset() { pending.keys.toList().forEach(::remove) }
}
