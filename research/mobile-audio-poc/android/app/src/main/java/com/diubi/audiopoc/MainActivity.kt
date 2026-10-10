package com.diubi.audiopoc

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView

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
                statusText.text = "Capture service started - switch to Spotify/YouTube now.\n" +
                    "Check logs: adb logcat -s DIUBI_POC"
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
}
