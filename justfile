# Native builds of the mobile app. `expo run:*` runs prebuild first if android/ or ios/
# is missing, then builds, installs and starts Metro. Pass extra flags through, e.g.
# `just android --device` or `just ios --device "My iPhone"`.

mobile := "apps/mobile"

default:
    @just --list

# Build and run on an Android emulator or connected device
android *args:
    cd {{mobile}} && npx expo run:android {{args}}

# Build and run on the iOS simulator or a connected device
ios *args:
    cd {{mobile}} && npx expo run:ios {{args}}

# Standalone install on a connected iPhone: a release build with the JS bundled in, so it
# runs without Metro, against the URLs in apps/mobile/.env. Asks which device unless one is
# named. A free Apple ID signs it for 7 days; run this again to renew.
ios-install *args:
    cd {{mobile}} && npx expo run:ios --configuration Release --no-bundler --device {{args}}

# Signed release APK + AAB into dist-android/. KEYSTORE_BASE64="$(pbpaste)" just android-release
android-release:
    scripts/android-release.sh
