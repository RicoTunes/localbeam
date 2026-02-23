@echo off
:: Run this file as Administrator if the app can't open firewall ports automatically
:: Right-click -> "Run as administrator"

echo Opening Windows Firewall for Wireless File Transfer...
echo.

netsh advfirewall firewall delete rule name="WirelessTransfer-5001" >nul 2>&1
netsh advfirewall firewall delete rule name="WirelessTransfer-5002" >nul 2>&1

netsh advfirewall firewall add rule name="WirelessTransfer-5001" dir=in action=allow protocol=TCP localport=5001 profile=any enable=yes
netsh advfirewall firewall add rule name="WirelessTransfer-5002" dir=in action=allow protocol=TCP localport=5002 profile=any enable=yes

echo.
echo Done! Ports 5001 and 5002 are now open on your firewall.
echo Your phone can now connect over Wi-Fi.
echo.
pause
