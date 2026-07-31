# 生成 Reasonix Browser Bridge 图标（System.Drawing 矢量渲染）
# 用法: powershell -ExecutionPolicy Bypass -File make-icon.ps1
Add-Type -AssemblyName System.Drawing

$outDir = "D:\makemoneyreasonix\edge-extension\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundedRectPath($x, $y, $w, $h, $r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

$c1 = [System.Drawing.Color]::FromArgb(255, 82, 173, 247)   # 亮蓝
$c2 = [System.Drawing.Color]::FromArgb(255, 25, 88, 171)    # 深蓝
$cHi = [System.Drawing.Color]::FromArgb(70, 255, 255, 255)  # 高光

foreach ($size in @(16, 32, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    # 圆角背景（渐变）
    $radius = [Math]::Max(2, [int]($size * 0.22))
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $bgPath = New-RoundedRectPath 0 0 $size $size $radius
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)
    $g.FillPath($grad, $bgPath)

    # 白色 "R"（矢量字体）
    $fontSize = [Single]($size * 0.60)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object System.Drawing.RectangleF(0, ($size * 0.02), $size, $size)
    $g.DrawString("R", $font, [System.Drawing.Brushes]::White, $textRect, $sf)

    $g.Dispose()
    $path = Join-Path $outDir "icon$size.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "生成: $path"
}
Write-Host "完成"
