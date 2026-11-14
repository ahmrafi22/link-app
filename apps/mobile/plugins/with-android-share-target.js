/**
 * Expo config plugin: registers a silent Android share target.
 *
 * expo-share-intent opens the main app when you share — by design. We instead
 * want "share -> saved -> stay in the sender app", so we ship our own invisible
 * trampoline activity:
 *
 *   - ReceiverActivity uses @android:style/Theme.NoDisplay, noHistory and an
 *     empty taskAffinity. It receives ACTION_SEND (text/*) and finishes
 *     instantly — the sender app never leaves the screen.
 *   - Phase "background capture": when APP_SECRET is baked in at prebuild
 *     (CI secret), the receiver POSTs the capture straight to the API from a
 *     background thread, so enrichment + AI run on the server seconds after
 *     the share — with the app closed. It still writes the inbox file FIRST
 *     and deletes the entry only on a successful POST, so a killed process or
 *     offline share is never lost (the app drains + uploads it later; the
 *     server dedupes the double-capture).
 *   - When no APP_SECRET was baked in, it behaves exactly like before: queue
 *     offline, process on next app open.
 *   - The JS side (src/lib/inbox.ts) drains inbox.jsonl when the app opens.
 *
 * Both the Kotlin source and the manifest entry are injected at prebuild.
 */
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const ACTIVITY_CLASS = "ReceiverActivity";

function receiverActivitySource(pkg, apiBaseUrl, appSecret) {
  return `package ${pkg}

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONObject

/**
 * Invisible share target. Queue-then-post: the payload is appended to the
 * inbox file synchronously, then (if the API config was baked in at prebuild)
 * a background thread POSTs it to /api/captures and removes the queue entry
 * on success. The activity finishes immediately either way — the sender app
 * never loses focus, and no resources are used once the POST completes.
 */
class ${ACTIVITY_CLASS} : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val payload = collect(intent)
    if (payload == null) {
      showToast("Nothing to save")
      finish()
      return
    }
    queueOffline(payload)
    if (API_URL.isBlank() || APP_SECRET.isBlank()) {
      showToast("Saved to Link Vault")
      finish()
      return
    }

    showToast("Saving to Link Vault...")
    val pendingCapture = payload
    Thread {
      val posted = postToServer(pendingCapture)
      if (posted) {
        removeFromQueue(pendingCapture)
        showToastOnUiThread("Saved to Link Vault")
      } else {
        // queue entry stays — the app drains + uploads it on next open;
        // the server dedupes the second capture
        showToastOnUiThread("Saved to Link Vault (offline)")
      }
    }.start()
    finish()
  }

  private fun collect(intent: Intent?): JSONObject? {
    if (intent == null || intent.action != Intent.ACTION_SEND) return null
    val type = intent.type ?: return null
    if (!type.startsWith("text/")) {
      showToast("Link Vault saves links and text only")
      return null
    }

    var text = intent.getStringExtra(Intent.EXTRA_TEXT)
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
    val title = intent.getStringExtra(Intent.EXTRA_TITLE)
    if (text.isNullOrBlank() && title.isNullOrBlank() && subject.isNullOrBlank()) {
      // some apps put the URL only in ClipData
      val clip = intent.clipData
      if (clip != null && clip.itemCount > 0) {
        text = clip.getItemAt(0).coerceToText(this)?.toString()
      }
    }
    if (text.isNullOrBlank() && title.isNullOrBlank() && subject.isNullOrBlank()) return null

    val payload = JSONObject()
    payload.put("receivedAt", System.currentTimeMillis())
    payload.put("text", text ?: "")
    payload.put("subject", subject ?: "")
    payload.put("title", title ?: "")

    // first http(s) token becomes the capture URL; the rest is the caption
    val words = (text ?: "").split(' ', '\\n', '\\t', '\\r').map { it.trim() }.filter { it.isNotEmpty() }
    val url = words.firstOrNull { it.startsWith("http://") || it.startsWith("https://") }
    if (url != null) {
      payload.put("url", url)
      val caption = words.filter { it != url }.joinToString(" ").trim()
      if (caption.isNotEmpty()) payload.put("caption", caption)
    }
    return payload
  }

  /** Synchronous, before anything else — a share is never lost. */
  private fun queueOffline(payload: JSONObject) {
    try {
      synchronized(LOCK) {
        val dir = File(filesDir, "linkvault")
        dir.mkdirs()
        File(dir, "inbox.jsonl").appendText(payload.toString() + "\\n")
      }
    } catch (e: Exception) {
      // if even the queue fails there is nothing to recover
    }
  }

  /** Remove the entry after a successful POST so the app does not re-drain it. */
  private fun removeFromQueue(payload: JSONObject) {
    try {
      synchronized(LOCK) {
        val file = File(File(filesDir, "linkvault"), "inbox.jsonl")
        if (!file.exists()) return
        val kept = file.readLines().filter { it.isNotBlank() && it != payload.toString() }
        file.writeText(kept.joinToString("\\n") + (if (kept.isEmpty()) "" else "\\n"))
      }
    } catch (e: Exception) {
      // worst case the app drains it again; the server dedupes
    }
  }

  private fun postToServer(payload: JSONObject): Boolean {
    var conn: HttpURLConnection? = null
    return try {
      val body = JSONObject()
      val url = payload.optString("url", "")
      if (url.isNotBlank()) body.put("url", url)
      val caption = payload.optString("caption", "")
      val legacyText = payload.optString("text", "")
      if (caption.isNotBlank()) body.put("text", caption)
      else if (legacyText.isNotBlank() && legacyText != url) body.put("text", legacyText)
      val title = payload.optString("title", "")
      if (title.isNotBlank()) body.put("title", title)
      val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
      fmt.timeZone = TimeZone.getTimeZone("UTC")
      body.put("capturedAt", fmt.format(Date(payload.optLong("receivedAt", System.currentTimeMillis()))))

      conn = URL(API_URL + "/api/captures").openConnection() as HttpURLConnection
      conn.requestMethod = "POST"
      conn.setRequestProperty("Authorization", "Bearer " + APP_SECRET)
      conn.setRequestProperty("Content-Type", "application/json")
      conn.connectTimeout = 6000
      conn.readTimeout = 6000
      conn.doOutput = true
      conn.outputStream.use { it.write(body.toString().toByteArray("UTF-8")) }
      val code = conn.responseCode
      code in 200..299
    } catch (e: Exception) {
      false
    } finally {
      conn?.disconnect()
    }
  }

  private fun showToast(message: String) {
    Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
  }

  private fun showToastOnUiThread(message: String) {
    runOnUiThread { showToast(message) }
  }

  companion object {
    private val LOCK = Any()
    private const val API_URL = "${apiBaseUrl}"
    private const val APP_SECRET = "${appSecret}"
  }
}
`;
}

