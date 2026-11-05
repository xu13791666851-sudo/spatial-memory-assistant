package com.spatialmemory.assistant.realtime

import org.junit.Assert.*
import org.junit.Test

class PlaybackPolicyTest {
    @Test fun taskCompletionAllowsTheFollowingConversationToPlay() {
        val policy=PlaybackPolicy();assertTrue(policy.mayPlay)
        policy.taskActive=true;assertFalse(policy.mayPlay)
        policy.taskActive=false;assertTrue(policy.mayPlay)
    }
    @Test fun completingATaskDuringALocalAnnouncementDoesNotOverlapTheTwoSpeakers() {
        val policy=PlaybackPolicy();policy.taskActive=true;policy.localSpeechActive=true
        policy.taskActive=false;assertFalse(policy.mayPlay)
        policy.localSpeechActive=false;assertTrue(policy.mayPlay)
    }
    @Test fun restoringConversationHonorsTheExistingUserPlaybackPreference() {
        val policy=PlaybackPolicy();policy.enabled=false;policy.taskActive=true
        policy.taskActive=false;policy.localSpeechActive=false;assertFalse(policy.mayPlay)
        policy.enabled=true;assertTrue(policy.mayPlay)
    }
}
