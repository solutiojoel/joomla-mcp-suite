# Template Indexer runner
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir
pip install pyyaml --break-system-packages -q
python index.py
