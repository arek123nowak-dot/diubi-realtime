package com.diubi.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

// Thin native shell: a full-screen WebView showing the existing DIUBI web
// app (zero changes needed there beyond the small bridge in public/app.js),
// plus the native MediaProjection audio capture a browser can't do on
// Android. The web app drives everything else exactly as it already does
// on desktop - Pamietnik, Powtorka, Moja nauka, confidence warnings.
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    // Set when a share (e.g. "Udostepnij" on a YouTube video -> DIUBI) comes
    // in before the page has finished loading - diubiSetSourceUrl() isn't
    // defined yet at that point, so it's flushed from onPageFinished instead.
    private var pendingSharedText: String? = null
    private var pageLoaded = false

    // Guards against the error dialog stacking twice if onReceivedError
    // fires more than once for the same failed load (WebView does this
    // sometimes) - reset once a new attempt is actually submitted.
    private var errorDialogShowing = false

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                CaptureService.onAudioChunk = { base64 ->
                    runOnUiThread { webView.evaluateJavascript("diubiFeedAudioChunk('$base64')", null) }
                }
                val intent = Intent(this, CaptureService::class.java).apply {
                    putExtra(CaptureService.EXTRA_RESULT_CODE, result.resultCode)
                    putExtra(CaptureService.EXTRA_RESULT_DATA, result.data)
                }
                ContextCompat.startForegroundService(this, intent)
                runOnUiThread { webView.evaluateJavascript("diubiCaptureStarted()", null) }
            } else {
                runOnUiThread {
                    webView.evaluateJavascript(
                        "diubiCaptureError('Brak zgody na przechwytywanie dzwieku.')",
                        null
                    )
                }
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        webView.layoutParams =
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                pageLoaded = true
                flushPendingSharedText()
            }

            // A stale/wrong server IP (the PC's LAN IP changes often -
            // DHCP lease renewal, reconnecting to Wi-Fi...) used to leave
            // the WebView stuck on a dead browser error page with no way
            // back to the "enter server address" dialog, which only ever
            // showed on first run. Any main-frame load failure reopens it
            // instead, pre-filled with the old value to edit. Sub-resource
            // failures (an image, a font) are ignored - only the main page
            // failing means "wrong server address".
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                super.onReceivedError(view, request, error)
                if (request.isForMainFrame && !errorDialogShowing) {
                    showServerUrlDialog(error = true)
                }
            }
        }
        // Surfaces page-side console.log/console.error (and JS exceptions
        // thrown by our evaluateJavascript-injected calls) to Logcat - the
        // WebView swallows these silently otherwise. Filter Logcat on
        // "DiubiWebView" while debugging the native bridge.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(
                    "DiubiWebView",
                    "${message.message()} (${message.sourceId()}:${message.lineNumber()})"
                )
                return true
            }
        }
        webView.addJavascriptInterface(JsBridge(), "DiubiNative")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        val savedUrl = ServerConfig.getUrl(this)
        if (savedUrl != null) {
            webView.loadUrl(savedUrl)
        } else {
            showServerUrlDialog()
        }

        handleIncomingIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    // "Udostepnij" a YouTube (or Spotify) link from another app straight
    // into DIUBI, instead of having to copy-paste it into the URL field by
    // hand. See the ACTION_SEND intent-filter on this activity in the
    // manifest.
    private fun handleIncomingIntent(intent: Intent) {
        if (intent.action != Intent.ACTION_SEND || intent.type != "text/plain") return
        val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
        pendingSharedText = sharedText
        if (pageLoaded) flushPendingSharedText()
    }

    private fun flushPendingSharedText() {
        val text = pendingSharedText ?: return
        pendingSharedText = null
        // extractYouTubeId() in public/app.js searches anywhere in the
        // string, so raw share text (which often has extra words around the
        // link) works fine without trimming it down here first.
        val escaped = text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")
        webView.evaluateJavascript("diubiSetSourceUrl('$escaped')", null)
    }

    private fun showServerUrlDialog(error: Boolean = false) {
        errorDialogShowing = true
        val input = EditText(this)
        input.hint = "np. http://192.168.1.23:3000"
        input.setText(ServerConfig.getUrl(this) ?: "")
        AlertDialog.Builder(this)
            .setTitle(if (error) "Nie udalo sie polaczyc z serwerem" else "Adres serwera DIUBI")
            .setMessage(
                if (error)
                    "Sprawdz, czy serwer dziala i czy telefon jest w tej samej sieci Wi-Fi co " +
                        "komputer, a nastepnie popraw adres ponizej - zwykle zmienia sie tylko " +
                        "koncowka adresu IP."
                else
                    "Podaj adres, pod ktorym dziala serwer Node.js - lokalny adres IP " +
                        "komputera w tej samej sieci Wi-Fi podczas testow, albo adres " +
                        "wdrozenia (Render) pozniej."
            )
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("OK") { _, _ ->
                errorDialogShowing = false
                val url = input.text.toString().trim()
                if (url.isNotEmpty()) {
                    ServerConfig.setUrl(this, url)
                    webView.loadUrl(url)
                } else {
                    showServerUrlDialog()
                }
            }
            .show()
    }

    inner class JsBridge {
        @JavascriptInterface
        fun requestAudioCapture() {
            runOnUiThread {
                val projectionManager =
                    getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                projectionLauncher.launch(projectionManager.createScreenCaptureIntent())
            }
        }

        @JavascriptInterface
        fun stopAudioCapture() {
            stopService(Intent(this@MainActivity, CaptureService::class.java))
        }
    }

    override fun onDestroy() {
        stopService(Intent(this, CaptureService::class.java))
        super.onDestroy()
    }
}
