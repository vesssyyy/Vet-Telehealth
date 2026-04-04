$ErrorActionPreference = 'Stop'
$model = Join-Path (Split-Path $PSScriptRoot -Parent) 'model'
Copy-Item (Join-Path $model 'app.py') (Join-Path $PSScriptRoot 'app.py') -Force
foreach ($f in @('cat_skin_effb0.pth', 'dog_skin_effb0.pth')) {
    $src = Join-Path $model $f
    if (Test-Path $src) {
        Copy-Item $src $PSScriptRoot -Force
        Write-Host "Copied $f"
    } else {
        Write-Warning "Missing $src - add checkpoints to huggingface-space before pushing."
    }
}
Write-Host 'Sync finished.'
