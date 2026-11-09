# A local Expo module: autolinking finds it under apps/mobile/modules/, so it survives
# `expo prebuild` regenerating ios/. The JS side is src/updates/.
Pod::Spec.new do |s|
  s.name           = 'SattleAppStoreUpdates'
  s.version        = '1.0.0'
  s.summary        = 'Says what this install is, and shows its App Store page'
  s.author         = ''
  s.homepage       = 'https://sattle.tech'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
