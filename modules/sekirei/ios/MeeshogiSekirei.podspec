require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'MeeshogiSekirei'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = { :type => 'MIT OR Apache-2.0', :file => '../../../native/sekirei/NOTICE' }
  s.author           = 'meeshogi contributors'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,swift}'
  s.public_header_files = 'MeeshogiSekirei.h'
  s.vendored_frameworks = '../../../native/target/ios/MeeshogiSekireiCore.xcframework'
  s.resource_bundles = {
    'MeeshogiSekireiAssets' => ['../../../assets/model/c-leaf-wrm-seed42.bin']
  }
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
