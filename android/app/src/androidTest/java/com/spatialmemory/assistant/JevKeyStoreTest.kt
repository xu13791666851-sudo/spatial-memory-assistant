package com.spatialmemory.assistant

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.spatialmemory.assistant.security.JevKeyStore
import com.spatialmemory.assistant.realtime.JevProvider
import java.security.KeyFactory
import java.security.spec.X509EncodedKeySpec
import java.security.spec.MGF1ParameterSpec
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class JevKeyStoreTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val first = "apikey_" + "fake_first_".repeat(8)
    private val second = "apikey_" + "fake_second_".repeat(8)
    private fun fixture(block: (JevKeyStore, String) -> Unit) {
        val namespace = "test-" + UUID.randomUUID().toString();val store = JevKeyStore(context, namespace)
        try { block(store, namespace) } finally { store.remove() }
    }
    private fun envelope(prepared: JSONObject, key: String): JSONObject {
        val public = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(prepared.getString("publicKey"))))
        val cipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").apply {
            init(Cipher.ENCRYPT_MODE, public, OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT))
        }
        return JSONObject().put("nonce", prepared.getString("nonce")).put("provider", prepared.optString("provider", "typesafe")).put("ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(key.toByteArray(Charsets.UTF_8))))
    }
    @Test fun encryptedSecretSurvivesReopenWithoutPlaintextInPreferences() = fixture { store, namespace ->
        store.save(first);assertEquals(first, JevKeyStore(context, namespace).read())
        assertFalse(context.getSharedPreferences("jev-private-$namespace", Context.MODE_PRIVATE).all.values.any { it.toString().contains(first) })
        assertFalse(store.isVerified());store.markVerified(store.revision()!!);assertTrue(store.isVerified())
        store.save(second);assertEquals(second, store.read());assertFalse(store.isVerified())
    }
    @Test fun tamperedCiphertextCannotRecoverAKeyOrKeepVerifiedStatus() = fixture { store, namespace ->
        store.save(first);store.markVerified(store.revision()!!)
        context.getSharedPreferences("jev-private-$namespace", Context.MODE_PRIVATE).edit().putString("ciphertext", "AAAA").commit()
        assertNull(store.read());assertFalse(store.isVerified())
    }
    @Test fun encryptedProvisioningIsBoundToThisDeviceAndCannotBeReplayed() = fixture { store, _ ->
        store.save(first);val prepared = store.prepareImport();val data = envelope(prepared, second)
        assertFalse(data.toString().contains(second));store.importEncrypted(data);assertEquals(second, store.read())
        try { store.importEncrypted(data);fail("Replayed envelope accepted") } catch (expected: IllegalStateException) { assertEquals(second, store.read()) }
    }
    @Test fun badNonceOrExpiredImportPreservesThePreviousKey() = fixture { store, _ ->
        store.save(first);val prepared = store.prepareImport();val data = envelope(prepared, second)
        try { store.importEncrypted(JSONObject(data.toString()).put("nonce", "wrong"));fail("Wrong nonce accepted") } catch (expected: IllegalArgumentException) { assertEquals(first, store.read()) }
        try { store.importEncrypted(data, prepared.getLong("expiresAt") + 1);fail("Expired envelope accepted") } catch (expected: IllegalArgumentException) { assertEquals(first, store.read()) }
    }
    @Test fun providersKeepSeparateEncryptedKeysAndVerificationAndRemoval() = fixture { typesafe, namespace ->
        val openrouter = JevKeyStore(context, namespace, JevProvider.OPENROUTER)
        val routerKey = "sk-or-v1-" + "b".repeat(64)
        try {
            typesafe.save(first);openrouter.save(routerKey);openrouter.markVerified(openrouter.revision()!!)
            assertEquals(first, typesafe.read());assertEquals(routerKey, JevKeyStore(context, namespace, JevProvider.OPENROUTER).read())
            assertFalse(typesafe.isVerified());assertTrue(openrouter.isVerified())
            assertFalse(context.getSharedPreferences("jev-private-openrouter-$namespace", Context.MODE_PRIVATE).all.values.any { it.toString().contains(routerKey) })
            openrouter.remove();assertNull(openrouter.read());assertEquals(first, typesafe.read())
        } finally { openrouter.remove() }
    }
    @Test fun encryptedImportsCannotCrossProviderBoundaries() = fixture { _, namespace ->
        val openrouter = JevKeyStore(context, namespace, JevProvider.OPENROUTER)
        try {
            val routerKey = "sk-or-v1-" + "c".repeat(64)
            val prepared = openrouter.prepareImport();val data = envelope(prepared, routerKey)
            try { openrouter.importEncrypted(JSONObject(data.toString()).put("provider", "typesafe"));fail("Wrong provider accepted") }
            catch (expected: IllegalArgumentException) { assertNull(openrouter.read()) }
            openrouter.importEncrypted(data);assertEquals(routerKey, openrouter.read())
        } finally { openrouter.remove() }
    }
}
