# PDF의 각 쪽을 그림으로 만든 뒤 Windows 내장 글자 인식(OCR, 한국어)으로 읽는다.
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File pdf-ocr.ps1 <pdf경로>
# 출력: JSON {pages:[{w,h,words:[{t,x,y,w,h}]}]}  (외부 프로그램 설치 불필요)
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

$ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asTaskAct = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAction($op) { $t = $asTaskAct.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }

$lang = New-Object Windows.Globalization.Language 'ko'
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if ($null -eq $engine) { throw 'Windows 한국어 글자 인식 기능을 찾지 못했어요.' }
$maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Path).Path)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$pages = @()
for ($i = 0; $i -lt [Math]::Min($doc.PageCount, 30); $i++) {
  $page = $doc.GetPage($i)
  $scale = [Math]::Min(4.0, ($maxDim - 10) / [Math]::Max($page.Size.Width, $page.Size.Height))
  $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $opt.DestinationWidth = [uint32]($page.Size.Width * $scale)
  $opt.DestinationHeight = [uint32]($page.Size.Height * $scale)
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($page.RenderToStreamAsync($stream, $opt))
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $words = @()
  foreach ($line in $res.Lines) {
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      $words += [pscustomobject]@{ t = $w.Text; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
    }
  }
  $pages += [pscustomobject]@{ w = $bmp.PixelWidth; h = $bmp.PixelHeight; words = $words }
  $bmp.Dispose(); $stream.Dispose(); $page.Dispose()
}
[pscustomobject]@{ pages = $pages } | ConvertTo-Json -Depth 5 -Compress
