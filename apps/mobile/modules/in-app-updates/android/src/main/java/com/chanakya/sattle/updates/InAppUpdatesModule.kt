package com.chanakya.sattle.updates

import android.app.Activity
import android.content.Context
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val EVENT = "onInstallState"
private const val PREFS = "sattle.updates"
private const val KEY_DECLINED = "declinedVersionCode"

/**
 * Google Play in-app updates. This only reports what Play says and starts what it's
 * told to; when to ask, and how, is decided in src/updates/updater.ts.
 *
 * Play only answers for a copy it installed. In a sideloaded APK or a debug build,
 * check() rejects and the app carries on with no update prompts.
 */
class InAppUpdatesModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val manager: AppUpdateManager by lazy { AppUpdateManagerFactory.create(context) }
  private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

  private val listener = InstallStateUpdatedListener { state ->
    sendEvent(
      EVENT,
      mapOf(
        "status" to statusName(state.installStatus()),
        // Doubles: a download can pass what a JS-bound Int holds.
        "bytesDownloaded" to state.bytesDownloaded().toDouble(),
        "totalBytes" to state.totalBytesToDownload().toDouble()
      )
    )
  }

  override fun definition() = ModuleDefinition {
    Name("SattleInAppUpdates")

    Events(EVENT)

    OnStartObserving { manager.registerListener(listener) }
    OnStopObserving { manager.unregisterListener(listener) }
    // A JS reload tears the module down without JS ever dropping its listener.
    OnDestroy { runCatching { manager.unregisterListener(listener) } }

    // Play's callbacks run on the main thread, outside Expo's error handling, so anything
    // that can throw (the context, the prefs) is read before they are attached.
    AsyncFunction("check") { promise: Promise ->
      val declined = prefs.getInt(KEY_DECLINED, -1)
      manager.appUpdateInfo
        .addOnSuccessListener { info -> promise.resolve(describe(info, declined)) }
        .addOnFailureListener { e -> promise.reject("ERR_UPDATE_CHECK", e.message, e) }
    }

    // Flexible: Play asks, then downloads while the app stays open; install() finishes it.
    // Immediate: Play takes over the screen, installs and restarts the app itself.
    // Starting an immediate update that is already under way resumes it.
    AsyncFunction("start") { immediate: Boolean, promise: Promise ->
      val type = if (immediate) AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
      val store = prefs
      manager.appUpdateInfo
        .addOnSuccessListener { info ->
          // startUpdateFlow starts an activity, which can throw. Out here that would crash
          // the app, so it becomes a rejection instead.
          try {
            // Looked up now, not before Play answered: the screen may have closed since.
            val activity = appContext.currentActivity
            if (activity == null || activity.isFinishing || activity.isDestroyed) {
              promise.reject(Exceptions.MissingActivity())
              return@addOnSuccessListener
            }
            manager.startUpdateFlow(info, activity, AppUpdateOptions.newBuilder(type).build())
              .addOnSuccessListener { result ->
                if (result == Activity.RESULT_CANCELED && !immediate) {
                  // Remembered across launches, so the same version isn't pushed twice.
                  store.edit().putInt(KEY_DECLINED, info.availableVersionCode()).apply()
                }
                promise.resolve(
                  when (result) {
                    Activity.RESULT_OK -> "accepted"
                    Activity.RESULT_CANCELED -> "declined"
                    else -> "failed"
                  }
                )
              }
              .addOnFailureListener { e -> promise.reject("ERR_UPDATE_START", e.message, e) }
          } catch (e: Exception) {
            promise.reject("ERR_UPDATE_START", e.message, e)
          }
        }
        .addOnFailureListener { e -> promise.reject("ERR_UPDATE_CHECK", e.message, e) }
    }

    // Installs a downloaded flexible update. Play restarts the app.
    AsyncFunction("install") { promise: Promise ->
      manager.completeUpdate()
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { e -> promise.reject("ERR_UPDATE_INSTALL", e.message, e) }
    }
  }

  private fun describe(info: AppUpdateInfo, declined: Int): Map<String, Any?> = mapOf(
    "availability" to when (info.updateAvailability()) {
      UpdateAvailability.UPDATE_AVAILABLE -> "available"
      UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS -> "in_progress"
      else -> "none"
    },
    "status" to statusName(info.installStatus()),
    "versionCode" to info.availableVersionCode(),
    "priority" to info.updatePriority(),
    "flexibleAllowed" to info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE),
    "immediateAllowed" to info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE),
    "declined" to (declined == info.availableVersionCode())
  )

  private fun statusName(status: Int): String = when (status) {
    InstallStatus.PENDING -> "pending"
    InstallStatus.DOWNLOADING -> "downloading"
    InstallStatus.DOWNLOADED -> "downloaded"
    InstallStatus.INSTALLING -> "installing"
    InstallStatus.INSTALLED -> "installed"
    InstallStatus.FAILED -> "failed"
    InstallStatus.CANCELED -> "canceled"
    else -> "unknown"
  }
}
