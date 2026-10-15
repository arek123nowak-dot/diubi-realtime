package com.diubi.app

import android.content.Context

// Where to point the WebView. Configurable rather than hardcoded because
// DIUBI isn't deployed to a fixed URL yet - during development this is a
// dev machine's LAN IP (e.g. http://192.168.1.23:3000); later it'll be the
// Render deployment URL. See MainActivity's first-run prompt.
object ServerConfig {
    private const val PREFS = "diubi_prefs"
    private const val KEY_URL = "server_url"

    fun getUrl(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_URL, null)

    fun setUrl(context: Context, url: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_URL, url).apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_URL).apply()
    }
}
