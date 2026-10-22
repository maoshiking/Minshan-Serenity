# Precompute an elevation grid from the z=13 mosaic, then answer queries by lookup.
Add-Type -AssemblyName System.Drawing

$z = 13
$n = [math]::Pow(2, $z)
$dir = Join-Path $env:TEMP 'minshan-dem'
$TILE_X0 = 6448; $TILE_Y0 = 3354

$latN = 30.9800; $latS = 30.8850
$lonW = 103.3600; $lonE = 103.4820
$GCOLS = 400; $GROWS = 400

# load only the tiles we need into byte planes
$tiles = @{}
for ($ty = 3354; $ty -le 3356; $ty++) {
  for ($tx = 6448; $tx -le 6450; $tx++) {
    $f = Join-Path $dir "$z-$tx-$ty.png"
    if (Test-Path $f) {
      $b = [System.Drawing.Bitmap]::FromFile($f)
      $tiles["$tx,$ty"] = $b
    }
  }
}
Write-Output ("tiles loaded: " + $tiles.Count)

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
    if ($tiles.ContainsKey($key)) {
      $col = $tiles[$key].GetPixel($px, $py)
      $elev[$r * $GCOLS + $c] = (([double]$col.R * 256.0) + [double]$col.G + ([double]$col.B / 256.0)) - 32768.0
    } else {
      $elev[$r * $GCOLS + $c] = -32768.0
    }
  }
}
foreach ($b in $tiles.Values) { $b.Dispose() }
Write-Output ("grid " + $GCOLS + "x" + $GROWS + " ready")

# lookup helpers
function SampleGrid([double]$lat, [double]$lon) {
  $cf = ($lon - $lonW) / ($lonE - $lonW) * ($GCOLS - 1)
  $rf = ($latN - $lat) / ($latN - $latS) * ($GROWS - 1)
  $ci = [int][math]::Round($cf); $ri = [int][math]::Round($rf)
  if ($ci -lt 0) { $ci = 0 }; if ($ci -ge $GCOLS) { $ci = $GCOLS - 1 }
  if ($ri -lt 0) { $ri = 0 }; if ($ri -ge $GROWS) { $ri = $GROWS - 1 }
  $script:lastVal = $elev[$ri * $GCOLS + $ci]
}

$camLat = 30.9355114; $camLon = 103.42176301
SampleGrid $camLat $camLon
$camGround = $script:lastVal
Write-Output ""
Write-Output ("camera point " + $camLat + " , " + $camLon)
Write-Output ("DEM ground elevation there = {0:N0} m" -f $camGround)
Write-Output ("link altitude field       = 914.73 m")
Write-Output ""
Write-Output "--- height profile forward along heading 41.295 deg ---"
$mPerLat = 111132.0
$mPerLon = 111320.0 * [math]::Cos($camLat * [math]::PI / 180.0)
$rad = 41.29527285 * [math]::PI / 180.0
Write-Output "  dist(m)   elev(m)   aboveCam(m)"
$d = 0.0
while ($d -le 3600.0) {
  $la = $camLat + ($d * [math]::Cos($rad)) / $mPerLat
  $lo = $camLon + ($d * [math]::Sin($rad)) / $mPerLon
  SampleGrid $la $lo
  $h = $script:lastVal
  Write-Output ("  {0,7:N0}   {1,7:N0}   {2,9:N0}" -f $d, $h, ($h - $camGround))
  $d += 300.0
}
Write-Output ""
Write-Output "--- max elevation within 3 km, 8 directions ---"
$azs = @(0, 45, 90, 135, 180, 225, 270, 315)
$names = @('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')
for ($i = 0; $i -lt 8; $i++) {
  $r2 = $azs[$i] * [math]::PI / 180.0
  $best = -99999.0; $bd = 0.0
  $dd = 100.0
  while ($dd -le 3000.0) {
    $la = $camLat + ($dd * [math]::Cos($r2)) / $mPerLat
    $lo = $camLon + ($dd * [math]::Sin($r2)) / $mPerLon
    SampleGrid $la $lo
    $hh = $script:lastVal
    if ($hh -gt $best) { $best = $hh; $bd = $dd }
    $dd += 50.0
  }
  Write-Output ("  {0,-3} max {1,6:N0} m at {2,5:N0} m   aboveCam {3,5:N0} m" -f $names[$i], $best, $bd, ($best - $camGround))
}
Write-Output ""
Write-Output "--- reference points ---"
$refs = @(
  @{n = 'old street';  lat = 30.930634; lon = 103.420881 },
  @{n = 'quad centroid'; lat = 30.932271; lon = 103.420888 },
  @{n = 'OSM middle school'; lat = 30.932928; lon = 103.415403 }
)
foreach ($p in $refs) {
  SampleGrid $p.lat $p.lon
  Write-Output ("  {0,-20} {1,6:N0} m" -f $p.n, $script:lastVal)
}
