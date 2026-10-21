package com.spatialmemory.assistant.inference

class StableCandidateGate(
    private val confidenceThreshold: Float = 0.50f,
    private val requiredHits: Int = 2,
) {
    private var previous: ObjectCandidate? = null
    private var consecutiveHits = 0

    fun offer(candidates: List<ObjectCandidate>): ObjectCandidate? {
        val eligible = candidates.filter { it.yoloConfidence >= confidenceThreshold && it.combinedScore >= confidenceThreshold }
        val prior = previous
        val current = if (prior == null) {
            eligible.maxByOrNull { it.combinedScore }
        } else {
            eligible.maxByOrNull { it.box.iou(prior.box) }
                ?.takeIf { it.label == prior.label && it.box.iou(prior.box) >= 0.2f }
                ?: eligible.maxByOrNull { it.combinedScore }
        }
        if (current == null) {
            reset()
            return null
        }
        consecutiveHits = if (previous?.let { it.label == current.label && it.box.iou(current.box) >= 0.2f } == true) {
            consecutiveHits + 1
        } else {
            1
        }
        previous = current
        return current.takeIf { consecutiveHits >= requiredHits }
    }

    fun reset() {
        previous = null
        consecutiveHits = 0
    }
}
