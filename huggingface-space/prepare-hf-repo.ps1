param(
    [Parameter(Mandatory = $true)][string]$HfUser,
    [Parameter(Mandatory = $true)][string]$SpaceName,
    [string]$CloneParent = 'D:\Thesis'
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dest = Join-Path $CloneParent "hf-space-$SpaceName"
$repoUrl = "https://huggingface.co/spaces/$HfUser/$SpaceName"

& (Join-Path $src 'sync-from-model.ps1')

if (-not (Test-Path $dest)) {
    git clone $repoUrl $dest
} else {
    Write-Host "Using existing folder: $dest"
}

$copyNames = @(
    'Dockerfile', 'requirements.txt', 'app.py', 'README.md',
    '.dockerignore', '.gitattributes', 'cat_skin_effb0.pth', 'dog_skin_effb0.pth'
)
foreach ($name in $copyNames) {
    $from = Join-Path $src $name
    if (Test-Path $from) {
        Copy-Item $from (Join-Path $dest $name) -Force
        Write-Host "Copied $name"
    } elseif ($name -like '*.pth') {
        Write-Warning "Missing $name in huggingface-space - add from model/ before push."
    }
}

Push-Location $dest
try {
    git lfs install 2>$null
    git lfs track '*.pth' 2>$null
    git add -A
    git status
    Write-Host ''
    Write-Host 'Next (in this folder): git commit -m "Deploy skin API" ; git push'
    Write-Host 'Use your HF username and access token when Git asks for credentials.'
} finally {
    Pop-Location
}
