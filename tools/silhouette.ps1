# Full 360 horizon silhouette from the camera point supplied in the Google Earth link.
Add-Type -AssemblyName System.Drawing

$z = 13
$n = [math]::Pow(2, $z)
$dir = Join-Path $env:TEMP 'minshan-dem'
$TILE_X0 = 6448; $TILE_Y0 = 3354
$latN = 30.9800; $latS = 30.8850
$lonW = 103.3600; $lonE = 103.4820
$GCOLS = 500; $GROWS = 500

$tiles = @{}
for ($ty = 3354; $ty -le 3356; $ty++) {
  for ($tx = 6448; $tx -le 6450; $tx++) {
    $f = Join-Path $dir "$z-$tx-$ty.png"
    if (Test-Path $f) { $tiles["$tx,$ty"] = [System.Drawing.Bitmap]::FromFile($f) }
  }
}

$elev = New-Object 'double[]' ($GCOLS * $GROWS)
for ($r = 0; $r -lt $GROWS; $r++) {
  $lat = $latN - ($latN - $latS) * ($r / [double]($GROWS - 1))
  $lr = $lat * [math]::PI / 180.0
  $t = [math]::Tan($lr) + 1.0 / [math]::Cos($lr)
  $gy = [int][math]::Floor((((1.0 - [math]::Log($t) / [math]::PI) / 2.0 * $n) - $TILE_Y0) * 256.0)
  $ty = [int][math]::Floor($gy / 256.0) + $TILE_Y0
  $py = $gy % 256
  for ($c = 0; $c -lt $GCOLS; $c++) {
    $lon = $lonW + ($lonE - $lonW) * ($c / [double]($GCOLS - 1))
    $gx = [int][math]::Floor(((($lon + 180.0) / 360.0 * $n) - $TILE_X0) * 256.0)
    $tx = [int][math]::Floor($gx / 256.0) + $TILE_X0
    $px = $gx % 256
    $key = "$tx,$ty"
    $v = -32768.0
    if ($tiles.ContainsKey($key)) {
      $col = $tiles[$key].GetPixel($px, $py)
      $v = (([double]$col.R * 256.0) + [double]$col.G + ([double]$col.B / 256.0)) - 32768.0
    }
    $elev[$r * $GCOLS + $c] = $v
  }
}
foreach ($b in $tiles.Values) { $b.Dispose() }

function PeekAt([double]$lat, [double]$lon) {
  $cf = ($lon - $lonW) / ($lonE - $lonW) * ($GCOLS - 1)
  $rf = ($latN - $lat) / ($latN - $latS) * ($GROWS - 1)
  $ci = [int][math]::Round($cf); $ri = [int][math]::Round($rf)
  if ($ci -lt 0) { $ci = 0 }; if ($ci -ge $GCOLS) { $ci = $GCOLS - 1 }
  if ($ri -lt 0) { $ri = 0 }; if ($ri -ge $GROWS) { $ri = $GROWS - 1 }
  $script:lastVal = $elev[$ri * $GCOLS + $ci]
}

$camLat = 30.9355114; $camLon = 103.42176301
PeekAt $camLat $camLon
$base = $script:lastVal
Write-Output ("camera ground elevation {0:N0} m   (link altitude field 914.73 m)" -f $base)
Write-Output ""

$mPerLat = 111132.0
$mPerLon = 111320.0 * [math]::Cos($camLat * [math]::PI / 180.0)
$eye = $base + 2.0   # eye height 2 m above ground for a realistic on-foot horizon

$ang = New-Object 'double[]' 360
$pkElev = New-Object 'double[]' 360
$pkDist = New-Object 'double[]' 360
for ($az = 0; $az -lt 360; $az++) {
  $r = $az * [math]::PI / 180.0
  $best = -90.0; $be = 0.0; $bd = 0.0
  $d = 30.0
  while ($d -le 6000.0) {
    $la = $camLat + ($d * [math]::Cos($r)) / $mPerLat
    $lo = $camLon + ($d * [math]::Sin($r)) / $mPerLon
    PeekAt $la $lo
    $h = $script:lastVal
    if ($h -gt -30000) {
      $a = [math]::Atan2(($h - $eye), $d) * 180.0 / [math]::PI
      if ($a -gt $best) { $best = $a; $be = $h; $bd = $d }
    }
    $d += 25.0
  }
  $ang[$az] = $best; $pkElev[$az] = $be; $pkDist[$az] = $bd
}

$minA = ($ang | Measure-Object -Minimum).Minimum
$maxA = ($ang | Measure-Object -Maximum).Maximum
Write-Output ("horizon angle range {0:N1} deg .. {1:N1} deg" -f $minA, $maxA)
Write-Output ""

$COLS = 90; $ROWS = 13
$grid2 = @()
for ($r = 0; $r -lt $ROWS; $r++) {
  $row = New-Object 'char[]' $COLS
  for ($c = 0; $c -lt $COLS; $c++) { $row[$c] = ' ' }
  $grid2 += , $row
}
for ($c = 0; $c -lt $COLS; $c++) {
  $az = [int]($c * 360.0 / $COLS)
  $a = $ang[$az]
  $t = 1.0
  if ($maxA -gt $minA) { $t = ($a - $minA) / ($maxA - $minA) }
  $rows = [int][math]::Round($t * ($ROWS - 1))
  if ($rows -lt 0) { $rows = 0 }
  for ($r = ($ROWS - 1); $r -ge ($ROWS - 1 - $rows); $r--) { $grid2[$r][$c] = '#' }
}
Write-Output "skyline silhouette as seen from the camera point (360 deg, 4 deg per column):"
$rule = '   +' + ('-' * $COLS) + '+'
Write-Output $rule
for ($r = 0; $r -lt $ROWS; $r++) {
  Write-Output ('   |' + (-join $grid2[$r]) + '|')
}
Write-Output $rule
$lbl = ''
for ($c = 0; $c -lt $COLS; $c++) {
  $az = [int]($c * 360.0 / $COLS)
  if ($az % 45 -eq 0) {
    $nm = @('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')[[int]($az / 45)]
    $lbl += ('<' + $nm)
    $c++
  } else {
    $lbl += ' '
  }
}
Write-Output ('    ' + $lbl)
Write-Output ""
Write-Output "--- peaks at cardinal and intercardinal azimuths ---"
$azs = @(0, 45, 90, 135, 180, 225, 270, 315)
$names = @('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')
for ($i = 0; $i -lt 8; $i++) {
  $a2 = $azs[$i]
  Write-Output ("  {0,-3} angle {1,6:N2} deg   peak {2,5:N0} m   dist {3,5:N0} m   rise {4,5:N0} m" -f `
      $names[$i], $ang[$a2], $pkElev[$a2], $pkDist[$a2], ($pkElev[$a2] - $base))
}
Write-Output ""
Write-Output "--- the heading in your link (41.3 deg) ---"
Write-Output ("  angle {0:N2} deg   peak {1:N0} m   dist {2:N0} m   rise {3:N0} m" -f `
    $ang[41], $pkElev[41], $pkDist[41], ($pkElev[41] - $base))