$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$moduleRoot = Join-Path $projectRoot 'modules/foundry/bardforge-receiver'
$manifest = Get-Content -LiteralPath (Join-Path $moduleRoot 'module.json') -Raw | ConvertFrom-Json
if ($manifest.id -ne 'bardforge-receiver' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected module identity/version' }
if ($manifest.compatibility.minimum -ne '13' -or $manifest.compatibility.PSObject.Properties.Name -contains 'verified') { throw 'Unexpected compatibility claim' }
$files = @('module.json', 'scripts/client.js', 'scripts/client.d.ts', 'scripts/module.js', 'styles/receiver.css', 'lang/en.json', 'lang/ru.json')
$distRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
if (-not $distRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid output path' }
New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
$archivePath = Join-Path $distRoot ("bardforge-receiver-" + $manifest.version + '.zip')
$archive = [IO.Compression.ZipArchive]::new([IO.File]::Open($archivePath, [IO.FileMode]::Create), [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($relative in $files) {
    $source = Join-Path $moduleRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing file: $relative" }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, ('bardforge-receiver/' + $relative), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $projectRoot 'README.md'), 'bardforge-receiver/README.md', [IO.Compression.CompressionLevel]::Optimal) | Out-Null
} finally { $archive.Dispose() }

$check = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $expected = @($files | ForEach-Object { 'bardforge-receiver/' + $_ }) + @('bardforge-receiver/README.md')
  if (@(Compare-Object ($expected | Sort-Object) ($check.Entries.FullName | Sort-Object)).Count -ne 0) { throw 'ZIP contents differ from public allowlist' }
  $reader = [IO.StreamReader]::new($check.GetEntry('bardforge-receiver/module.json').Open())
  try { $packedManifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  if ($packedManifest.id -ne $manifest.id -or $packedManifest.version -ne $manifest.version) { throw 'ZIP manifest mismatch' }
} finally { $check.Dispose() }
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
$hashInput = [IO.File]::OpenRead($archivePath)
try { $hash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashInput)).Replace('-', '').ToLowerInvariant() }
finally { $hashInput.Dispose(); $hashAlgorithm.Dispose() }
Write-Output ('PASS: ' + [IO.Path]::GetFileName($archivePath) + ', ' + $expected.Count + ' allowed entries, SHA256 ' + $hash)
