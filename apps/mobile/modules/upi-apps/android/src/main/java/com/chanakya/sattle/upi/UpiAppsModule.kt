package com.chanakya.sattle.upi

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.util.Base64
import androidx.core.graphics.drawable.toBitmap
import androidx.core.net.toUri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream

private const val REQUEST_CODE = 7101
/** Drawn at this size, which is twice what the row shows, so it stays sharp on a dense screen. */
private const val ICON_PX = 96

class NoUpiAppException(packageName: String?) : CodedException(
  "ERR_NO_UPI_APP",
  if (packageName == null) "No UPI app on this phone can open this." else "That app isn't on this phone any more.",
  null
)

class PaymentOpenException : CodedException("ERR_UPI_PAYMENT_OPEN", "A UPI app is already open for a payment.", null)

/**
 * The UPI apps on the phone, and three things to do with one: aim a upi://pay
 * link at it and hear what it says when it closes, or open it plain for a
 * payment made by hand. Which of those an app gets is decided in JS
 * (src/upi/upiApps.ts); this only asks Android and does what it's told.
 *
 * What an app hands back is that app's word, on the payer's own phone. JS
 * reads it with parseUpiResponse and treats anything short of SUCCESS as
 * nothing.
 */
class UpiAppsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("SattleUpiApps")

    // Every app that can open `uri`, once each, with the name and icon its launcher entry has.
    AsyncFunction("list") { uri: String ->
      val pm = context.packageManager
      val intent = Intent(Intent.ACTION_VIEW, uri.toUri())
      // Only what startActivity itself would pick from: an activity has to take any VIEW by default.
      val found = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()))
      } else {
        @Suppress("DEPRECATION")
        pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
      }
      found
        .map { it.activityInfo.applicationInfo }
        .filter { it.packageName != context.packageName }
        .distinctBy { it.packageName }
        .map { app ->
          mapOf(
            "packageName" to app.packageName,
            "name" to pm.getApplicationLabel(app).toString(),
            "icon" to iconDataUrl(pm, app)
          )
        }
        .sortedBy { (it["name"] as String).lowercase() }
    }

    // Opens `uri` in the app named, or in whichever the phone picks when none is, and resolves
    // when that app closes with its result code and whatever extras it set.
    AsyncFunction("pay") { uri: String, packageName: String?, promise: Promise ->
      if (pending != null) throw PaymentOpenException()
      val intent = Intent(Intent.ACTION_VIEW, uri.toUri())
      packageName?.let { intent.setPackage(it) }
      try {
        appContext.throwingActivity.startActivityForResult(intent, REQUEST_CODE)
        pending = promise
      } catch (e: ActivityNotFoundException) {
        promise.reject(NoUpiAppException(packageName))
      }
    }

    // The app's home screen, as its launcher icon opens it.
    Function("open") { packageName: String ->
      val launch = context.packageManager.getLaunchIntentForPackage(packageName) ?: throw NoUpiAppException(packageName)
      appContext.throwingActivity.startActivity(launch)
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_CODE) return@OnActivityResult
      val result = Bundle().apply {
        putInt("resultCode", payload.resultCode)
        payload.data?.extras?.let { putBundle("extra", it) }
      }
      pending?.resolve(result)
      pending = null
    }
  }

  /** The icon as a PNG data URL, or null when Android can't draw it: the row then shows the name alone. */
  private fun iconDataUrl(pm: PackageManager, app: ApplicationInfo): String? = runCatching {
    val out = ByteArrayOutputStream()
    pm.getApplicationIcon(app).toBitmap(ICON_PX, ICON_PX).compress(Bitmap.CompressFormat.PNG, 100, out)
    "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }.getOrNull()
}
