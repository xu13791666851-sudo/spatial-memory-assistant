package com.spatialmemory.assistant.debug

import android.content.Context
import com.spatialmemory.assistant.memory.AppDatabase
import com.spatialmemory.assistant.realtime.VisionReviewRouter
import org.json.JSONObject

/** Isolated real-scene replay; only the existing private one-use permit gate can invoke it. */
object AutomaticMemoryDiagnostics {
    suspend fun run(context: Context,approvedReplayJpeg: ByteArray?=null): JSONObject = RememberFlowDiagnostics.withFixture(context,approvedReplayJpeg) { f ->
        f.detector.visible=false
        if(approvedReplayJpeg!=null) f.verifier.delegate=VisionReviewRouter(context)
        f.start();f.core.onUserText("记住这个杯子");f.awaitPhoto(25_000)
        val item=f.repo.findObject("杯子") ?: error("Automatic observation missing")
        val photos=f.db.objectMemoryDao().appearances(item.id);val location=f.repo.history(item.id).single()
        val scenes=f.db.objectMemoryDao().captures(item.id);check(photos.size==1 && scenes.size==1 && location.source=="CAMERA_VERIFIED" && location.confirmed && location.location.isNotBlank())
        check(!f.voice.taskActive)
        f.core.stop();f.db.close();f.db=AppDatabase.open(context,f.dbName)
        check(f.db.objectMemoryDao().appearances(item.id).size==1 && f.db.objectMemoryDao().locations(item.id).single().id==location.id)
        JSONObject().put("automaticAppearanceAndLocation",true).put("targetAndScenePhotos",photos.size+scenes.size).put("targetReferencePhotos",photos.size).put("sceneCaptures",scenes.size).put("inferredLocation",location.location)
            .put("cameraVerifiedHistory",true).put("reopenPassed",true).put("localDetectorMatched",false)
            .put("visionApiCalls",f.verifier.memoryCalls).put("actualVisionApiUsed",approvedReplayJpeg!=null)
            .put("approvedCapturedSceneReplay",approvedReplayJpeg!=null).put("liveCameraUsed",false)
            .put("microphoneUsed",false).put("productionMemoryMutated",false)
    }
}