function withShareTarget(config) {
  config = withDangerousMod(config, [
    "android",
    (cfg) => {
      const pkg = cfg.android?.package;
      if (!pkg) throw new Error("with-android-share-target: android.package is not set");
      const apiBaseUrl = cfg.extra?.api?.baseUrl ?? "";
      const appSecret = process.env.APP_SECRET ?? "";
      if (!appSecret) {
        console.log(
          "with-android-share-target: no APP_SECRET env at prebuild — receiver will queue offline only"
        );
      }
      const dir = path.join(
        cfg.modRequest.projectRoot,
        "android",
        "app",
        "src",
        "main",
        "java",
        ...pkg.split(".")
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${ACTIVITY_CLASS}.kt`),
        receiverActivitySource(pkg, apiBaseUrl, appSecret)
      );
      return cfg;
    },
  ]);

  config = withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) throw new Error("with-android-share-target: no <application> in manifest");
    const pkg = cfg.android?.package;

    const activities = (application.activity ??= []);
    const name = `${pkg}.${ACTIVITY_CLASS}`;
    const kept = activities.filter((a) => a?.$?.["android:name"] !== name);
    kept.push({
      $: {
        "android:name": name,
        "android:label": "Link Vault",
        "android:exported": "true",
        "android:theme": "@android:style/Theme.NoDisplay",
        "android:noHistory": "true",
        "android:excludeFromRecents": "true",
        "android:taskAffinity": "",
      },
      "intent-filter": [
        {
          action: [{ $: { "android:name": "android.intent.action.SEND" } }],
          category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
          data: [{ $: { "android:mimeType": "text/*" } }],
        },
      ],
    });
    application.activity = kept;
    return cfg;
  });

  return config;
}

module.exports = withShareTarget;
