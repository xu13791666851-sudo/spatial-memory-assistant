package com.spatialmemory.assistant.memory

import android.content.Context
import android.graphics.BitmapFactory
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlinx.coroutines.*

data class AppearanceSample(val jpeg: ByteArray, val embedding: FloatArray, val capturedAtMs: Long)
data class ObservedLocation(val location: String,val anchor: String,val observedAtMs: Long)
data class ObjectMemory(val id: String, val name: String, val yoloLabel: String?, val semanticDescription: String?, val embeddings: List<FloatArray>, val revision: Long, val createdAtMs: Long)
data class MemoryChoice(val id: String, val name: String, val detail: String)

class MemoryRepository(
    context: Context, private val legacyDao: MemoryDao, private val objectDao: ObjectMemoryDao,
    private val directory: File = File(context.filesDir, "object-memory"),
    private val writeImage: (File, ByteArray) -> Unit = { file, bytes -> FileOutputStream(file).use { it.write(bytes); it.fd.sync() } },
) {
    /** First commit the command-time scene. Recognition can never discard it. */
    suspend fun captureScene(name: String,jpeg: ByteArray,frameId: Long,cameraSource: String,capturedAtMs: Long,replacementId: String?=null,expectedRevision: Long?=null,captureId: String=UUID.randomUUID().toString(),allowed: ()->Boolean={true}): SceneReceipt = withContext(Dispatchers.IO) {
        require(name.trim().length in 1..40 && frameId>=0 && cameraSource in setOf("PHONE","ESP32"))
        validateImage(jpeg)
        val old=replacementId?.let { checkNotNull(objectDao.byId(it)) { "这件物品已删除" } }
        require(old==null || expectedRevision!=null)
        val now=maxOf(System.currentTimeMillis(),(old?.updatedAtMs ?: 0)+1)
        require(capturedAtMs in 0..now)
        val item=old?.copy(updatedAtMs=now) ?: RememberedObjectEntity(UUID.randomUUID().toString(),name.trim(),normalizeObjectName(name),"[]",null,null,now,now)
        val id=captureId.also { require(it.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,159}"))) }
        val root=directory.canonicalFile.apply { check(isDirectory || mkdirs()) }
        val file=safeChild(root,"${item.id}/captures/$id.jpg")
        check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs())
        val pending=File(file.parentFile,".$id.pending");var committed=false
        try {
            writeImage(pending,jpeg);check(pending.readBytes().contentEquals(jpeg)) { "画面保存校验失败" }
            currentCoroutineContext().ensureActive();check(allowed()) { "本轮已取消" }
            check(pending.renameTo(file)) { "画面保存未完成" }
            val capture=SceneCaptureEntity(id,item.id,file.path,frameId,cameraSource,capturedAtMs,now,CaptureStatus.CAPTURED,null,null,null,"")
            withContext(NonCancellable) { objectDao.commitScene(item,capture,expectedRevision,allowed);committed=true }
            check(file.isFile && file.readBytes().contentEquals(jpeg))
            SceneReceipt(capture,item.updatedAtMs)
        } finally { pending.delete();if(!committed) file.delete() }
    }

    suspend fun finishCapturedScene(receipt: SceneReceipt,sample: AppearanceSample?,description: String?,suggestedLocation: String?,verifiedLocation: ObservedLocation?,failureKind: String,allowed: ()->Boolean={true}): SceneReceipt = withContext(Dispatchers.IO) {
        val original=checkNotNull(objectDao.capture(receipt.capture.id))
        val old=checkNotNull(objectDao.byId(original.objectId))
        check(old.updatedAtMs==receipt.objectRevision) { "物品记录已变化，原画面保留" }
        require((description?.length ?: 0)<=2000 && (suggestedLocation?.length ?: 0)<=600 && failureKind.matches(Regex("[A-Z0-9_]{0,80}")))
        require(verifiedLocation==null || verifiedLocation.observedAtMs==original.capturedAtMs)
        val now=maxOf(System.currentTimeMillis(),old.updatedAtMs+1)
        val root=directory.canonicalFile
        val target=sample?.let { validateImage(it.jpeg);require(it.embedding.isNotEmpty() && it.embedding.all(Float::isFinite));safeChild(root,"${old.id}/references/${UUID.randomUUID()}.jpg") }
        var committed=false
        try {
            val appearances=sample?.let {
                check(target!!.parentFile!!.isDirectory || target.parentFile!!.mkdirs());writeImage(target,it.jpeg)
                check(target.readBytes().contentEquals(it.jpeg))
                listOf(ObjectAppearanceEntity(UUID.randomUUID().toString(),old.id,it.embedding.toBlob(),target.path,0,it.capturedAtMs))
            }
            val location=verifiedLocation?.let {
                require(it.location.isNotBlank() && it.location.length<=600 && it.anchor.length<=600)
                LocationObservationEntity(UUID.randomUUID().toString(),old.id,null,it.location,it.anchor,it.observedAtMs,true,now,"CAMERA_VERIFIED")
            }
            val status=when {
                sample!=null && location!=null -> CaptureStatus.COMPLETE
                sample!=null -> CaptureStatus.APPEARANCE_ONLY
                location!=null -> CaptureStatus.LOCATION_ONLY
                else -> CaptureStatus.SCENE_ONLY
            }
            val capture=original.copy(status=status,description=description,suggestedLocation=suggestedLocation,verifiedLocation=location?.location,failureKind=failureKind)
            val item=old.copy(updatedAtMs=now,semanticDescription=if(sample!=null || location!=null) description ?: old.semanticDescription else old.semanticDescription)
            currentCoroutineContext().ensureActive()
            withContext(NonCancellable) { objectDao.finishScene(item,capture,appearances,location,receipt.objectRevision,allowed);committed=true }
            check(objectDao.capture(capture.id)==capture)
            SceneReceipt(capture,now)
        } finally { if(!committed) target?.delete() }
    }

    suspend fun markCapturePending(id: String,reason: String) {
        require(reason.matches(Regex("[A-Z0-9_]{1,80}")))
        objectDao.capture(id)?.takeIf { it.status==CaptureStatus.CAPTURED }?.let { objectDao.updateCapture(it.copy(status=CaptureStatus.SCENE_ONLY,failureKind=reason)) }
    }
    suspend fun captures(id: String)=objectDao.captures(id)
    suspend fun capture(id: String)=objectDao.capture(id)
    private fun validateImage(bytes: ByteArray) {
        require(bytes.size in 1..2_000_000)
        val options=BitmapFactory.Options().apply { inJustDecodeBounds=true };BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)
        require(options.outWidth>0 && options.outHeight>0 && options.outWidth.toLong()*options.outHeight<=12_000_000) { "没有可用的当前画面" }
    }

    suspend fun rememberConfirmed(name: String, location: String, anchor: String, observedAtMs: Long) {
        val item = findObjects(name).singleOrNull() ?: error("请先明确是哪一件物品")
        recordLocation(item.id, location, "CAMERA_VERIFIED", observedAtMs, anchor, item.revision)
    }

    /** Null replacementId creates another identity, regardless of matching names. */
    suspend fun rememberObject(name: String, yoloLabel: String?, samples: List<AppearanceSample>, replacementId: String? = null, expectedRevision: Long? = null, observedLocation: ObservedLocation?=null,allowed: () -> Boolean = { true }): ObjectMemory = withContext(Dispatchers.IO) {
        val cleanName = name.trim()
        require(cleanName.length in 1..40 && samples.size in 1..6) { "请提供名称和至少一张参考照片" }
        require(samples.all { it.jpeg.isNotEmpty() && it.jpeg.size <= 2_000_000 && it.embedding.isNotEmpty() && it.embedding.all(Float::isFinite) }) { "采集照片或外观数据不完整" }
        require(samples.map { it.embedding.size }.distinct().size == 1) { "外观数据不完整" }
        for (sample in samples) {
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(sample.jpeg, 0, sample.jpeg.size, options)
            require(options.outWidth > 0 && options.outHeight > 0) { "采集照片无法读取" }
        }
        val old = replacementId?.let { checkNotNull(objectDao.byId(it)) { "这件物品已删除" } }
        require(old == null || expectedRevision != null) { "更新外观前请重新打开这件物品" }
        val now = maxOf(System.currentTimeMillis(), (old?.updatedAtMs ?: 0) + 1)
        val item = old?.copy(yoloLabel = yoloLabel, updatedAtMs = now)
            ?: RememberedObjectEntity(UUID.randomUUID().toString(), cleanName, normalizeObjectName(cleanName), "[]", yoloLabel, null, now, now)
        val location=observedLocation?.let {
            require(it.location.isNotBlank() && it.location.length<=600 && it.anchor.length<=600 && it.observedAtMs in 0..now)
            LocationObservationEntity(UUID.randomUUID().toString(),item.id,null,it.location,it.anchor,it.observedAtMs,true,now,"CAMERA_VERIFIED")
        }
        val root = directory.canonicalFile.apply { check(isDirectory || mkdirs()) { "无法创建照片目录" } }
        val batchId = UUID.randomUUID().toString()
        val staging = File(root, ".staging/$batchId").apply { check(mkdirs()) { "无法准备照片保存" } }
        val target = safeChild(root, "${item.id}/$batchId")
        var committed = false
        try {
            val appearances = samples.mapIndexed { index, sample ->
                currentCoroutineContext().ensureActive()
                check(allowed()) { "本轮采集已取消，未保存" }
                val id = UUID.randomUUID().toString()
                val filename = "$id.jpg"
                val photo = File(staging, filename)
                writeImage(photo, sample.jpeg)
                check(photo.readBytes().contentEquals(sample.jpeg)) { "照片保存校验失败" }
                ObjectAppearanceEntity(id, item.id, sample.embedding.toBlob(), File(target, filename).path, index, sample.capturedAtMs)
            }
            currentCoroutineContext().ensureActive()
            check(target.parentFile!!.isDirectory || target.parentFile!!.mkdirs()) { "无法准备物品照片目录" }
            check(staging.renameTo(target)) { "照片保存未完成" }
            // Prevent a cancellation after commit from deleting published photographs.
            withContext(NonCancellable) {
                objectDao.commitAppearance(item, appearances, old?.updatedAtMs?.also { check(it == expectedRevision) { "记录已变化，请重新采集" } }, observedLocation=location,allowed=allowed)
                committed = true
            }
            toMemory(item)
        } finally {
            if (!committed && target.exists()) target.deleteRecursively()
            if (staging.exists()) staging.deleteRecursively()
            // Retired batches stay private so that a pre-upgrade backup remains usable.
        }
    }

    /** A user-stated location does not require a photograph or camera access. */
    suspend fun createWithLocation(name: String,yoloLabel: String?,location: String,newIdentity: Boolean=false): ObjectMemory = withContext(Dispatchers.IO) {
        val cleanName=name.trim();val place=location.trim()
        require(cleanName.length in 1..40 && place.length in 1..600)
        val now=System.currentTimeMillis()
        val item=RememberedObjectEntity(UUID.randomUUID().toString(),cleanName,normalizeObjectName(cleanName),"[]",yoloLabel,null,now,now)
        val event=LocationObservationEntity(UUID.randomUUID().toString(),item.id,null,place,"用户提供",null,false,now,"USER_STATEMENT")
        currentCoroutineContext().ensureActive()
        withContext(NonCancellable) { objectDao.createWithLocation(item,event,newIdentity) }
        toMemory(item)
    }

    private suspend fun matchingObjects(name: String): List<RememberedObjectEntity> {
        val normalized=normalizeObjectName(name)
        return objectDao.all().filter { normalizeObjectName(it.normalizedName)==normalized || normalizeObjectName(it.name)==normalized }
    }
    suspend fun findObjects(name: String): List<ObjectMemory> = matchingObjects(name).map { toMemory(it) }
    suspend fun findObject(name: String): ObjectMemory? = findObjects(name).singleOrNull()
    suspend fun byId(id: String): ObjectMemory? = objectDao.byId(id)?.let { toMemory(it) }
    suspend fun currentRevision(id: String): Long? = objectDao.byId(id)?.updatedAtMs
    suspend fun history(id: String) = objectDao.locations(id)

    suspend fun choices(name: String): List<MemoryChoice> = matchingObjects(name).sortedWith(compareBy({it.createdAtMs},{it.id})).map { item ->
        val location = objectDao.locations(item.id).firstOrNull()?.location
        val date = java.time.Instant.ofEpochMilli(item.createdAtMs).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm:ss"))
        MemoryChoice(item.id, item.name, listOfNotNull(item.semanticDescription?.takeIf(String::isNotBlank), location?.let { "上次记录：$it" }, "建立于 $date").joinToString("；"))
    }

    suspend fun referenceImages(id: String, revision: Long): List<ByteArray> = withContext(Dispatchers.IO) {
        check(objectDao.byId(id)?.updatedAtMs == revision) { "物品已变化，请重新选择" }
        val root = directory.canonicalFile
        objectDao.appearances(id).take(3).map { appearance ->
            val file = File(appearance.referenceImagePath).canonicalFile
            check(file.path.startsWith(root.path + File.separator) && file.isFile && file.length() in 1..2_000_000) { "参考照片缺失，请重新采集外观" }
            file.readBytes()
        }
    }

    suspend fun recordLocation(id: String, location: String, source: String = "USER_STATEMENT", observedAtMs: Long? = null, anchor: String = "用户提供", expectedRevision: Long? = null) {
        require(location.trim().length in 1..600)
        require(source in setOf("USER_STATEMENT", "CAMERA_VERIFIED"))
        require(source != "CAMERA_VERIFIED" || observedAtMs != null)
        objectDao.appendLocation(id, expectedRevision, LocationObservationEntity(UUID.randomUUID().toString(), id, null, location.trim(), anchor, observedAtMs, source == "CAMERA_VERIFIED", System.currentTimeMillis(), source))
    }

    suspend fun deleteObject(objectId: String, expectedRevision: Long? = null) = withContext(Dispatchers.IO) {
        val target = safeChild(directory.canonicalFile, objectId)
        objectDao.deleteAtRevision(objectId, expectedRevision)
        if (target.exists()) target.deleteRecursively()
        Unit
    }

    private suspend fun toMemory(item: RememberedObjectEntity) = ObjectMemory(item.id, item.name, item.yoloLabel, item.semanticDescription,
        objectDao.appearances(item.id).map { it.embeddingBlob.toFloatArray() }, item.updatedAtMs, item.createdAtMs)
    suspend fun find(name: String) = legacyDao.find(normalizeObjectName(name))
}

fun normalizeObjectName(value: String): String {
    val name=value.trim().replace(Regex("^(?:(?:那|这)?我的|这个|那个|一个|一只)"), "").trim().lowercase()
    return if(name in setOf("水杯","杯子")) "杯子" else name
}
fun locationSourceLabel(source: String) = when (source) {
    "CAMERA_VERIFIED" -> "相机核实"
    "CAMERA_OBSERVED" -> "当时画面的观察记录，尚未独立核实"
    "USER_STATEMENT" -> "你提供的位置，未经相机核实"
    else -> "旧版导入，观察时间未知"
}
private fun safeChild(root: File, relative: String): File = File(root, relative).canonicalFile.also {
    require(it.path.startsWith(root.path + File.separator)) { "照片目录无效" }
}
private fun FloatArray.toBlob(): ByteArray = ByteBuffer.allocate(size * 4).order(ByteOrder.LITTLE_ENDIAN).apply { asFloatBuffer().put(this@toBlob) }.array()
private fun ByteArray.toFloatArray(): FloatArray {
    require(isNotEmpty() && size % 4 == 0) { "外观数据不完整，请重新采集" }
    return FloatArray(size / 4).also { ByteBuffer.wrap(this).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(it) }
}
