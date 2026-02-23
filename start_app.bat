@echo off
echo Starting Wireless File Transfer Server...
echo.
echo Press Ctrl+C to stop the server
echo.
python app.py --port 5000 --directory uploads --open-browser
pause