# 在 WSL 的 CosyVoice 环境里批量生成肥鱼训练数据。
#
#   .\run_generate.ps1 -ModelDir D:\models\FeiyuVoice-CosyVoice3 `
#       -Corpus .\corpus.sample.jsonl -Out D:\feiyu-data\pilot -Style cute -Limit 20
#
# 模型包目录里的 runtime.local.json 必须已经按模型卡填好 distribution / python / repo。
param(
    [Parameter(Mandatory = $true)][string]$ModelDir,
    [Parameter(Mandatory = $true)][string]$Corpus,
    [Parameter(Mandatory = $true)][string]$Out,
    [ValidateSet('cute', 'gentle')][string]$Style = 'cute',
    [int]$Limit = 0,
    [int]$Seed = 42,
    [switch]$Verify,
    [switch]$NoResume,
    [string]$Distro = ''
)

$ErrorActionPreference = 'Stop'

function To-WslPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -notmatch '^[A-Za-z]:[\\/]') {
        throw "本机版需要 Windows 盘符路径：$Path。模型如果已经在 WSL 里，请直接运行 generate_dataset.py。"
    }
    return '/mnt/' + $full.Substring(0, 1).ToLowerInvariant() + $full.Substring(2).Replace('\', '/')
}

$model = (Resolve-Path -LiteralPath $ModelDir).Path
$corpusFile = (Resolve-Path -LiteralPath $Corpus).Path
$outDir = [IO.Path]::GetFullPath($Out)
$runtimePath = Join-Path $model 'runtime.local.json'
if (-not (Test-Path -LiteralPath $runtimePath)) {
    throw "缺少 $runtimePath。先按模型卡把 runtime.template.json 复制成 runtime.local.json 并填好 WSL 路径。"
}
$runtime = Get-Content -LiteralPath $runtimePath -Encoding UTF8 -Raw | ConvertFrom-Json
if (-not $runtime.python -or -not $runtime.repo) {
    throw 'runtime.local.json 里 python / repo 没有填。'
}
if (-not $Distro) { $Distro = $runtime.distribution }
if (-not $Distro) { throw 'runtime.local.json 里没有 distribution，请用 -Distro 指定 WSL 发行版。' }

$script = To-WslPath (Join-Path $PSScriptRoot 'generate_dataset.py')
$wslModel = To-WslPath $model
$wslCorpus = To-WslPath $corpusFile
$wslOut = To-WslPath $outDir
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 用 bash -lc 传一整条命令：仓库路径里有空格，直接拼 argv 会被 WSL 拆开。
$envPrefix = if ($runtime.python_library_dir) { "LD_LIBRARY_PATH='$($runtime.python_library_dir)' " } else { '' }
$command = "$envPrefix'$($runtime.python)' -B '$script' --model-dir '$wslModel' --repo '$($runtime.repo)' --corpus '$wslCorpus' --out '$wslOut' --style '$Style' --seed $Seed"
if ($Limit -gt 0) { $command += " --limit $Limit" }
if ($Verify) { $command += ' --verify' }
if ($NoResume) { $command += ' --no-resume' }

Write-Host "wsl.exe -d $Distro -- bash -lc `"$command`""
& wsl.exe -d $Distro -- bash -lc $command
if ($LASTEXITCODE -ne 0) {
    throw "生成失败，退出码 $LASTEXITCODE。先确认 WSL 发行版 $Distro 能启动、runtime.local.json 的 python/repo 正确。"
}
Write-Host "输出：$outDir"
