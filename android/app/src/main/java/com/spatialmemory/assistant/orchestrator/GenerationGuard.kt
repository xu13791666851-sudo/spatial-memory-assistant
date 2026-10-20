package com.spatialmemory.assistant.orchestrator

class GenerationGuard {
    private var generation = 0L
    @Synchronized fun next(): Long = ++generation
    @Synchronized fun valid(value: Long) = value == generation
}
