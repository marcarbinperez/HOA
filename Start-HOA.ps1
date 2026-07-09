param(
  [int]$Port = 4173,
  [switch]$NoBrowser
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$MimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg" = "image/svg+xml; charset=utf-8"
}

function Send-Response {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$Status,
    [string]$StatusText,
    [byte[]]$Body,
    [string]$ContentType
  )

  $Header = "HTTP/1.1 $Status $StatusText`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nConnection: close`r`n`r`n"
  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  $Stream.Write($Body, 0, $Body.Length)
}

$Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$Listener.Start()

function Get-BrowserPath {
  $Candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )

  foreach ($Candidate in $Candidates) {
    if ($Candidate -and [System.IO.File]::Exists($Candidate)) {
      return $Candidate
    }
  }

  $Commands = @("msedge.exe", "chrome.exe")
  foreach ($Command in $Commands) {
    $Resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if ($Resolved) {
      return $Resolved.Source
    }
  }

  return $null
}

function Open-HoaBrowser {
  param([string]$Url)

  $BrowserPath = Get-BrowserPath
  if ($BrowserPath) {
    Start-Process -FilePath $BrowserPath -ArgumentList @(
      "--app=$Url",
      "--start-maximized",
      "--new-window"
    )
    return
  }

  Start-Process $Url
}

$AppUrl = "http://localhost:$Port/"
Write-Host "Gentree Villas HOA Management running at $AppUrl"
Write-Host "Press Ctrl+C to stop the server."

if (-not $NoBrowser) {
  Open-HoaBrowser -Url $AppUrl
}

try {
  while ($true) {
    $Client = $Listener.AcceptTcpClient()
    try {
      $Stream = $Client.GetStream()
      $Reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $RequestLine = $Reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($RequestLine)) {
        $Client.Close()
        continue
      }

      while (($Line = $Reader.ReadLine()) -ne $null -and $Line -ne "") {}

      $Parts = $RequestLine.Split(" ")
      $RequestPath = if ($Parts.Length -gt 1) { $Parts[1] } else { "/" }
      $RequestPath = $RequestPath.Split("?")[0]
      $RequestPath = [System.Uri]::UnescapeDataString($RequestPath)
      if ($RequestPath -eq "/") {
        $RequestPath = "/index.html"
      }

      $RelativePath = $RequestPath.TrimStart("/") -replace "/", [System.IO.Path]::DirectorySeparatorChar
      $FilePath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $RelativePath))

      if (-not $FilePath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.File]::Exists($FilePath)) {
        $Body = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        Send-Response -Stream $Stream -Status 404 -StatusText "Not Found" -Body $Body -ContentType "text/plain; charset=utf-8"
      } else {
        $Bytes = [System.IO.File]::ReadAllBytes($FilePath)
        $Extension = [System.IO.Path]::GetExtension($FilePath)
        $ContentType = if ($MimeTypes.ContainsKey($Extension)) { $MimeTypes[$Extension] } else { "application/octet-stream" }
        Send-Response -Stream $Stream -Status 200 -StatusText "OK" -Body $Bytes -ContentType $ContentType
      }
    } finally {
      $Client.Close()
    }
  }
} finally {
  $Listener.Stop()
}
