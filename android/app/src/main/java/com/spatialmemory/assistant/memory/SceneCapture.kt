package com.spatialmemory.assistant.memory

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/** A scene is evidence of an observation, never an individual-object reference. */
@Entity(tableName="object_scene_captures",foreignKeys=[ForeignKey(entity=RememberedObjectEntity::class,parentColumns=["id"],childColumns=["objectId"],onDelete=ForeignKey.CASCADE)],indices=[Index("objectId")])
data class SceneCaptureEntity(
    @PrimaryKey val id: String,val objectId: String,val imagePath: String,val frameId: Long,
    val cameraSource: String,val capturedAtMs: Long,val recordedAtMs: Long,
    val status: String,val description: String?,val suggestedLocation: String?,
    val verifiedLocation: String?,val failureKind: String,
)

object CaptureStatus {
    const val CAPTURED="CAPTURED"
    const val SCENE_ONLY="SCENE_ONLY"
    const val APPEARANCE_ONLY="APPEARANCE_ONLY"
    const val LOCATION_ONLY="LOCATION_ONLY"
    const val COMPLETE="COMPLETE"
    val all=setOf(CAPTURED,SCENE_ONLY,APPEARANCE_ONLY,LOCATION_ONLY,COMPLETE)
    fun label(status: String)=when(status) {
        CAPTURED -> "当时画面已保存，外观和位置待确认"
        APPEARANCE_ONLY -> "外观已保存，位置待确认"
        LOCATION_ONLY -> "画面和位置已保存，目标照片待补充"
        COMPLETE -> "外观和位置已保存"
        else -> "当时画面已保存，外观和位置待确认"
    }
}

data class SceneReceipt(val capture: SceneCaptureEntity,val objectRevision: Long)
