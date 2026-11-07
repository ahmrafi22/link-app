/**
 * Expo config plugin: registers a silent Android share target.
 *
 * expo-share-intent opens the main app when you share — by design. We instead
 * want "share -> saved -> stay in the sender app", so we ship our own invisible
 * trampoline activity:
 *
 *   - ReceiverActivity uses @android:style/Theme.NoDisplay, noHistory and an
 *     empty taskAffinity. It receives ACTION_SEND (text/*), appends the payload
 *     to files/linkvault/inbox.jsonl, shows a toast, and finishes immediately.
 *     The sender app never leaves the screen.
 *   - The JS side (src/lib/inbox.ts) drains inbox.jsonl via expo-file-system
 *     when the app is opened / foregrounded.
 *
 * Both the Kotlin source file and the manifest entry are injected at prebuild
 * time, which keeps `android/` disposable (gitignored, regenerated in CI).
 */
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const ACTIVITY_CLASS = "ReceiverActivity";

function receiverActivitySource(pkg) {
  return `package ${pkg}

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import java.io.File
import org.json.JSONObject

/**
 * Invisible share target. Receives ACTION_SEND, queues the payload into the
 * inbox file and finishes instantly so the sender app never loses focus.
 * The main app parses and dedupes the entries when it drains the inbox.
 */
class ${ACTIVITY_CLASS} : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handle(intent)
    finish()
  }

  private fun handle(intent: Intent?) {
    if (intent == null || intent.action != Intent.ACTION_SEND) return
    val type = intent.type ?: return
    if (!type.startsWith("text/")) {
      toast("Link Vault saves links and text only")
      return
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
    if (text.isNullOrBlank() && title.isNullOrBlank() && subject.isNullOrBlank()) {
      toast("Nothing to save")
      return
    }

    val entry = JSONObject()
    try {
      entry.put("text", text ?: "")
      entry.put("subject", subject ?: "")
      entry.put("title", title ?: "")
      entry.put("receivedAt", System.currentTimeMillis())
      synchronized(LOCK) {
        val dir = File(filesDir, "linkvault")
        dir.mkdirs()
        File(dir, "inbox.jsonl").appendText(entry.toString() + "\\n")
      }
      toast("Saved to Link Vault")
    } catch (e: Exception) {
      toast("Link Vault could not save this")
    }
  }

  private fun toast(message: String) {
    Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
  }

  companion object {
    private val LOCK = Any()
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
      fs.writeFileSync(path.join(dir, `${ACTIVITY_CLASS}.kt`), receiverActivitySource(pkg));
      return cfg;
    },
  ]);

  config = withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) throw new Error("with-android-share-target: no <application> in manifest");
    const pkg = cfg.android?.package;
    if (!pkg) throw new Error("with-android-share-target: android.package is not set");

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
