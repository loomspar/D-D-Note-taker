#!/usr/bin/env ruby
# Rebuilds Ramble.xcodeproj from the files on disk.
# Run from the repository root after adding or removing Swift files:
#   gem install xcodeproj && ruby scripts/generate_project.rb
require 'xcodeproj'

DEPLOYMENT = '26.0'
BUNDLE_ID = 'com.loomspar.ramble'

project = Xcodeproj::Project.new('Ramble.xcodeproj')
app = project.new_target(:application, 'Ramble', :ios, DEPLOYMENT)
widget = project.new_target(:app_extension, 'RambleWidget', :ios, DEPLOYMENT)

def add_sources(group, dir, targets)
  Dir.children(dir).sort.each do |name|
    path = File.join(dir, name)
    if File.directory?(path) && !name.end_with?('.xcassets')
      add_sources(group.new_group(name, name), path, targets)
    elsif name.end_with?('.swift')
      ref = group.new_file(name)
      targets.each { |t| t.add_file_references([ref]) }
    elsif name.end_with?('.xcassets')
      ref = group.new_file(name)
      targets.each { |t| t.add_resources([ref]) }
    else
      group.new_file(name) # plists and entitlements: visible in Xcode, not compiled
    end
  end
end

add_sources(project.main_group.new_group('Ramble', 'Ramble'), 'Ramble', [app])
add_sources(project.main_group.new_group('Shared', 'Shared'), 'Shared', [app, widget])
add_sources(project.main_group.new_group('RambleWidget', 'RambleWidget'), 'RambleWidget', [widget])

# Swift links system frameworks automatically; drop the SDK-version-specific reference.
[app, widget].each { |t| t.frameworks_build_phase.clear }
project.frameworks_group.clear

app.add_dependency(widget)
embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
embed.add_file_reference(widget.product_reference).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

common = {
  'SWIFT_VERSION' => '5.0',
  'IPHONEOS_DEPLOYMENT_TARGET' => DEPLOYMENT,
  'TARGETED_DEVICE_FAMILY' => '1',
  'CODE_SIGN_STYLE' => 'Automatic',
  'MARKETING_VERSION' => '1.0',
  'CURRENT_PROJECT_VERSION' => '1',
  'GENERATE_INFOPLIST_FILE' => 'YES',
  'INFOPLIST_KEY_CFBundleDisplayName' => 'Ramble',
}

app.build_configurations.each do |config|
  config.build_settings.merge!(common).merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => BUNDLE_ID,
    'INFOPLIST_FILE' => 'Ramble/Resources/Info.plist',
    'CODE_SIGN_ENTITLEMENTS' => 'Ramble/Resources/Ramble.entitlements',
    'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
    'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME' => 'AccentColor',
    'INFOPLIST_KEY_UILaunchScreen_Generation' => 'YES',
    'INFOPLIST_KEY_UISupportedInterfaceOrientations' => 'UIInterfaceOrientationPortrait',
    'INFOPLIST_KEY_NSMicrophoneUsageDescription' => 'Ramble records your voice so it can turn your brainstorm into notes.',
    'INFOPLIST_KEY_NSSpeechRecognitionUsageDescription' => 'Ramble transcribes your recording on this iPhone to write your notes.',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks'],
    'ENABLE_PREVIEWS' => 'YES'
  )
end

widget.build_configurations.each do |config|
  config.build_settings.merge!(common).merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => "#{BUNDLE_ID}.widget",
    'INFOPLIST_FILE' => 'RambleWidget/Info.plist',
    'CODE_SIGN_ENTITLEMENTS' => 'RambleWidget/RambleWidget.entitlements',
    'SKIP_INSTALL' => 'YES',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  )
end

project.save
puts "Wrote Ramble.xcodeproj (#{app.source_build_phase.files.count} app sources, #{widget.source_build_phase.files.count} widget sources)"
