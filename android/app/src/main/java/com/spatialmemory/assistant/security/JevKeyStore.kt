package com.spatialmemory.assistant.security

import android.content.Context
import com.spatialmemory.assistant.realtime.JevProvider
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
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

/** The API credential is encrypted with a non-exportable Android Keystore AES key. */
class JevKeyStore(context: Context, namespace: String = "main", val provider: JevProvider = JevProvider.TYPESAFE) {
    init { require(namespace.matches(Regex("[A-Za-z0-9_-]{1,80}"))) }
    private val scope = if (provider == JevProvider.TYPESAFE) namespace else "${provider.id}-$namespace"
    private val prefs = context.getSharedPreferences("jev-private-$scope", Context.MODE_PRIVATE)
    private val aesAlias = "iseeyou.jev.aes.$scope"
    private val rsaAlias = "iseeyou.jev.import.$scope"
    private fun keys() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun aes(): SecretKey = (keys().getKey(aesAlias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
        init(KeyGenParameterSpec.Builder(aesAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
    }.generateKey()

    @Synchronized fun save(value: String) {
        require(value.matches(provider.keyPattern)) { "${provider.label} 密钥格式不正确" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, aes()) }
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("ciphertext", Base64.getEncoder().encodeToString(encrypted))
            .putString("iv", Base64.getEncoder().encodeToString(cipher.iv)).putString("revision", UUID.randomUUID().toString()).remove("verified").commit())
    }
    @Synchronized fun read(): String? = runCatching {
        val data = prefs.getString("ciphertext", null) ?: return null
        val iv = Base64.getDecoder().decode(prefs.getString("iv", null) ?: return null)
        val secret = keys().getKey(aesAlias, null) as? SecretKey ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, iv)) }
        String(cipher.doFinal(Base64.getDecoder().decode(data)), Charsets.UTF_8)
    }.getOrNull()
    fun revision(): String? = prefs.getString("revision", null)
    fun isVerified(): Boolean = read() != null && (revision()?.let { it == prefs.getString("verified", null) } ?: false)
    fun markVerified(expectedRevision: String) { if (expectedRevision == revision()) check(prefs.edit().putString("verified", expectedRevision).commit()) }
    fun clearVerification() { check(prefs.edit().remove("verified").commit()) }
    fun remove() { check(prefs.edit().clear().commit());val store = keys();store.deleteEntry(aesAlias);store.deleteEntry(rsaAlias) }

    /** Host-side provisioning uses this public key, never a plaintext file or IME. */
    @Synchronized fun prepareImport(now: Long = System.currentTimeMillis()): JSONObject {
        if (!keys().containsAlias(rsaAlias)) KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(rsaAlias, KeyProperties.PURPOSE_DECRYPT).setKeySize(2048)
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP).build())
        }.generateKeyPair()
        val nonce = UUID.randomUUID().toString();val expiry = now + 600_000
        check(prefs.edit().putString("importNonce", nonce).putLong("importExpires", expiry).commit())
        return JSONObject().put("nonce", nonce).put("expiresAt", expiry).put("provider", provider.id)
            .put("publicKey", Base64.getEncoder().encodeToString(keys().getCertificate(rsaAlias).publicKey.encoded))
    }
    @Synchronized fun importEncrypted(envelope: JSONObject, now: Long = System.currentTimeMillis()) {
        val nonce = prefs.getString("importNonce", null) ?: error("导入请求已失效")
        require(envelope.optString("provider", "typesafe") == provider.id && envelope.optString("nonce") == nonce && now <= prefs.getLong("importExpires", 0)) { "导入请求已失效" }
        val cipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").apply {
            init(Cipher.DECRYPT_MODE, keys().getKey(rsaAlias, null), OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT))
        }
        val decrypted = cipher.doFinal(Base64.getDecoder().decode(envelope.getString("ciphertext")))
        try { save(String(decrypted, Charsets.UTF_8)) } finally { decrypted.fill(0) }
        check(prefs.edit().remove("importNonce").remove("importExpires").putString("debugNonce", nonce).putLong("debugExpires", now + 600_000).commit())
    }
    fun allowsDebugTest(nonce: String): Boolean = nonce.isNotBlank() && nonce == prefs.getString("debugNonce", null) && System.currentTimeMillis() <= prefs.getLong("debugExpires", 0)
}
