param(
    [switch]$Install = $false
)

$javaCheckCmd = "java -version 2>&1"
$keytoolPath = (Get-Command keytool -ErrorAction SilentlyContinue).Source

Write-Host "[JDK] Checking for Java/keytool installation..."

if (-not $keytoolPath) {
    Write-Host "[JDK] keytool not found in PATH"
    if (-not $Install) {
        Write-Host ""
        Write-Host "To install OpenJDK 21 (recommended), run:"
        Write-Host ""
        Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/jdk-setup.ps1 -Install"
        Write-Host ""
        Write-Host "Or install manually:"
        Write-Host "  - Microsoft Store: Search 'OpenJDK' and install Oracle's or Eclipse Temurin"
        Write-Host "  - Chocolatey: choco install openjdk"
        Write-Host "  - Direct: https://adoptium.net/ (Temurin JDK 21)"
        Write-Host ""
        Write-Host "After installation, restart PowerShell and run:"
        Write-Host "  npm run twa:signing-key"
        Write-Host ""
        exit 1
    }

    Write-Host "[JDK] Installing OpenJDK 21 via Chocolatey..."
    
    $chocoCheck = Get-Command choco -ErrorAction SilentlyContinue
    if (-not $chocoCheck) {
        Write-Host "[JDK] Chocolatey not found. Installing Chocolatey..."
        Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    }

    choco install openjdk21 -y
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    
    $keytoolPath = (Get-Command keytool -ErrorAction SilentlyContinue).Source
    if (-not $keytoolPath) {
        Write-Host "[JDK] Failed to install or locate keytool. Please install OpenJDK manually."
        exit 1
    }
}

Write-Host "[JDK] Found keytool at: $keytoolPath"
Write-Host "[JDK] Setup complete. Run 'npm run twa:signing-key' to generate signing key."
