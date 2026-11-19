Pod::Spec.new do |s|
  s.name         = 'Toast'
  s.version      = '1.0.0'
  s.source_files = 'Sources/Toast/**/*.swift'
  s.dependency 'SnapKit', '~> 5.0'

  s.test_spec 'Tests' do |test_spec|
    test_spec.source_files = 'Tests/**/*.swift'
  end
end
