package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.backup.*
import java.io.*
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.Base64
import java.security.KeyFactory
import java.security.spec.X509EncodedKeySpec
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import kotlinx.coroutines.*
import org.json.*
import org.junit.*
import org.junit.Assert.*

class SupabaseBackupTest {
    private val context=ApplicationProvider.getApplicationContext<Context>()
    private val namespace="test-${UUID.randomUUID()}";private val store=BackupSessionStore(context,namespace)
    private val account=UUID.randomUUID().toString();private val access="test-access-token-"+"a".repeat(80);private val refresh="test-refresh-token-"+"b".repeat(40)
    private val root=File(context.cacheDir,"supabase-test-${UUID.randomUUID()}").apply { mkdirs() }
    private fun sessionBody(user: String=account)=JSONObject().put("user",JSONObject().put("id",user).put("email","fixture@example.com")).put("access_token",access).put("refresh_token",refresh).put("expires_in",3600)
    private data class Captured(val head: String,val body: ByteArray)
    private fun read(socket: Socket): Captured {
        val input=socket.getInputStream();val header=ByteArrayOutputStream()
        while(!header.toString("US-ASCII").endsWith("\r\n\r\n")) { val b=input.read();check(b>=0);header.write(b);check(header.size()<16_384) }
        val head=header.toString("US-ASCII");val size=Regex("Content-Length: ([0-9]+)",RegexOption.IGNORE_CASE).find(head)?.groupValues?.get(1)?.toInt() ?: 0
        val bytes=ByteArray(size);var count=0
        while(count<size) { val n=input.read(bytes,count,size-count);check(n>0);count+=n }
        return Captured(head,bytes)
    }
    private fun reply(socket: Socket,bytes: ByteArray,status: Int=200,retry: String?=null) {
        val extra=retry?.let { "Retry-After: $it\r\n" }.orEmpty()
        socket.getOutputStream().apply { write("HTTP/1.1 $status Result\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\n${extra}Connection: close\r\n\r\n".toByteArray());write(bytes);flush() }
    }
    @After fun cleanup() { store.signOut();root.deleteRecursively() }

