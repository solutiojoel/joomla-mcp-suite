# Gantry Builder runner
# Usage: .\run.ps1 [--plan path/to/layout-plan.json] [--context '{"parish_name":"St. Joseph"}']
param(
    [string]$plan = "..\mockup-analyzer\output\layout-plan.json",
    [string]$lib  = "..\template-indexer\template-library.json",
    [string]$context = "",
    [string]$outline  = "33"
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

pip install pyyaml --break-system-packages -q

$args_list = @("build.py", "--plan", $plan, "--lib", $lib, "--outline", $outline)
if ($context) { $args_list += @("--context", $context) }

python @args_list
