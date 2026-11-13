$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Construindo o Drocsid + Instalador Windows (Setup.exe)  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Garante que cargo e o linker UCRT64 (se presente) estejam no PATH
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}
if (Test-Path "C:\msys64\ucrt64\bin") {
    $env:PATH = "C:\msys64\ucrt64\bin;$env:PATH"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "O compilador Rust (cargo) não foi encontrado. Instale com: winget install Rustlang.Rustup"
}

Write-Host "[1/3] Compilando binário nativo em Rust (cargo build --release)..." -ForegroundColor Yellow
cargo build --release

$releaseExe = Join-Path $PSScriptRoot "target\release\drocsid.exe"
if (-not (Test-Path $releaseExe)) {
    throw "O binário $releaseExe não foi encontrado após o build."
}

Write-Host "[2/3] Compactando payload nativo (drocsid.exe -> payload.gz)..." -ForegroundColor Yellow
$payloadGz = Join-Path $PSScriptRoot "installer\payload.gz"
$inBytes = [System.IO.File]::ReadAllBytes($releaseExe)
$outStream = New-Object System.IO.FileStream($payloadGz, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$gzipStream = New-Object System.IO.Compression.GZipStream($outStream, [System.IO.Compression.CompressionLevel]::Optimal)
$gzipStream.Write($inBytes, 0, $inBytes.Length)
$gzipStream.Close()
$outStream.Close()

Write-Host "[3/3] Gerando ícone e instalador gráfico standalone (dist\Drocsid-Setup.exe)..." -ForegroundColor Yellow
$distDir = Join-Path $PSScriptRoot "dist"
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# Gera ícone nativo Drocsid.ico (64x64 32bpp DIB compatível com Win32/csc)
Add-Type -AssemblyName System.Drawing
$icoPath = Join-Path $PSScriptRoot "installer\drocsid.ico"
$bmp = New-Object System.Drawing.Bitmap 64, 64, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 88, 101, 242))
$gp = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 16
$gp.AddArc(0, 0, $r, $r, 180, 90)
$gp.AddArc(63 - $r, 0, $r, $r, 270, 90)
$gp.AddArc(63 - $r, 63 - $r, $r, $r, 0, 90)
$gp.AddArc(0, 63 - $r, $r, $r, 90, 90)
$gp.CloseFigure()
$g.FillPath($bgBrush, $gp)
$font = New-Object System.Drawing.Font "Segoe UI", 34, ([System.Drawing.FontStyle]::Bold)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("D", $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 2, 64, 62), $sf)
$g.Dispose()
$font.Dispose()
$sf.Dispose()
$bgBrush.Dispose()
$gp.Dispose()

$icoFs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$bw = New-Object System.IO.BinaryWriter($icoFs)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]1)
$bw.Write([byte]64)
$bw.Write([byte]64)
$bw.Write([byte]0)
$bw.Write([byte]0)
$bw.Write([uint16]1)
$bw.Write([uint16]32)
$bw.Write([uint32](40 + 64 * 64 * 4 + 512))
$bw.Write([uint32]22)
$bw.Write([uint32]40)
$bw.Write([int32]64)
$bw.Write([int32]128)
$bw.Write([uint16]1)
$bw.Write([uint16]32)
$bw.Write([uint32]0)
$bw.Write([uint32](64 * 64 * 4))
$bw.Write([int32]0)
$bw.Write([int32]0)
$bw.Write([uint32]0)
$bw.Write([uint32]0)
for ($py = 63; $py -ge 0; $py--) {
    for ($px = 0; $px -lt 64; $px++) {
        $c = $bmp.GetPixel($px, $py)
        $bw.Write([byte]$c.B)
        $bw.Write([byte]$c.G)
        $bw.Write([byte]$c.R)
        $bw.Write([byte]$c.A)
    }
}
$bw.Write((New-Object byte[] 512))
$bw.Close()
$icoFs.Close()
$bmp.Dispose()

$cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $cscPath)) {
    $cscPath = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}

$setupExe = Join-Path $distDir "Drocsid-Setup.exe"
$csFile = Join-Path $PSScriptRoot "installer\DrocsidSetup.cs"

& $cscPath /nologo /target:winexe /optimize+ `
    /win32icon:"$icoPath" `
    /out:"$setupExe" `
    /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
    /resource:"$payloadGz,Drocsid.exe.gz" `
    /resource:"$icoPath,Drocsid.ico" `
    "$csFile"

Remove-Item $payloadGz -Force -ErrorAction SilentlyContinue
Remove-Item $icoPath -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  SUCESSO! Instalador pronto em:" -ForegroundColor Green
Write-Host "  $setupExe" -ForegroundColor White
Write-Host "  Envie o arquivo 'Drocsid-Setup.exe' para seus amigos!" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
