package com.diubi.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.IBinder
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlin.concurrent.thread

// Captures audio playing in other apps - MediaProjection +
// AudioPlaybackCaptureConfiguration, proven working on real hardware in
// research/mobile-audio-poc/android - and feeds it to the DIUBI web app
// running in MainActivity's WebView via onAudioChunk, resampled to
// TARGET_SAMPLE_RATE so the server sees byte-for-byte the same kind of
// audio_chunk messages it already gets from a browser tab (see
// public/app.js startCapture(); TARGET_SAMPLE_RATE must match server.js).
class CaptureService : Service() {

    companion object {
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        private const val TAG = "DiubiCapture"
        private const val CHANNEL_ID = "diubi_capture"
        private const val NATIVE_SAMPLE_RATE = 44100
        private const val TARGET_SAMPLE_RATE = 24000 // must match TARGET_SAMPLE_RATE in server.js / public/app.js

        // Set by MainActivity before starting the service. Called on the
        // capture thread with each base64-encoded PCM16 mono chunk, ready to
        // hand straight to the page's diubiFeedAudioChunk(base64).
        var onAudioChunk: ((String) -> Unit)? = null
    }

    private var mediaProjection: MediaProjection? = null
    private var audioRecord: AudioRecord? = null
    @Volatile private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        if (resultData == null) {
            Log.e(TAG, "Missing projection result data, stopping")
            stopSelf()
            return START_NOT_STICKY
        }

        val projectionManager = getSystemService(MediaProjectionManager::class.java)
        val projection = projectionManager.getMediaProjection(resultCode, resultData)
        mediaProjection = projection
        startCapture(projection)

        return START_STICKY
    }

    private fun startAsForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "DIUBI nasluch", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("DIUBI nasluchuje")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .build()
        startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    }

    private fun startCapture(projection: MediaProjection) {
        val captureConfig = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()

        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(NATIVE_SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()

        val minBufferSize = AudioRecord.getMinBufferSize(
            NATIVE_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )

        audioRecord = AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(minBufferSize * 4)
            .setAudioPlaybackCaptureConfig(captureConfig)
            .build()

        audioRecord?.startRecording()
        running = true

        thread(name = "diubi-capture") { readLoop() }
    }

    private fun readLoop() {
        val buffer = ShortArray(2048)
        // Nearest-neighbor downsampling, same approach public/app.js uses
        // for its own browser-side capture path (see startCapture() there).
        val ratio = NATIVE_SAMPLE_RATE.toDouble() / TARGET_SAMPLE_RATE
        while (running) {
            val record = audioRecord ?: break
            val read = record.read(buffer, 0, buffer.size)
            if (read <= 0) continue

            val outLength = (read / ratio).toInt()
            if (outLength <= 0) continue

            val bytes = ByteArray(outLength * 2)
            for (i in 0 until outLength) {
                val s = buffer[(i * ratio).toInt()].toInt()
                bytes[i * 2] = (s and 0xFF).toByte()
                bytes[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
            }
            val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
            onAudioChunk?.invoke(base64)
        }
    }

    override fun onDestroy() {
        running = false
        audioRecord?.stop()
        audioRecord?.release()
        mediaProjection?.stop()
        onAudioChunk = null
        super.onDestroy()
    }
}