    @Test fun emailCodeLoginPersistsOnlyEncryptedSessionAndDoesNotUsePublicKeyAsUserToken()=runBlocking {
        ServerSocket(0).use { server ->
            val requests=mutableListOf<Captured>()
            val worker=launch(Dispatchers.IO) {
                server.accept().use { requests.add(read(it));reply(it,"{}".toByteArray()) }
                server.accept().use { requests.add(read(it));reply(it,sessionBody().toString().toByteArray()) }
            }
            val client=SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}")
            client.sendCode("fixture@example.com");val session=client.verifyCode("123456");worker.join()
            assertEquals(account,session.userId);assertEquals(access,BackupSessionStore(context,namespace).session()!!.accessToken)
            assertTrue(requests[0].head.startsWith("POST /auth/v1/otp "));assertTrue(requests[1].head.startsWith("POST /auth/v1/verify "))
            assertTrue(requests.all { it.head.contains("apikey: ${BuildConfig.SUPABASE_PUBLISHABLE_KEY}") && !it.head.contains("Authorization:") })
            assertEquals("email",JSONObject(String(requests[1].body)).getString("type"))
            val raw=context.getSharedPreferences("backup-private-$namespace",Context.MODE_PRIVATE).all.values.joinToString()
            for(value in listOf(access,refresh,"fixture@example.com","123456")) assertFalse(raw.contains(value))
        }
    }
    @Test fun expiredSessionRefreshCannotSwitchTheBackupOwner()=runBlocking {
        val original=BackupSession(account,access,refresh,0);store.save(original)
        ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) { server.accept().use { val captured=read(it);assertTrue(captured.head.contains("grant_type=refresh_token"));reply(it,sessionBody(UUID.randomUUID().toString()).toString().toByteArray()) } }
            try { SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}").session();fail("Owner change accepted") }
            catch(expected: IllegalArgumentException) { assertEquals(original,store.session()) };worker.join()
        }
    }
    @Test fun uploadListAndDownloadUseTheLoggedInOwnerAndNeverOverwriteBackups()=runBlocking {
        val session=BackupSession(account,access,refresh,System.currentTimeMillis()+3600_000);store.save(session)
        val fixture=File(root,"snapshot.zip").apply { writeBytes(ByteArray(4096) { (it%251).toByte() }) }
        val requests=mutableListOf<Captured>();var name=""
        ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) {
                server.accept().use { val capture=read(it);requests.add(capture);name=capture.head.lineSequence().first().substringAfter("$account/").substringBefore(" HTTP");reply(it,"{}".toByteArray()) }
                server.accept().use { requests.add(read(it));reply(it,JSONArray().put(JSONObject().put("name",name).put("metadata",JSONObject().put("size",fixture.length()))).toString().toByteArray()) }
                server.accept().use { requests.add(read(it));reply(it,fixture.readBytes()) }
            }
            val client=SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}")
            val uploaded=client.upload(PreparedMemoryBackup(fixture,"digest",1),session);assertEquals(uploaded,client.list(session).single())
            val download=File(root,"download.zip");client.download(uploaded,session,download);worker.join()
            assertArrayEquals(fixture.readBytes(),download.readBytes())
            assertTrue(requests[0].head.contains("x-upsert: false"));assertArrayEquals(fixture.readBytes(),requests[0].body)
            assertEquals(account+"/",JSONObject(String(requests[1].body)).getString("prefix"))
            assertTrue(requests.all { it.head.contains("Authorization: Bearer $access") })
            assertTrue(requests[2].head.startsWith("GET /storage/v1/object/authenticated/${SupabaseBackupClient.BUCKET}/$account/"))
        }
    }
    @Test fun failedOrShortDownloadsCannotLeaveAPartialFileAndErrorsDoNotExposeTokens()=runBlocking {
        val session=BackupSession(account,access,refresh,Long.MAX_VALUE)
        for(status in listOf(401,403,404)) ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) { server.accept().use { read(it);reply(it,JSONObject().put("message",access).toString().toByteArray(),status) } }
            val target=File(root,"failed-$status.zip")
            try { SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}").download(CloudMemoryBackup("1700000000000-${UUID.randomUUID()}.zip",3),session,target);fail("Error accepted") }
            catch(expected: BackupApiException) { assertFalse(expected.message!!.contains(access));assertFalse(target.exists()) };worker.join()
        }
        ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) { server.accept().use { read(it);reply(it,byteArrayOf(1,2,3)) } }
            val target=File(root,"short.zip")
            try { SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}").download(CloudMemoryBackup("1700000000000-${UUID.randomUUID()}.zip",4),session,target);fail("Truncated file accepted") }
            catch(expected: IllegalArgumentException) { assertFalse(target.exists()) };worker.join()
        }
    }
    @Test fun foreignPathAndUnarmedLoginCommandsCannotLeakUserData()=runBlocking {
        assertTrue(MemoryBackupCoordinator.accepts("备份记忆"));assertTrue(MemoryBackupCoordinator.accepts("恢复记忆。"))
        assertTrue(MemoryBackupCoordinator.sensitive("验证码 123456"));assertTrue(MemoryBackupCoordinator.sensitive("登录备份 fixture@example.com"))
        assertFalse(MemoryBackupCoordinator.accepts("帮我找水杯"))
        val client=SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:1")
        try { client.verifyCode("123456");fail("Code without a pending login accepted") } catch(expected: IllegalStateException) { assertNull(store.session()) }
        try { client.download(CloudMemoryBackup("../someone-else.zip",3),BackupSession(account,access,refresh,Long.MAX_VALUE),File(root,"never.zip"));fail("Unsafe path accepted") }
        catch(expected: IllegalArgumentException) { assertFalse(File(root,"never.zip").exists()) }
    }
    @Test fun tamperedStoredSessionCannotAuthenticateOrExposeAnEmail() {
        store.save(BackupSession(account,access,refresh,Long.MAX_VALUE))
        context.getSharedPreferences("backup-private-$namespace",Context.MODE_PRIVATE).edit().putString("ciphertext","AAAA").commit()
        assertNull(store.session());assertNull(store.pending())
    }
    @Test fun defaultEmailLinkIsVerifiedAtTheFixedEndpointWithoutFollowingItsRedirect()=runBlocking {
        store.pending("fixture@example.com");val hash="a".repeat(64)
        ServerSocket(0).use { server ->
            val captured=CompletableDeferred<Captured>()
            val worker=launch(Dispatchers.IO) { server.accept().use { captured.complete(read(it));reply(it,sessionBody().toString().toByteArray()) } }
            val client=SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}")
            val result=client.verifyEmailLink("https://awkzcvvzrsfjvqlloqqi.supabase.co/auth/v1/verify?token=$hash&type=magiclink&redirect_to=https%3A%2F%2Funtrusted.invalid")
            assertEquals(account,result.userId);val request=captured.await();assertTrue(request.head.startsWith("POST /auth/v1/verify "))
            val body=JSONObject(String(request.body));assertEquals(hash,body.getString("token_hash"));assertFalse(body.has("redirect_to"));worker.join()
            assertTrue(MemoryBackupCoordinator.sensitive("登录链接 secret"))
            assertTrue(MemoryBackupCoordinator.sensitive("https://awkzcvvzrsfjvqlloqqi.supabase.co/auth/v1/verify?token=$hash&type=email"))
        }
    }
    @Test fun foreignOrWrongPurposeLoginLinksAndMismatchedEmailsCannotSaveASession()=runBlocking {
        store.pending("fixture@example.com");val hash="a".repeat(64)
        val client=SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:1")
        for(link in listOf("https://other.supabase.co/auth/v1/verify?token=$hash&type=magiclink","https://awkzcvvzrsfjvqlloqqi.supabase.co/auth/v1/verify?token=$hash&type=recovery")) {
            try { client.verifyEmailLink(link);fail("Unsafe login link accepted") } catch(expected: IllegalArgumentException) { assertNull(store.session()) }
        }
        ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) { server.accept().use { read(it);reply(it,sessionBody().apply { getJSONObject("user").put("email","another@example.com") }.toString().toByteArray()) } }
            try { SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}").verifyCode("123456");fail("Wrong email accepted") }
            catch(expected: IllegalArgumentException) { assertNull(store.session()) };worker.join()
        }
    }
    @Test fun productionTokenRefreshUsesTheProjectRelayAndCannotFallBackToAnUnreachableDirectHost()=runBlocking {
        store.save(BackupSession(account,access,refresh,0))
        val http=OkHttpClient.Builder().addInterceptor { chain ->
            val request=chain.request();assertEquals("i-see-you-android-core-test.pages.dev",request.url.host)
            assertEquals("/api/android/backup/auth/v1/token",request.url.encodedPath);assertEquals("refresh_token",request.url.queryParameter("grant_type"))
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(sessionBody().toString().toResponseBody("application/json".toMediaType())).build()
        }.build()
        assertEquals(account,SupabaseBackupClient(store,http=http).session().userId)
    }
    @Test fun encryptedEmailProofIsDeviceBoundExpiresAndCanBeConsumedOnlyOnce() {
        store.pending("fixture@example.com");val prepared=store.prepareEmailProof();val hash="a".repeat(64)
        val publicKey=KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(prepared.getString("publicKey"))))
        val cipher=Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").apply {
            init(Cipher.ENCRYPT_MODE,publicKey,OAEPParameterSpec("SHA-256","MGF1",MGF1ParameterSpec.SHA1,PSource.PSpecified.DEFAULT))
        }
        val data=JSONObject().put("token_hash",hash).put("type","magiclink").toString().toByteArray()
        val envelope=JSONObject().put("nonce",prepared.getString("nonce")).put("ciphertext",Base64.getEncoder().encodeToString(cipher.doFinal(data)))
        assertFalse(envelope.toString().contains(hash))
        try { store.consumeEmailProof(envelope,prepared.getLong("expiresAt")+1);fail("Expired proof accepted") } catch(expected: IllegalArgumentException) { assertNull(store.session()) }
        val link=store.consumeEmailProof(envelope);assertTrue(link.endsWith("token=$hash&type=magiclink"))
        try { store.consumeEmailProof(envelope);fail("Proof replay accepted") } catch(expected: IllegalArgumentException) { assertNull(store.session()) }
    }
    @Test fun waitingForEmailSurvivesTwentyMinutesAndReopenButNeverAuthenticatesWithoutVerification() {
        val now=System.currentTimeMillis();store.pending("fixture@example.com",now-1_200_000)
        val reopened=BackupSessionStore(context,namespace)
        assertEquals("fixture@example.com",reopened.pending(now));assertTrue(reopened.pendingRemainingSeconds(now)>2000)
        assertNull(reopened.session());assertNull(reopened.pending(now+2_400_001))
        assertTrue(MemoryBackupCoordinator.sensitive("重发备份邮件 fixture@example.com"))
    }
    @Test fun repeatedLoginReusesTheUnfinishedRequestAndExplicitResendHonorsTheCooldown()=runBlocking {
        var requests=0
        val http=OkHttpClient.Builder().addInterceptor { chain ->
            requests++;Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body("{}".toResponseBody("application/json".toMediaType())).build()
        }.build()
        val client=SupabaseBackupClient(store,http=http,testEndpoint="http://127.0.0.1:1")
        assertTrue(client.sendCode("fixture@example.com"));assertFalse(client.sendCode("FIXTURE@example.com"))
        try { client.sendCode("fixture@example.com",resend=true);fail("Immediate resend should be held locally") }
        catch(expected: BackupApiException) { assertEquals(429,expected.status);assertTrue(expected.retryAfterSeconds!!>0) }
        assertEquals(1,requests);assertNull(store.session())
    }
    @Test fun emailQuotaFailureIsIdentifiedWithoutLeakingTheProviderBodyAndRepeatedSendingIsHeld()=runBlocking {
        var requests=0
        ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) { server.accept().use {
                read(it);requests++;reply(it,JSONObject().put("code","over_email_send_rate_limit").put("message",access).toString().toByteArray(),429,"90")
            } }
            val client=SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}")
            try { client.sendCode("fixture@example.com");fail("Quota failure accepted") }
            catch(expected: BackupApiException) {
                assertEquals("over_email_send_rate_limit",expected.providerCode);assertEquals(90L,expected.retryAfterSeconds)
                assertTrue(expected.message!!.contains("每小时两封"));assertFalse(expected.message!!.contains(access))
            }
            try { client.sendCode("fixture@example.com");fail("Cooldown ignored") }
            catch(expected: BackupApiException) { assertEquals(429,expected.status);assertTrue(expected.retryAfterSeconds!!>60) }
            worker.join();assertEquals(1,requests);assertNull(store.pending());assertNull(store.session())
        }
    }
    @Test fun serverRejectingAnExpiredOrConsumedLinkClearsOnlyThePendingRequestAndAllowsAFreshEmail()=runBlocking {
        store.pending("fixture@example.com");val hash="a".repeat(64)
        ServerSocket(0).use { server ->
            val worker=launch(Dispatchers.IO) {
                server.accept().use { read(it);reply(it,"{\"error_code\":\"otp_expired\"}".toByteArray(),403) }
                server.accept().use { read(it);reply(it,"{}".toByteArray()) }
            }
            val client=SupabaseBackupClient(store,testEndpoint="http://127.0.0.1:${server.localPort}")
            try { client.verifyEmailLink("https://awkzcvvzrsfjvqlloqqi.supabase.co/auth/v1/verify?token=$hash&type=magiclink");fail("Expired link authenticated") }
            catch(expected: BackupApiException) { assertEquals("otp_expired",expected.providerCode);assertNull(store.pending());assertNull(store.session()) }
            assertTrue(client.sendCode("fixture@example.com"));assertNotNull(store.pending());assertNull(store.session());worker.join()
        }
    }
    @Test fun unrecognizedErrorCodesAndUnboundedRetryValuesCannotEnterDiagnostics()=runBlocking {
        val http=OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(429).message("Limit")
                .header("Retry-After","999999999999").body(JSONObject().put("code",access).put("message",refresh).toString().toResponseBody("application/json".toMediaType())).build()
        }.build()
        try { SupabaseBackupClient(store,http=http,testEndpoint="http://127.0.0.1:1").sendCode("fixture@example.com");fail("Limit accepted") }
        catch(expected: BackupApiException) { assertNull(expected.providerCode);assertNull(expected.retryAfterSeconds);assertFalse(expected.message!!.contains(access));assertFalse(expected.message!!.contains(refresh)) }
    }
}
