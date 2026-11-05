package com.spatialmemory.assistant.realtime

import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.runBlocking

class StructuredRequestInboxTest {
    @Test fun unknownAutomaticAnswersCannotCompleteAnApplicationRequest() {
        val inbox=StructuredRequestInbox();val ticket=inbox.begin("intent")
        assertFalse(inbox.complete("automatic-response","intent",null,"saved"));assertFalse(ticket.result.isCompleted)
        assertTrue(inbox.complete(ticket.id,"intent",null,"valid"));assertEquals("valid",runBlocking { ticket.result.await() })
    }
    @Test fun wrongToolOrFrameCannotCrossBetweenIntentAndSceneOperations() {
        val inbox=StructuredRequestInbox();val ticket=inbox.begin("scene",42)
        assertFalse(inbox.complete(ticket.id,"intent",42,"wrong"));assertFalse(inbox.complete(ticket.id,"scene",43,"old-frame"))
        assertTrue(inbox.complete(ticket.id,"scene",42,"right"));assertFalse(inbox.complete(ticket.id,"scene",42,"duplicate"))
    }
    @Test fun cancellationCannotDeliverALateResultToTheNextTurn() {
        val inbox=StructuredRequestInbox();val old=inbox.begin("intent");inbox.remove(old.id);val current=inbox.begin("intent")
        assertTrue(old.result.isCancelled);assertFalse(inbox.complete(old.id,"intent",null,"late"));assertFalse(current.result.isCompleted)
    }
    @Test fun disconnectCancelsAllWaitingOperations() {
        val inbox=StructuredRequestInbox();val one=inbox.begin("intent");val two=inbox.begin("scene",9)
        inbox.reset();assertTrue(one.result.isCancelled);assertTrue(two.result.isCancelled);assertFalse(inbox.contains(one.id))
    }
}
