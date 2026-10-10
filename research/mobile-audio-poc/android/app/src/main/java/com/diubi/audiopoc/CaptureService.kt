package com.diubi.audiopoc

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
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.io.FileOutputStream
import kotlin.concurrent.thread
import kotlin.math.sqrt

// Minimal proof-of-concept foreground service. Goal: confirm we receive
// non-silent PCM audio buffers originating from another app's media
// playback (Spotify/YouTube), via AudioPlaybackCaptureConfiguration.
// No ASR/translation here - just RMS logging plus a short raw PCM dump
// so a developer can manually confirm the captured audio is real.
class CaptureService : Service() {

    companion object {
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        private const val TAG = "DIUBI_POC"
        private const val CHANNEL_ID = "diubi_poc_capture"
        private const val SAMPLE_RATE = 44100
        private const val MAX_DUMP_BYTES = 10 * 1024 * 1024 // cap the raw dump at 10MB

        // Read by MainActivity's polling loop so the live RMS shows up
        // directly on screen - no adb/Logcat needed to confirm capture
        // is working. Service and Activity share the same process here.
        @Volatile var lastRms: Double = 0.0
        @Volatile var bufferCount: Long = 0
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
                NotificationChannel(CHANNEL_ID, "DIUBI Audio POC", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("DIUBI Audio POC capturing")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .build()

        // minSdk is 29, so the typed three-arg startForeground is always available.
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
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()

        val minBufferSize = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )

        audioRecord = AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(minBufferSize * 4)
            .setAudioPlaybackCaptureConfig(captureConfig)
            .build()

        audioRecord?.startRecording()
        running = true

        thread(name = "diubi-poc-capture") { readLoop() }
    }

    private fun readLoop() {
        val buffer = ShortArray(2048)
        val dumpFile = File(getExternalFilesDir(null), "poc_capture.pcm")
        var bytesWritten = 0L
        FileOutputStream(dumpFile).use { out ->
            while (running) {
                val record = audioRecord ?: break
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) {
                    val rms = rmsOf(buffer, read)
                    lastRms = rms
                    bufferCount++
                    Log.d(TAG, "buffer samples=$read rms=${"%.4f".format(rms)}")

                    if (bytesWritten < MAX_DUMP_BYTES) {
                        val bytes = ByteArray(read * 2)
                        for (i in 0 until read) {
                            val s = buffer[i].toInt()
                            bytes[i * 2] = (s and 0xFF).toByte()
                            bytes[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
                        }
                        out.write(bytes)
                        bytesWritten += bytes.size
                    }
                }
            }
        }
        Log.d(TAG, "readLoop stopped, wrote $bytesWritten bytes to ${dumpFile.absolutePath}")
    }

    private fun rmsOf(buffer: ShortArray, length: Int): Double {
        var sumSquares = 0.0
        for (i in 0 until length) {
            val normalized = buffer[i].toDouble() / Short.MAX_VALUE
            sumSquares += normalized * normalized
        }
        return sqrt(sumSquares / length)
    }

    override fun onDestroy() {
        running = false
        audioRecord?.stop()
        audioRecord?.release()
        mediaProjection?.stop()
        lastRms = 0.0
        super.onDestroy()
    }
}
