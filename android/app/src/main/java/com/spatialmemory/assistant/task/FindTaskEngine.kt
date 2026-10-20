package com.spatialmemory.assistant.task

import com.spatialmemory.assistant.camera.CameraSource
import com.spatialmemory.assistant.inference.ObjectCandidate
import com.spatialmemory.assistant.inference.centerX
import com.spatialmemory.assistant.realtime.QwenEvent
import java.util.UUID

enum class FindStatus { IDLE, LEARNING, WATCHING, CANDIDATE, ANNOUNCED, COMPLETED, CANCELLED }

data class FindTask(
    val id: String,
    val targetName: String,
    val objectMemoryId: String?,
    val status: FindStatus,
    val source: CameraSource?,
    val startedAtMs: Long,
    val announcedCandidateId: String? = null,
    val latestCandidateFrameId: Long? = null,
    val targetAnnounced: Boolean = false,
)

sealed interface FindTaskEvent {
    data class CandidateAccepted(val taskId: String, val candidate: ObjectCandidate, val direction: String) : FindTaskEvent
    data class Verified(val taskId: String, val text: String, val initialDiscovery: Boolean) : FindTaskEvent
}

class FindTaskEngine {
    var task: FindTask? = null
        private set

    fun start(targetName: String, objectMemoryId: String?, source: CameraSource?): FindTask {
        require(targetName.isNotBlank())
        return FindTask(
            id = UUID.randomUUID().toString(),
            targetName = targetName.trim(),
            objectMemoryId = objectMemoryId,
            status = FindStatus.WATCHING,
            source = source,
            startedAtMs = System.currentTimeMillis(),
        ).also { task = it }
    }

    fun startLearning(targetName: String, source: CameraSource?): FindTask {
        require(targetName.isNotBlank())
        return FindTask(
            id = UUID.randomUUID().toString(),
            targetName = targetName.trim(),
            objectMemoryId = null,
            status = FindStatus.LEARNING,
            source = source,
            startedAtMs = System.currentTimeMillis(),
        ).also { task = it }
    }

    fun candidate(candidate: ObjectCandidate): FindTaskEvent.CandidateAccepted? {
        val current = task ?: return null
        if (current.status != FindStatus.WATCHING || candidate.taskId != current.id) return null
        val updated = current.copy(
            status = FindStatus.CANDIDATE,
            announcedCandidateId = candidate.id,
            latestCandidateFrameId = candidate.frameId,
        )
        task = updated
        return FindTaskEvent.CandidateAccepted(updated.id, candidate, direction(candidate.box.centerX(candidate.frameWidth)))
    }

    fun semanticCandidate(candidateId: String, frameId: Long): Boolean {
        val current = task ?: return false
        if (current.status != FindStatus.WATCHING) return false
        task = current.copy(status = FindStatus.CANDIDATE, announcedCandidateId = candidateId, latestCandidateFrameId = frameId)
        return true
    }

    fun verification(result: QwenEvent.TargetVisible): FindTaskEvent.Verified? {
        val current = task ?: return null
        if (!isCurrent(result)) return null
        if (!result.visible || !result.sameObject) {
            task = current.copy(status = FindStatus.WATCHING, announcedCandidateId = null)
            return null
        }
        val initialDiscovery = !current.targetAnnounced
        task = current.copy(status = FindStatus.ANNOUNCED, targetAnnounced = true)
        val detail = listOfNotNull(result.anchor, result.objectState).distinct().joinToString("，")
        val text = if (initialDiscovery) {
            listOfNotNull("看到了${current.targetName}", result.direction, detail.takeIf { it.isNotBlank() }).joinToString("，")
        } else detail
        return text.takeIf { it.isNotBlank() }?.let { FindTaskEvent.Verified(current.id, it, initialDiscovery) }
    }

    fun isCurrent(result: QwenEvent.TargetVisible): Boolean {
        val current = task ?: return false
        return result.taskId == current.id && result.candidateId == current.announcedCandidateId &&
            result.frameId >= (current.latestCandidateFrameId ?: Long.MIN_VALUE)
    }

    fun complete(): FindTask? = task?.copy(status = FindStatus.COMPLETED)?.also { task = it }
    fun cancel(): FindTask? = task?.copy(status = FindStatus.CANCELLED)?.also { task = it }
    fun verificationFailed(taskId: String) {
        val current = task ?: return
        if (current.id == taskId && current.status in setOf(FindStatus.CANDIDATE, FindStatus.ANNOUNCED)) {
            task = current.copy(status = FindStatus.WATCHING, announcedCandidateId = null)
        }
    }
    fun clear() { task = null }

    companion object {
        fun direction(centerX: Float): String = when {
            centerX < 1f / 3f -> "左前方"
            centerX <= 2f / 3f -> "正前方"
            else -> "右前方"
        }
    }
}

