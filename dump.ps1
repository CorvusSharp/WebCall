# dump.ps1
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

function Ensure-Git {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git not found in PATH."
    }
}
function Get-RepoRoot {
    $root = (git rev-parse --show-toplevel 2>$null)
    if (-not $root) { throw "Not a git repository. Run from inside the repo." }
    return (Resolve-Path $root).Path
}
function New-TempName([string]$prefix) {
    Join-Path $env:TEMP "$prefix$([guid]::NewGuid().ToString('N'))"
}

Ensure-Git
$ROOT = Get-RepoRoot
Push-Location $ROOT

# Выходной файл
$Dump = Join-Path $ROOT 'dump.txt'
if (Test-Path $Dump) { Remove-Item $Dump -Force }

# 1) Собираем список файлов, уважающий .gitignore
$TmpListRaw = New-TempName "flist_raw_"
git ls-files --cached --others --exclude-standard | Out-File -FilePath $TmpListRaw -Encoding UTF8

# 2) Доп. исключения
$excludePatterns = @(
    '^dist/', '^build/', '^\.eggs/',
    '^__pycache__/', '^\.venv/', '(^|/)\.env($|\.|/)',
    '^\.(python-version)$',
    '^\.mypy_cache/', '^\.pytest_cache/', '^\.ruff_cache/',
    '(^|/)\.coverage$', '(^|/)coverage\.xml$',
    '^htmlcov/', '^\.cache/', '^\.tox/', '^\.benchmarks/',
    '\.mp3$', '\.pyc$', '\.pyo$',
    '(^|/)dump\.bat$', '(^|/)dump\.ps1$' # исключаем сами скрипты
)

$include = New-Object System.Collections.Generic.List[string]
Get-Content -LiteralPath $TmpListRaw | ForEach-Object {
    $p = $_.Trim(); if (-not $p) { return }
    $norm = $p -replace '\\', '/'
    foreach ($rx in $excludePatterns) { if ($norm -match $rx) { return } }
    $include.Add($p)
}
Remove-Item $TmpListRaw -Force

# 3) Пишем заголовок + ДЕРЕВО (один раз)
"Project root: $ROOT" | Set-Content -Path $Dump -Encoding UTF8
""                        | Add-Content -Path $Dump -Encoding UTF8
"===== DIRECTORY TREE (filtered) =====" | Add-Content -Path $Dump -Encoding UTF8

$dirs = $include | ForEach-Object { Split-Path $_ -Parent } | Where-Object { $_ -ne '' } | Sort-Object -Unique
"./" | Add-Content -Path $Dump -Encoding UTF8
foreach ($d in $dirs) {
    $depth = ($d -split '[\\/]').Count
    $indent = '  ' * $depth
    $indent + $d | Add-Content -Path $Dump -Encoding UTF8
}
"" | Add-Content -Path $Dump -Encoding UTF8

# 4) Для каждой записи — путь, размер, содержимое
$utf8NoThrow = New-Object System.Text.UTF8Encoding($false, $false) # без исключений на некорректные байты

foreach ($rel in $include) {
    $src = Join-Path $ROOT $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }

    "===== BEGIN FILE: $src =====" | Add-Content -Path $Dump -Encoding UTF8
    $size = (Get-Item -LiteralPath $src).Length
    "--- SIZE: $size bytes ---"    | Add-Content -Path $Dump -Encoding UTF8
    ""                              | Add-Content -Path $Dump -Encoding UTF8

    try {
        # Читаем байты и преобразуем к UTF-8 с заменой некорректных последовательностей — Notepad откроет без кракозябр-крашей.
        $bytes = [System.IO.File]::ReadAllBytes($src)
        $text = $utf8NoThrow.GetString($bytes)
        [System.IO.File]::AppendAllText($Dump, $text, (New-Object System.Text.UTF8Encoding($true)))
    }
    catch {
        # Фолбэк: хотя бы пометить файл
        "(unreadable content)" | Add-Content -Path $Dump -Encoding UTF8
    }

    "" | Add-Content -Path $Dump -Encoding UTF8
    "===== END FILE: $src =====" | Add-Content -Path $Dump -Encoding UTF8
    "" | Add-Content -Path $Dump -Encoding UTF8
}

Pop-Location
Write-Host "Ready: $Dump"
