package com.spatialmemory.assistant.backup

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.KeyPairGenerator
import java.security.spec.MGF1ParameterSpec
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import org.json.JSONObject

data class BackupSession(val userId: String, val accessToken: String, val refreshToken: String, val expiresAtMs: Long)

/** Tokens and the pending login email never enter ordinary preferences or backups. */
class BackupSessionStore(context: Context, namespace: String = "main") {
    init { require(namespace.matches(Regex("[A-Za-z0-9_-]{1,80}"))) }
    private val prefs=context.getSharedPreferences("backup-private-$namespace",Context.MODE_PRIVATE)
    private val alias="iseeyou.backup.$namespace"
    private val importAlias="$alias.email-proof"
    private fun keystore()=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun secret(): SecretKey=(keystore().getKey(alias,null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
        init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
    @Synchronized private fun read(): JSONObject = runCatching {
        val encoded=prefs.getString("ciphertext",null) ?: return JSONObject()
        val key=keystore().getKey(alias,null) as? SecretKey ?: return JSONObject()
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE,key,GCMParameterSpec(128,Base64.getDecoder().decode(prefs.getString("iv",null)))) }
        JSONObject(String(cipher.doFinal(Base64.getDecoder().decode(encoded)),Charsets.UTF_8))
    }.getOrElse { JSONObject() }
    @Synchronized private fun write(value: JSONObject) {
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,secret()) }
        val data=cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("ciphertext",Base64.getEncoder().encodeToString(data)).putString("iv",Base64.getEncoder().encodeToString(cipher.iv)).commit())
    }
    @Synchronized fun session(): BackupSession? = runCatching {
        val value=read();if(value.has("pendingEmail")) return null
        val session=value.optJSONObject("session") ?: return null
        BackupSession(session.getString("userId"),session.getString("accessToken"),session.getString("refreshToken"),session.getLong("expiresAtMs"))
    }.getOrNull()
    @Synchronized fun save(session: BackupSession) {
        val value=read().apply { remove("pendingEmail");remove("pendingUntil") }
        value.put("session",JSONObject().put("userId",session.userId).put("accessToken",session.accessToken).put("refreshToken",session.refreshToken).put("expiresAtMs",session.expiresAtMs));write(value)
    }
    // This is only the local request context, not proof of authentication.
    // Supabase still verifies the one-use link and its actual server expiry.
    @Synchronized fun pending(email: String,now: Long=System.currentTimeMillis()) {
        write(read().put("pendingEmail",email).put("pendingStartedAt",now).put("pendingUntil",now+3_600_000))
    }
    @Synchronized fun pendingRemainingSeconds(now: Long=System.currentTimeMillis()): Long = read().let {
        val start=if(it.has("pendingStartedAt")) it.optLong("pendingStartedAt") else it.optLong("pendingUntil")-900_000
        if(it.optString("pendingEmail").isBlank() || start<0 || start>now) 0L else ((start+3_600_000-now)/1000).coerceAtLeast(0L)
    }
    @Synchronized fun pending(now: Long=System.currentTimeMillis()): String? = if(pendingRemainingSeconds(now)>0) read().optString("pendingEmail").takeIf(String::isNotBlank) else null
    @Synchronized fun mailAttemptAllowedAt(): Long = read().optLong("mailAttemptAllowedAt")
    @Synchronized fun mailAttempted(now: Long=System.currentTimeMillis(),waitSeconds: Long=60) {
        write(read().put("mailAttemptAllowedAt",now+waitSeconds.coerceIn(1,3600)*1000))
    }
    @Synchronized fun cancelPending() { write(read().apply { remove("pendingEmail");remove("pendingUntil") }) }
    @Synchronized fun lastDigest(userId: String): String? = read().optJSONObject("digests")?.optString(userId)?.takeIf(String::isNotBlank)
    @Synchronized fun uploaded(userId: String,digest: String) { val value=read();val digests=value.optJSONObject("digests") ?: JSONObject();digests.put(userId,digest);write(value.put("digests",digests)) }
    @Synchronized fun prepareEmailProof(now: Long=System.currentTimeMillis()): JSONObject {
        require(pending()!=null) { "请先发起备份登录" }
        if(!keystore().containsAlias(importAlias)) KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA,"AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(importAlias,KeyProperties.PURPOSE_DECRYPT).setKeySize(2048)
                .setDigests(KeyProperties.DIGEST_SHA256,KeyProperties.DIGEST_SHA1).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP).build())
        }.generateKeyPair()
        val nonce=UUID.randomUUID().toString();val expiry=now+300_000
        write(read().put("proofNonce",nonce).put("proofUntil",expiry))
        return JSONObject().put("nonce",nonce).put("expiresAt",expiry).put("publicKey",Base64.getEncoder().encodeToString(keystore().getCertificate(importAlias).publicKey.encoded))
    }
    @Synchronized fun consumeEmailProof(envelope: JSONObject,now: Long=System.currentTimeMillis()): String {
        val state=read();val nonce=state.optString("proofNonce")
        require(nonce.isNotBlank() && nonce==envelope.optString("nonce") && now<=state.optLong("proofUntil")) { "登录证明已失效" }
        val cipher=Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").apply {
            init(Cipher.DECRYPT_MODE,keystore().getKey(importAlias,null),OAEPParameterSpec("SHA-256","MGF1",MGF1ParameterSpec.SHA1,PSource.PSpecified.DEFAULT))
        }
        val data=cipher.doFinal(Base64.getDecoder().decode(envelope.getString("ciphertext")))
        try {
            val proof=JSONObject(String(data,Charsets.UTF_8));val hash=proof.getString("token_hash");val type=proof.getString("type")
            require(hash.matches(Regex("[A-Za-z0-9_-]{20,128}")) && type in setOf("email","signup","magiclink"))
            write(state.apply { remove("proofNonce");remove("proofUntil") })
            return "https://awkzcvvzrsfjvqlloqqi.supabase.co/auth/v1/verify?token=$hash&type=$type"
        } finally { data.fill(0) }
    }
    @Synchronized fun signOut() { check(prefs.edit().clear().commit());keystore().deleteEntry(alias);keystore().deleteEntry(importAlias) }
}
