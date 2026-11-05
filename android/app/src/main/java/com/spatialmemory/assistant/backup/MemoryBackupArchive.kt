package com.spatialmemory.assistant.backup

import android.content.Context
import android.graphics.BitmapFactory
import androidx.room.withTransaction
import com.spatialmemory.assistant.memory.*
import java.io.*
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.zip.*
import kotlinx.coroutines.*
import org.json.*

data class PreparedMemoryBackup(val file: File, val digest: String, val objectCount: Int) : AutoCloseable {
    override fun close() { file.delete() }
}
data class MemoryRestoreResult(val restored: Int, val kept: Int)

/** Explicit persistent-memory allowlist: no credentials, chat, current frames or tasks. */
class MemoryBackupArchive(
    context: Context, private val db: AppDatabase,
    private val photos: File = File(context.filesDir, "object-memory"),
    private val temporary: File = File(context.cacheDir, "memory-backups"),
) {
    companion object {
        const val MAX_BYTES = 40L * 1024 * 1024
        private const val MAX_MANIFEST = 4 * 1024 * 1024
        fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        fun fileDigest(file: File): String = MessageDigest.getInstance("SHA-256").run {
            file.inputStream().use { input -> val bytes = ByteArray(8192);while (true) { val n=input.read(bytes);if(n<0)break;update(bytes,0,n) } }
            digest().joinToString("") { "%02x".format(it) }
        }
        private fun id(value: String): String = value.also { require(it.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,159}"))) { "备份物品编号无效" } }
        private fun bounded(input: InputStream, max: Long): ByteArray = input.use { source ->
            val out=ByteArrayOutputStream();val bytes=ByteArray(8192)
            while(true) { val n=source.read(bytes);if(n<0)break;require(out.size().toLong()+n<=max) { "备份内容超过限制" };out.write(bytes,0,n) }
            out.toByteArray()
        }
        private fun JSONObject.optional(name: String): String? = if (isNull(name)) null else getString(name)
        private fun JSONObject.time(name: String): Long {
            val value=get(name);require(value is Long || value is Int) { "备份时间格式无效" }
            return (value as Number).toLong().also { require(it>=0) }
        }
        private fun JSONObject.short(name: String, limit: Int, empty: Boolean=true): String = getString(name).also { require(it.length <= limit && (empty || it.isNotBlank())) { "备份文字无效" } }
        private fun validImage(bytes: ByteArray) {
            require(bytes.size in 1..2_000_000) { "备份照片大小无效" }
            val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true }
            BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
            require(bounds.outWidth>0 && bounds.outHeight>0 && bounds.outWidth.toLong()*bounds.outHeight<=12_000_000) { "备份照片无法读取" }
        }
    }
    private fun workFile(suffix: String): File {
        check(temporary.isDirectory || temporary.mkdirs())
        return File(temporary,UUID.randomUUID().toString()+suffix)
    }
    suspend fun export(account: String): PreparedMemoryBackup = withContext(Dispatchers.IO) {
        UUID.fromString(account)
        val destination=workFile(".zip")
        try {
            // Writers cannot retire/delete a referenced batch during this snapshot.
            db.withTransaction {
                val all=db.objectMemoryDao().all().sortedBy { it.id };require(all.size<=500) { "物品过多，请分批整理后备份" }
                val entries=linkedMapOf<String,File>();val objects=JSONArray();var total=0L;var historyCount=0;var captureCount=0
                for(item in all) {
                    currentCoroutineContext().ensureActive();id(item.id)
                    val samples=JSONArray()
                    for(sample in db.objectMemoryDao().appearances(item.id)) {
                        id(sample.id)
                        val file=File(sample.referenceImagePath).canonicalFile
                        require(file.path.startsWith(photos.canonicalPath+File.separator) && file.isFile && file.length() in 1..2_000_000) { "参考照片缺失，备份尚未完成" }
                        total+=file.length();require(total<=MAX_BYTES) { "备份照片超过 40 MiB，原记录仍保留" }
                        val path="photos/${sample.id}.jpg";check(entries.put(path,file)==null)
                        samples.put(JSONObject().put("id",sample.id).put("image",path).put("sha256",fileDigest(file))
                            .put("embedding",Base64.getEncoder().encodeToString(sample.embeddingBlob)).put("viewIndex",sample.viewIndex).put("capturedAtMs",sample.capturedAtMs))
                    }
                    val captures=JSONArray()
                    val observations=db.objectMemoryDao().captures(item.id);require(observations.size<=20) { "当时画面较多，备份暂未完成，原记录保留" }
                    for(capture in observations) {
                        require(++captureCount<=10_000);id(capture.id)
                        val file=File(capture.imagePath).canonicalFile
                        require(file.path.startsWith(photos.canonicalPath+File.separator) && file.isFile && file.length() in 1..2_000_000) { "当时画面缺失，备份暂未完成" }
                        total+=file.length();require(total<=MAX_BYTES)
                        val path="scenes/${capture.id}.jpg";check(entries.put(path,file)==null)
                        captures.put(JSONObject().put("id",capture.id).put("image",path).put("sha256",fileDigest(file))
                            .put("frameId",capture.frameId).put("cameraSource",capture.cameraSource).put("capturedAtMs",capture.capturedAtMs).put("recordedAtMs",capture.recordedAtMs)
                            .put("status",capture.status).put("description",capture.description ?: JSONObject.NULL).put("suggestedLocation",capture.suggestedLocation ?: JSONObject.NULL)
                            .put("verifiedLocation",capture.verifiedLocation ?: JSONObject.NULL).put("failureKind",capture.failureKind))
                    }
                    val events=JSONArray()
                    for(event in db.objectMemoryDao().locations(item.id).sortedBy { it.id }) {
                        require(++historyCount<=20_000) { "位置历史过多，暂未备份" }
                        events.put(JSONObject().put("id",event.id).put("placeId",event.placeId ?: JSONObject.NULL).put("location",event.location)
                            .put("anchor",event.anchor).put("observedAtMs",event.observedAtMs ?: JSONObject.NULL).put("confirmed",event.confirmed)
                            .put("recordedAtMs",event.recordedAtMs).put("source",event.source))
                    }
                    objects.put(JSONObject().put("id",item.id).put("name",item.name).put("aliases",JSONArray(item.aliasesJson))
                        .put("yoloLabel",item.yoloLabel ?: JSONObject.NULL).put("description",item.semanticDescription ?: JSONObject.NULL)
                        .put("createdAtMs",item.createdAtMs).put("updatedAtMs",item.updatedAtMs).put("appearances",samples).put("locations",events).put("captures",captures))
                }
                val state=JSONObject().put("account",account).put("objects",objects)
                val hash=digest(state.toString().toByteArray(Charsets.UTF_8))
                val manifest=JSONObject().put("schema",2).put("snapshotId",UUID.randomUUID().toString()).put("createdAtMs",System.currentTimeMillis()).put("stateDigest",hash).put("state",state)
                    .toString().toByteArray(Charsets.UTF_8)
                require(manifest.size<=MAX_MANIFEST && total+manifest.size<=MAX_BYTES) { "备份超过 40 MiB，原记录仍保留" }
                FileOutputStream(destination).use { fileOut -> ZipOutputStream(fileOut).use { zip ->
                    zip.putNextEntry(ZipEntry("manifest.json").apply { time=0 });zip.write(manifest);zip.closeEntry()
                    for((path,file) in entries) { currentCoroutineContext().ensureActive();zip.putNextEntry(ZipEntry(path).apply { time=0 });file.inputStream().use { it.copyTo(zip) };zip.closeEntry() }
                    zip.finish();zip.flush();fileOut.fd.sync()
                } }
                require(destination.length()<=MAX_BYTES) { "备份超过 40 MiB，原记录仍保留" }
                PreparedMemoryBackup(destination,hash,all.size)
            }
        } catch(error: Throwable) { destination.delete();throw error }
    }

    private data class RestoredObject(val item: RememberedObjectEntity, val samples: List<ObjectAppearanceEntity>, val locations: List<LocationObservationEntity>,val captures: List<SceneCaptureEntity>)
    suspend fun restore(archive: File, account: String): MemoryRestoreResult = withContext(Dispatchers.IO) {
        UUID.fromString(account);require(archive.length() in 1..MAX_BYTES) { "备份文件大小无效" }
        val staging=workFile("-restore").apply { check(mkdirs()) };val published=mutableListOf<File>();var committed=false
        try {
            val records=mutableListOf<RestoredObject>()
            ZipFile(archive).use { zip ->
                val names=zip.entries().asSequence().map { it.name }.toList()
                require(names.size<=13501 && names.distinct().size==names.size && "manifest.json" in names) { "备份目录无效" }
                val manifest=JSONObject(String(bounded(zip.getInputStream(zip.getEntry("manifest.json")),MAX_MANIFEST.toLong()),Charsets.UTF_8))
                val schema=manifest.getInt("schema");require(schema in 1..2) { "备份版本暂不支持" }
                val state=manifest.getJSONObject("state")
                require(state.getString("account")==account) { "这份备份不属于当前登录账号" }
                require(digest(state.toString().toByteArray(Charsets.UTF_8))==manifest.getString("stateDigest")) { "备份目录校验失败" }
                val objects=state.getJSONArray("objects");require(objects.length()<=500)
                val expected=mutableSetOf("manifest.json");val identities=mutableSetOf<String>();val sampleIds=mutableSetOf<String>();val locationIds=mutableSetOf<String>();val captureIds=mutableSetOf<String>();var total=0L
                for(index in 0 until objects.length()) {
                    currentCoroutineContext().ensureActive()
                    val obj=objects.getJSONObject(index);val objectId=id(obj.getString("id"));require(identities.add(objectId))
                    val name=obj.short("name",40,false);val aliases=obj.getJSONArray("aliases");require(aliases.length()<=40)
                    for(a in 0 until aliases.length()) require(aliases.getString(a).length<=80)
                    val yolo=obj.optional("yoloLabel");val description=obj.optional("description");require((yolo?.length ?: 0)<=120 && (description?.length ?: 0)<=2000)
                    val created=obj.time("createdAtMs");val updated=obj.time("updatedAtMs");require(updated>=created)
                    val item=RememberedObjectEntity(objectId,name,normalizeObjectName(name),aliases.toString(),yolo,description,created,updated)
                    val samples=mutableListOf<ObjectAppearanceEntity>();val sampleArray=obj.getJSONArray("appearances");require(sampleArray.length()<=6)
                    val views=mutableSetOf<Int>()
                    for(s in 0 until sampleArray.length()) {
                        val entry=sampleArray.getJSONObject(s);val sampleId=id(entry.getString("id"));require(sampleIds.add(sampleId))
                        val path=entry.getString("image");require(path=="photos/$sampleId.jpg" && expected.add(path)) { "备份照片路径无效" }
                        val imageEntry=zip.getEntry(path) ?: error("备份照片缺失")
                        val bytes=bounded(zip.getInputStream(imageEntry),2_000_000)
                        total+=bytes.size;require(total<=MAX_BYTES);validImage(bytes)
                        require(digest(bytes)==entry.getString("sha256")) { "备份照片校验失败，原记录未改动" }
                        val encoded=entry.short("embedding",32768,false);val embedding=Base64.getDecoder().decode(encoded)
                        require(embedding.isNotEmpty() && embedding.size<=16_384 && embedding.size%4==0)
                        val floats=ByteBuffer.wrap(embedding).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
                        while(floats.hasRemaining()) require(floats.get().isFinite())
                        val view=entry.getInt("viewIndex");require(view in 0..5 && views.add(view))
                        val image=File(staging,"$sampleId.jpg");FileOutputStream(image).use { it.write(bytes);it.fd.sync() }
                        samples.add(ObjectAppearanceEntity(sampleId,objectId,embedding,image.path,view,entry.time("capturedAtMs")))
                    }
                    val events=mutableListOf<LocationObservationEntity>();val locations=obj.getJSONArray("locations")
                    require(locations.length()+locationIds.size<=20_000)
                    for(e in 0 until locations.length()) {
                        val entry=locations.getJSONObject(e);val locationId=id(entry.getString("id"));require(locationIds.add(locationId))
                        val source=entry.getString("source");require(source in setOf("CAMERA_VERIFIED","USER_STATEMENT","LEGACY_IMPORT"))
                        val observed=if(entry.isNull("observedAtMs")) null else entry.time("observedAtMs")
                        val confirmed=entry.getBoolean("confirmed");require(confirmed==(source=="CAMERA_VERIFIED") && (!confirmed || observed!=null))
                        events.add(LocationObservationEntity(locationId,objectId,entry.optional("placeId")?.also { require(it.length<=160) },entry.short("location",600,false),entry.short("anchor",600),observed,confirmed,entry.time("recordedAtMs"),source))
                    }
                    val captures=mutableListOf<SceneCaptureEntity>()
                    require(schema!=1 || !obj.has("captures"))
                    val captureArray=if(schema==2) obj.getJSONArray("captures") else JSONArray();require(captureArray.length()<=20)
                    for(c in 0 until captureArray.length()) {
                        val entry=captureArray.getJSONObject(c);val captureId=id(entry.getString("id"));require(captureIds.add(captureId) && captureIds.size<=10_000)
                        val path=entry.getString("image");require(path=="scenes/$captureId.jpg" && expected.add(path))
                        val imageEntry=zip.getEntry(path) ?: error("备份中的当时画面缺失")
                        val bytes=bounded(zip.getInputStream(imageEntry),2_000_000);total+=bytes.size;require(total<=MAX_BYTES);validImage(bytes)
                        require(digest(bytes)==entry.getString("sha256")) { "当时画面校验失败" }
                        val image=File(staging,"scene-$captureId.jpg");FileOutputStream(image).use { it.write(bytes);it.fd.sync() }
                        val source=entry.getString("cameraSource");require(source in setOf("PHONE","ESP32"))
                        val status=entry.getString("status");require(status in CaptureStatus.all)
                        val description=entry.optional("description");val suggested=entry.optional("suggestedLocation");val verified=entry.optional("verifiedLocation")
                        require((description?.length ?: 0)<=2000 && (suggested?.length ?: 0)<=600 && (verified?.length ?: 0)<=600)
                        val failure=entry.short("failureKind",80);require(failure.matches(Regex("[A-Z0-9_]{0,80}")))
                        val captured=entry.time("capturedAtMs");val recorded=entry.time("recordedAtMs");require(captured<=recorded)
                        if(verified!=null) require(events.any { it.confirmed && it.location==verified && it.observedAtMs==captured })
                        require((status in setOf(CaptureStatus.COMPLETE,CaptureStatus.LOCATION_ONLY))==(verified!=null))
                        captures.add(SceneCaptureEntity(captureId,objectId,image.path,entry.time("frameId"),source,captured,recorded,status,description,suggested,verified,failure))
                    }
                    records.add(RestoredObject(item,samples,events,captures))
                }
                require(names.toSet()==expected) { "备份含有不受支持的额外内容" }
            }
            currentCoroutineContext().ensureActive()
            // Only missing identities are restored. Existing edits and all their
            // photographs/history stay untouched. All insertions commit together.
            withContext(NonCancellable) {
                val result=db.withTransaction {
                    var added=0;var kept=0
                    for(record in records) {
                        if(db.objectMemoryDao().byId(record.item.id)!=null) { kept++;continue }
                        val directory=File(photos,"${record.item.id}/restore-${UUID.randomUUID()}").canonicalFile
                        require(directory.path.startsWith(photos.canonicalPath+File.separator));check(directory.mkdirs());published.add(directory)
                        val samples=record.samples.map { sample ->
                            val original=File(sample.referenceImagePath);val target=File(directory,original.name)
                            FileOutputStream(target).use { output -> original.inputStream().use { it.copyTo(output) };output.fd.sync() }
                            check(fileDigest(target)==fileDigest(original));sample.copy(referenceImagePath=target.path)
                        }
                        db.objectMemoryDao().saveObject(record.item);db.objectMemoryDao().saveAppearances(samples)
                        record.locations.forEach { db.objectMemoryDao().saveLocation(it) };added++
                        record.captures.forEach { capture ->
                            val original=File(capture.imagePath);val target=File(directory,original.name)
                            FileOutputStream(target).use { output -> original.inputStream().use { it.copyTo(output) };output.fd.sync() }
                            check(fileDigest(target)==fileDigest(original));db.objectMemoryDao().saveCapture(capture.copy(imagePath=target.path))
                        }
                    }
                    MemoryRestoreResult(added,kept)
                }
                committed=true;result
            }
        } finally {
            if(!committed) published.forEach { it.deleteRecursively() }
            staging.deleteRecursively()
        }
    }
}
