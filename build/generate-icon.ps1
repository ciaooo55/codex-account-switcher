Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.Color]::Transparent)

$shape = [Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(18, 18, 44, 44, 180, 90)
$shape.AddArc(194, 18, 44, 44, 270, 90)
$shape.AddArc(194, 194, 44, 44, 0, 90)
$shape.AddArc(18, 194, 44, 44, 90, 90)
$shape.CloseFigure()
$graphics.FillPath([Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 22, 27, 32)), $shape)
$graphics.DrawPath([Drawing.Pen]::new([Drawing.Color]::FromArgb(255, 65, 76, 86), 4), $shape)

$blue = [Drawing.Pen]::new([Drawing.Color]::FromArgb(255, 86, 189, 232), 18)
$blue.StartCap = [Drawing.Drawing2D.LineCap]::Round
$blue.EndCap = [Drawing.Drawing2D.LineCap]::Round
$green = [Drawing.Pen]::new([Drawing.Color]::FromArgb(255, 73, 200, 117), 18)
$green.StartCap = [Drawing.Drawing2D.LineCap]::Round
$green.EndCap = [Drawing.Drawing2D.LineCap]::Round

$graphics.DrawLine($blue, 58, 87, 188, 87)
$graphics.DrawLine($blue, 188, 87, 159, 58)
$graphics.DrawLine($blue, 188, 87, 159, 116)
$graphics.DrawLine($green, 198, 169, 68, 169)
$graphics.DrawLine($green, 68, 169, 97, 140)
$graphics.DrawLine($green, 68, 169, 97, 198)

$pngPath = Join-Path $PSScriptRoot 'icon.png'
$icoPath = Join-Path $PSScriptRoot 'icon.ico'
$bitmap.Save($pngPath, [Drawing.Imaging.ImageFormat]::Png)
$icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [IO.File]::Open($icoPath, [IO.FileMode]::Create)
try {
  $icon.Save($stream)
} finally {
  $stream.Dispose()
  $icon.Dispose()
  $blue.Dispose()
  $green.Dispose()
  $shape.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
