package com.diubi.audiopoc

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var polling = false

    // Threshold above which we call it "real audio detected" rather than
    // background noise floor/silence - purely for the on-screen label,
    // tune if your phone's mic/capture floor differs.
    private val audioDetectedThreshold = 0.01

    private val pollRunnable = object : Runnable {
        override fun run() {
            val rms = CaptureService.lastRms
            val count = CaptureService.bufferCount
            val label = if (rms > audioDetectedThreshold) "DZWIEK WYKRYTY" else "cisza / brak sygnalu"
            statusText.text = "Status: $label\n" +
                "RMS: ${"%.4f".format(rms)}\n" +
                "Odebrane bufory: $count\n\n" +
                "Odtworz cos glosno w Spotify/YouTube -\n" +
                "RMS powinno wzrosnac ponad $audioDetectedThreshold"
            if (polling) handler.postDelayed(this, 300)
        }
    }

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                val intent = Intent(this, CaptureService::class.java).apply {
                    putExtra(CaptureService.EXTRA_RESULT_CODE, result.resultCode)
                    putExtra(CaptureService.EXTRA_RESULT_DATA, result.data)
                }
                ContextCompat.startForegroundService(this, intent)
                polling = true
                handler.post(pollRunnable)
            } else {
                statusText.text = "Projection permission denied."
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        val startButton = findViewById<Button>(R.id.startButton)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        startButton.setOnClickListener {
            val projectionManager = getSystemService(MediaProjectionManager::class.java)
            projectionLauncher.launch(projectionManager.createScreenCaptureIntent())
        }
    }

    override fun onDestroy() {
        polling = false
        handler.removeCallbacks(pollRunnable)
        super.onDestroy()
    }
}
