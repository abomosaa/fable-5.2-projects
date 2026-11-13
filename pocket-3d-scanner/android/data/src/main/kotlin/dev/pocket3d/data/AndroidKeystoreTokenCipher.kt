package dev.pocket3d.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM with a key that lives in the Android Keystore and never leaves it. The blob is
 * `[1 byte IV length][IV][ciphertext+tag]`. If the key is gone (app data restored on another
 * device) decryption fails and the phone simply has to be paired again.
 */
class AndroidKeystoreTokenCipher(private val alias: String = "pocket3d.companion.token.v1") : TokenCipher {

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    @Synchronized
    override fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())   // the keystore generates a fresh random IV
        val iv = cipher.iv
        val ct = cipher.doFinal(plain)
        return byteArrayOf(iv.size.toByte()) + iv + ct
    }

    @Synchronized
    override fun decrypt(blob: ByteArray): ByteArray {
        require(blob.size > 1) { "empty blob" }
        val ivLen = blob[0].toInt()
        require(ivLen in 12..16 && blob.size > 1 + ivLen) { "malformed blob" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 1, ivLen))
        return cipher.doFinal(blob, 1 + ivLen, blob.size - 1 - ivLen)
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
