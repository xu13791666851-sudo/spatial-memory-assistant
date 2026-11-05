package com.spatialmemory.assistant.pc

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import org.json.JSONObject

data class PcProfile(val host: String,val port: Int,val fingerprint: String,val token: String) {
    val origin get()="https://$host:$port"
    fun http(): OkHttpClient {
        val trust=object: X509TrustManager {
            override fun getAcceptedIssuers()=emptyArray<X509Certificate>()
            override fun checkClientTrusted(chain: Array<X509Certificate>?,authType: String?) { error("Client certificates are not supported") }
            override fun checkServerTrusted(chain: Array<X509Certificate>?,authType: String?) {
                val certificate=chain?.firstOrNull() ?: error("Missing PC certificate")
                certificate.checkValidity()
                val actual=MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
                require(actual==fingerprint) { "电脑身份发生变化，请重新连接电脑" }
            }
        }
        val tls=SSLContext.getInstance("TLS").apply { init(null,arrayOf(trust),SecureRandom()) }
        return OkHttpClient.Builder().sslSocketFactory(tls.socketFactory,trust).hostnameVerifier { hostname,_ -> hostname==host }
            .followRedirects(false).followSslRedirects(false).connectTimeout(8,TimeUnit.SECONDS).readTimeout(0,TimeUnit.SECONDS).callTimeout(60,TimeUnit.SECONDS).build()
    }
    companion object {
        fun parse(raw: String): PcProfile {
            val uri=Uri.parse(raw.trim())
            require(uri.scheme=="iseeyou-pc"&&uri.host=="pair"&&uri.userInfo==null&&uri.fragment==null&&uri.queryParameterNames==setOf("host","port","fingerprint","token")) { "电脑连接地址无效" }
            val host=uri.getQueryParameter("host").orEmpty()
            require(Regex("^(?:127\\.0\\.0\\.1|10\\.(?:[0-9]{1,3}\\.){2}[0-9]{1,3}|192\\.168\\.[0-9]{1,3}\\.[0-9]{1,3}|172\\.(?:1[6-9]|2[0-9]|3[01])\\.[0-9]{1,3}\\.[0-9]{1,3})$").matches(host)&&host.split('.').all { it.toInt() in 0..255 }) { "请使用电脑的局域网地址" }
            val port=uri.getQueryParameter("port")?.toIntOrNull() ?: error("电脑端口无效")
            val fingerprint=uri.getQueryParameter("fingerprint").orEmpty();val token=uri.getQueryParameter("token").orEmpty()
            require(port in 1024..65535&&fingerprint.matches(Regex("[a-f0-9]{64}"))&&token.matches(Regex("[A-Za-z0-9_-]{43}"))) { "电脑连接地址不完整" }
            return PcProfile(host,port,fingerprint,token)
        }
    }
}

/** Pairing is scoped to this app. No system certificates, proxy or Wi-Fi changes. */
class PcConnection(context: Context) {
    private val prefs=context.getSharedPreferences("pc-private",Context.MODE_PRIVATE)
    private val alias="iseeyou.pc.pairing"
    private fun secret(): SecretKey {
        val keys=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (keys.getKey(alias,null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun save(raw: String) {
        PcProfile.parse(raw)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,secret()) }
        val encrypted=cipher.doFinal(raw.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("data",Base64.getEncoder().encodeToString(encrypted)).putString("iv",Base64.getEncoder().encodeToString(cipher.iv)).commit())
    }
    fun read(): PcProfile?=runCatching {
        val encrypted=prefs.getString("data",null) ?: return null
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE,secret(),GCMParameterSpec(128,Base64.getDecoder().decode(prefs.getString("iv",null)))) }
        PcProfile.parse(String(cipher.doFinal(Base64.getDecoder().decode(encrypted)),Charsets.UTF_8))
    }.getOrNull()
}
